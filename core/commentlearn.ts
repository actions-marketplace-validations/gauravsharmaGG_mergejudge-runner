import { defang, fingerprint } from "./falsealarm.js";

/**
 * Learning from review comments (`learning.from_comments`). Pure helpers shared by the Worker (harvest, storage) and the
 * review core (prompt block, rubric proposals). Everything here treats the comment text as untrusted data from a person:
 * it is flattened, defanged and capped before it is stored, shown to a model or quoted in a proposal.
 */

export const COMMENT_EXCERPT_MAX = 200;
/** A human comment counts as "on a line MergeJudge did not flag" when no MergeJudge inline comment on the same file is within this many lines. */
export const FLAGGED_LINE_WINDOW = 3;
/** Two missed items are "similar" (one group) at or above this token-set Jaccard similarity. */
export const MISSED_GROUP_JACCARD = 0.5;
export const MISSED_PROMPT_MAX = 5;
export const MISSED_PROMPT_CHARS = 150;

/** One stored review comment, reduced to what learning needs. `actor` is a salted per-repo hash, never a login. */
export interface MissedItem {
  pr: number;
  actor: string;
  text: string;
  fingerprint: string;
  url?: string | null;
  path?: string | null;
  at?: string | null;
}

/** Excerpt of a comment as stored: one line, no links, mentions, fences or HTML, capped. "" when nothing is left. */
export const commentExcerpt = (body: string): string => defang(String(body ?? ""), COMMENT_EXCERPT_MAX);

/** Normalised-token key of an excerpt; "" when there is too little signal to learn from. */
export const commentFingerprint = (excerpt: string): string => fingerprint(excerpt);

/** True when a MergeJudge inline comment on `path` sits within FLAGGED_LINE_WINDOW lines of `line` (a missing line counts as "near" any flagged line of the file). */
export function nearFlagged(path: string, line: number | null | undefined, flagged: readonly { path: string; line: number | null | undefined }[]): boolean {
  return flagged.some((f) => f.path === path && (line == null || f.line == null || Math.abs(f.line - line) <= FLAGGED_LINE_WINDOW));
}

function jaccard(a: string[], b: string[]): number {
  const sb = new Set(b);
  let inter = 0;
  for (const x of a) if (sb.has(x)) inter++;
  return inter / (a.length + b.length - inter || 1);
}

export interface MissedGroup { items: MissedItem[]; prs: number[]; actors: string[] }

/**
 * Deterministic grouping, no model: items are taken in (pr, fingerprint) order and join the first group whose first item
 * has the same fingerprint or a token-set Jaccard similarity >= MISSED_GROUP_JACCARD. Returns every group (callers apply thresholds).
 */
export function groupMissed(items: readonly MissedItem[]): MissedGroup[] {
  const ordered = items.filter((i) => i.fingerprint).sort((a, b) => a.pr - b.pr || a.fingerprint.localeCompare(b.fingerprint) || a.actor.localeCompare(b.actor));
  const groups: { seed: string[]; items: MissedItem[] }[] = [];
  for (const it of ordered) {
    const toks = it.fingerprint.split(" ");
    const g = groups.find((x) => jaccard(x.seed, toks) >= MISSED_GROUP_JACCARD);
    if (g) g.items.push(it);
    else groups.push({ seed: toks, items: [it] });
  }
  return groups.map((g) => ({
    items: g.items,
    prs: [...new Set(g.items.map((i) => i.pr))].sort((a, b) => a - b),
    actors: [...new Set(g.items.map((i) => i.actor))].sort(),
  }));
}

/**
 * Text that tries to relax a check or approve something. Such a group never becomes a criterion. Plain tightening
 * wording ("don't use X here", "should not mutate the input", "avoid ...", "nit: ...") is not listed on purpose.
 */
export const RELAXING_RE = /\b(ignor\w*|skip\w*|allow\w*|permit\w*|bypass\w*|disabl\w*|turn(?:ed|ing)? off|exempt\w*|whitelist\w*|allowlist\w*|relax\w*|approv\w*|lgtm|(?:is|are|looks?|seems?|it['’]?s|that['’]?s)\s+(?:fine|ok(?:ay)?)|(?:fine|ok(?:ay)?)\s+(?:to|as is|here)|no need|not needed|unnecessary|safe to|acceptable|not (?:a|an) (?:bug|issue|problem)|can be (?:removed|dropped)|(?:never|(?:do(?:n['’]?t| not)|dont))\s+(?:flag|fail|block|worry|bother)|trust\w*|auto[- ]?merg\w*)\b/i;

/** Security or secret wording. Any comment that touches it is refused, whether it relaxes a check or not. */
export const SECURITY_RE = /(secret|credential|token|passw|api[ _-]?key|private[ _-]?key|\bauth|permission|csrf|\bxss\b|inject|sanitiz|escap|encrypt|crypto|\btls\b|\bssl\b|certificate|cookie|session|oauth|\bjwt\b|vulnerab|exploit|secur|\bcve\b|\bsql\b|\brce\b|sandbox|exfil|leak)/i;

/** The first reason an item's text may not become a criterion, or null. */
export function refuseReason(text: string): "relaxing" | "security" | null {
  if (SECURITY_RE.test(text)) return "security";
  return RELAXING_RE.test(text) ? "relaxing" : null;
}

/** Defanged, delimiter-free, capped lines "Things reviewers here caught", newest first. Input order is kept when `at` is missing. */
export function missedPromptItems(items: readonly Pick<MissedItem, "text" | "at">[], delim: string): string[] {
  const out: string[] = [];
  const sorted = [...items].sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
  const re = new RegExp(delim, "gi");
  for (const i of sorted) {
    const t = defang(String(i.text ?? "").replace(re, ""), MISSED_PROMPT_CHARS);
    if (!t || out.includes(t)) continue;
    out.push(t);
    if (out.length >= MISSED_PROMPT_MAX) break;
  }
  return out;
}
