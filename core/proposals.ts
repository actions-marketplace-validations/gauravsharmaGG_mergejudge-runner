import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml";
import { minimatch } from "minimatch";
import { commentFingerprint, groupMissed, refuseReason, type MissedItem } from "./commentlearn.js";
import { DEFAULT_PROTECTED, learnsFromComments, parseConfig, type Config } from "./config.js";
import { defang } from "./falsealarm.js";
import { fetchRepoFile, type Octokit, type Repo } from "./github.js";
import type { Lesson } from "./learning.js";
import { DEFAULT_PACKS, NOTE_ID_RE } from "./rubrics.js";
import { assertProposalFilePath } from "./writes.js";

/**
 * Learning proposals that edit files. Deterministic, no LLM: evidence -> a few fixed kinds of text patch on the
 * reviewed repo's `.mergejudge.yml`, opened as a PR for a human. Nothing here can make MergeJudge less strict:
 * `guardConfigEdit` re-parses the result and refuses anything but "more protected paths" and "more prompt notes".
 */

export const CONFIG_PATH = ".mergejudge.yml";
export const PROPOSAL_LABELS = [
  { name: "do-not-merge", color: "b60205", description: "MergeJudge: a human must decide" },
  { name: "needs-human", color: "d93f0b", description: "MergeJudge: needs a human review" },
];

/** Extra evidence the Worker reads from D1 (the Action has none). All fields are untrusted data and are validated here. */
export interface ExtraEvidence {
  /** `lane` (the bot's lane then) and `actorKind` (human | agent | bot | unknown; absent = human) exist from migration 0013 on. */
  outcomes?: { pr: number; kind: string; criteria: string[]; paths: string[]; actor: string | null; refPr: number | null; lane?: string | null; actorKind?: string | null }[];
  dismissed?: { pr: number; actor: string | null; text: string }[];
  /** Review comments by writers on lines MergeJudge did not flag (`learning.from_comments`). `actor` is a salted hash, never a login. Used only when that switch is on. */
  missed?: MissedItem[];
}

export class ProposalGuardError extends Error {
  constructor(m: string) { super(m); this.name = "ProposalGuardError"; }
}

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const login = (s: string | null | undefined): string | null => (s && LOGIN_RE.test(s) ? s : null);

export interface StrictSuggestion { id: string; prs: number[]; actors: string[]; ups: number; downs: number; mergedOver: number; dismissed: number }
export interface LenientSuggestion { glob: string; events: { pr: number; kind: string }[]; paths: string[] }
export interface Suggestions { strict: StrictSuggestion[]; lenient: LenientSuggestion[]; skipped: string[] }

const MAX_EDITS_EACH = 3;
/** Criteria whose notes may never be softened by learning: secrets and anything that can raise to block. */
const SENSITIVE_ID = /^sec[._-]|secret|credential|token|password|private.?key/i;

const GLOB_SAFE = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/;
/** Directory glob for a changed path (`a/b/c.ts` -> `a/b/**`); a root file stays an exact path. Null when unsafe to write into yaml. */
export function globFor(path: string): string | null {
  if (!GLOB_SAFE.test(path) || path.length > 100 || path.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  const i = path.lastIndexOf("/");
  const g = i < 0 ? path : `${path.slice(0, i)}/**`;
  return /^\.github(\/|$)/.test(g) ? null : g;
}

export function knownCriterionIds(cfg: Config): Set<string> {
  return new Set([...Object.values(DEFAULT_PACKS).flatMap((p) => p.criteria.map((c) => c.id)), ...cfg.rubrics.custom.map((c) => c.id)]);
}

interface Counted {
  /** Per criterion: the PRs, people and votes behind a "too strict" suggestion. */
  acc: Map<string, { prs: Set<number>; actors: Set<string>; ups: Set<number>; downs: number; mergedOver: number; dismissed: number }>;
  /** Per directory glob: the reverts / fix follow-ups of auto PRs and the paths they touched. */
  byGlob: Map<string, { events: Map<string, { pr: number; kind: string }>; paths: Set<string> }>;
}

/** The one place evidence is counted. `collectSuggestions` and `proposalProgress` both read it, so they cannot drift apart. */
function countEvidence(lessons: Lesson[], extra: ExtraEvidence, cfg: Config): Counted {
  const known = knownCriterionIds(cfg);
  const acc: Counted["acc"] = new Map();
  const get = (id: string) => {
    let a = acc.get(id);
    if (!a) { a = { prs: new Set(), actors: new Set(), ups: new Set(), downs: 0, mergedOver: 0, dismissed: 0 }; acc.set(id, a); }
    return a;
  };
  const down = (id: string, pr: number, by: string | null, what: "downs" | "mergedOver" | "dismissed") => {
    if (!known.has(id) || !Number.isInteger(pr)) return;
    const a = get(id);
    a.prs.add(pr); a[what]++;
    const l = login(by);
    if (l) a.actors.add(l);
  };
  for (const l of lessons) {
    if (!Number.isInteger(l.pr)) continue;
    for (const [id, v] of Object.entries(l.rubric_votes ?? {})) {
      if (v === "down") down(id, l.pr, l.by, "downs");
      else if (known.has(id)) get(id).ups.add(l.pr);
    }
    const failed = Array.isArray(l.failed_criteria) ? l.failed_criteria : [];
    // "Too strict" names no criterion; it only counts when exactly one criterion failed and it was not voted on.
    if (l.feedback?.includes("too_strict") && failed.length === 1 && !(failed[0]! in (l.rubric_votes ?? {}))) down(failed[0]!, l.pr, l.by, "downs");
  }
  for (const o of extra.outcomes ?? []) {
    // Softening evidence is human-only: an agent's, a bot's or an unknown actor's merge is never "a person accepted this".
    if (o.actorKind && o.actorKind !== "human") continue;
    if (o.kind === "merged_over_lane") for (const id of o.criteria) down(id, o.pr, o.actor, "mergedOver");
  }
  for (const d of extra.dismissed ?? []) {
    const text = String(d.text ?? "").toLowerCase();
    for (const id of known) if (text.includes(id.toLowerCase())) down(id, d.pr, d.actor, "dismissed");
  }
  const byGlob: Counted["byGlob"] = new Map();
  for (const o of extra.outcomes ?? []) {
    // Tightening evidence, from any actor: a revert or fix of a PR the bot let through on the auto lane (rows with no lane do not
    // count), or a human hold label above the bot's lane. Reverts and fixes of review/block PRs are recorded but not used here yet.
    // TODO(learning v3, plan G4): label_looser would count as "too strict" evidence for rubric notes (docs/LEARNING.md); unused for now.
    const tightens = ((o.kind === "reverted" || o.kind === "followup_fix") && o.lane === "auto") || o.kind === "label_stricter";
    if (!tightens) continue;
    for (const p of o.paths) {
      const g = globFor(p);
      if (!g) continue;
      let e = byGlob.get(g);
      if (!e) { e = { events: new Map(), paths: new Set() }; byGlob.set(g, e); }
      e.events.set(`${o.kind}#${o.pr}`, { pr: o.pr, kind: o.kind });
      e.paths.add(p);
    }
  }
  return { acc, byGlob };
}

type StrictAcc = Counted["acc"] extends Map<string, infer A> ? A : never;
const strictMeets = (a: StrictAcc, t: Config["learning"]["proposal"]) => a.prs.size >= t.min_prs && a.actors.size >= t.min_actors;
const alreadyProtected = (paths: Iterable<string>, cfg: Config) => [...paths].every((p) => cfg.lanes.protected.some((g) => minimatch(p, g, { dot: true })));

/** Apply the thresholds to lessons and extra evidence. Below a threshold nothing is suggested. */
export function collectSuggestions(lessons: Lesson[], extra: ExtraEvidence, cfg: Config): Suggestions {
  const t = cfg.learning.proposal;
  const skipped: string[] = [];
  const { acc, byGlob } = countEvidence(lessons, extra, cfg);
  const strict: StrictSuggestion[] = [];
  for (const [id, a] of [...acc].sort((x, y) => y[1].prs.size - x[1].prs.size || x[0].localeCompare(y[0]))) {
    if (!strictMeets(a, t)) continue;
    if (a.ups.size * 2 >= a.prs.size) { skipped.push(`\`${id}\`: people also said it was right on ${a.ups.size} PR(s)`); continue; }
    strict.push({ id, prs: [...a.prs].sort((x, y) => x - y), actors: [...a.actors].sort(), ups: a.ups.size, downs: a.downs, mergedOver: a.mergedOver, dismissed: a.dismissed });
  }
  const lenient: LenientSuggestion[] = [];
  for (const [glob, e] of [...byGlob].sort((x, y) => y[1].events.size - x[1].events.size || x[0].localeCompare(y[0]))) {
    if (e.events.size < t.min_path_events) continue;
    if (alreadyProtected(e.paths, cfg)) continue;
    lenient.push({ glob, events: [...e.events.values()].sort((x, y) => x.pr - y.pr), paths: [...e.paths].sort().slice(0, 5) });
  }
  return { strict: strict.slice(0, MAX_EDITS_EACH), lenient: lenient.slice(0, MAX_EDITS_EACH), skipped };
}

export interface ProposalProgress {
  /** Criteria people called too strict. `ready`: a rubric note would be suggested at the next run. Counts only, no logins. */
  rubricNotes: { criterion: string; prs: number; minPrs: number; actors: number; minActors: number; ready: boolean }[];
  /** Directories with reverts or quick fixes of auto PRs. */
  paths: { glob: string; events: number; minEvents: number; ready: boolean }[];
}

/**
 * How close the evidence is to a suggestion, for the panel. Same counting and thresholds as `collectSuggestions`, but only
 * for what a proposal could really change: security / block criteria (never softened), criteria that already have a note
 * and directories that are already protected are left out. Pure: no writes, no GitHub, no logins in the result.
 */
export function proposalProgress(lessons: Lesson[], extra: ExtraEvidence, cfg: Config): ProposalProgress {
  const t = cfg.learning.proposal;
  const { acc, byGlob } = countEvidence(lessons, extra, cfg);
  const rubricNotes: ProposalProgress["rubricNotes"] = [];
  for (const [id, a] of [...acc].sort((x, y) => y[1].prs.size - x[1].prs.size || x[0].localeCompare(y[0]))) {
    const custom = cfg.rubrics.custom.find((c) => c.id === id);
    if (SENSITIVE_ID.test(id) || custom?.raise_to === "block" || cfg.rubrics.notes[id] || custom?.note) continue;
    if (!a.prs.size) continue;
    rubricNotes.push({ criterion: id, prs: a.prs.size, minPrs: t.min_prs, actors: a.actors.size, minActors: t.min_actors, ready: strictMeets(a, t) && a.ups.size * 2 < a.prs.size });
  }
  const paths: ProposalProgress["paths"] = [];
  for (const [glob, e] of [...byGlob].sort((x, y) => y[1].events.size - x[1].events.size || x[0].localeCompare(y[0]))) {
    if (alreadyProtected(e.paths, cfg)) continue;
    paths.push({ glob, events: e.events.size, minEvents: t.min_path_events, ready: e.events.size >= t.min_path_events });
  }
  return { rubricNotes, paths };
}

/** The fixed note a "too strict" proposal adds. No free text from people goes in. */
export function strictNote(s: StrictSuggestion): string {
  return `People marked this check as a false alarm on ${s.prs.length} PRs. Fail it only with a concrete defect quoted from the changed lines; style or taste alone is not a failure.`;
}

// ---- criteria learned from review comments (learning.from_comments) --------------------------------------------

/** Every learned criterion id starts with this and ends in 8 hex digits of the group's fingerprint. */
export const LEARNED_ID_PREFIX = "learned-";
export const LEARNED_ID_RE = /^learned-[a-f0-9]{8}$/;
/** Most criteria one proposal may add, and the schema's cap on `rubrics.custom`. */
export const MAX_LEARNED_CRITERIA = 3;
export const MAX_CUSTOM_CRITERIA = 20;
const EXCERPT_MAX = 100;
const ACTOR_HASH_RE = /^[a-f0-9]{16,64}$/;
const COMMENT_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+#discussion_r\d+$/;

/** The fixed wording of a learned criterion's question; only the short excerpt varies. */
export const learnedQuestion = (excerpt: string) => `Reviewers on this repository raised a similar point on several pull requests: '${excerpt}'. Does the change avoid this problem?`;
const LEARNED_QUESTION_RE = /^Reviewers on this repository raised a similar point on several pull requests: '[^"\\\n]{1,120}'\. Does the change avoid this problem\?$/;

const fnv8 = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
};

export interface LearnedCriterion { id: string; question: string; prs: number[]; reviewers: number; urls: string[] }
export interface CommentSuggestions { add: LearnedCriterion[]; skipped: string[]; used: boolean }

/**
 * Groups of similar review comments that cross the comment thresholds (`comment_min_prs` different PRs, `comment_min_actors`
 * different commenter hashes) become at most MAX_LEARNED_CRITERIA new `rubrics.custom` entries. No model call. A group whose
 * text could relax a check (or approve something) is refused, and nothing here can lower a lane: the criterion is pass/fail,
 * high severity, `raise_to: review`. `used` is true when comment evidence took part (the proposal then says where it came from).
 */
export function collectCommentSuggestions(missed: MissedItem[] | undefined, cfg: Config): CommentSuggestions {
  const out: CommentSuggestions = { add: [], skipped: [], used: false };
  if (!learnsFromComments(cfg) || !missed?.length) return out;
  const t = cfg.learning.proposal;
  const items = missed.filter((m) => m && Number.isInteger(m.pr) && typeof m.actor === "string" && ACTOR_HASH_RE.test(m.actor) && typeof m.text === "string" && typeof m.fingerprint === "string")
    .map((m) => ({ ...m, fingerprint: commentFingerprint(m.text) || m.fingerprint }));
  const known = knownCriterionIds(cfg);
  const questions = new Set(cfg.rubrics.custom.map((c) => c.question));
  const groups = groupMissed(items)
    .filter((g) => g.prs.length >= t.comment_min_prs && g.actors.length >= t.comment_min_actors)
    .sort((a, b) => b.prs.length - a.prs.length || b.actors.length - a.actors.length || a.items[0]!.fingerprint.localeCompare(b.items[0]!.fingerprint));
  let room = MAX_CUSTOM_CRITERIA - cfg.rubrics.custom.length;
  for (const g of groups) {
    out.used = true;
    const rep = g.items[0]!;
    if (g.items.some((i) => refuseReason(i.text))) { out.skipped.push(`A point raised on ${g.prs.length} PRs was not turned into a check: its wording could relax a check, and learning never does that.`); continue; }
    const excerpt = defang(rep.text, EXCERPT_MAX).replace(/["\\]/g, "'").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
    if (excerpt.length < 10) continue;
    const id = `${LEARNED_ID_PREFIX}${fnv8(rep.fingerprint)}`;
    const question = learnedQuestion(excerpt);
    if (known.has(id) || questions.has(question)) continue;
    if (out.add.length >= MAX_LEARNED_CRITERIA) break;
    if (room <= 0) { out.skipped.push("`rubrics.custom` already holds the maximum of 20 checks; no new check was added."); break; }
    room--;
    const urls = [...new Set(g.items.map((i) => i.url).filter((u): u is string => typeof u === "string" && COMMENT_URL_RE.test(u)))].slice(0, 5);
    out.add.push({ id, question, prs: g.prs, reviewers: g.actors.length, urls });
  }
  return out;
}

// ---- text-level yaml edits (comments and layout stay) ---------------------------------------------------------

const q = (s: string) => `"${s}"`;
const lineStart = (t: string, i: number) => t.lastIndexOf("\n", i - 1) + 1;
const col = (t: string, i: number) => i - lineStart(t, i);
/** Index of the newline that ends the last line of a block collection (or the end of the text). */
function blockEnd(t: string, node: { range?: [number, number, number] | null }): number {
  let e = node.range![1];
  if (e > 0 && t[e - 1] === "\n") e--;
  const nl = t.indexOf("\n", e);
  return nl < 0 ? t.length : nl;
}
const insertLines = (t: string, at: number, lines: string[]) => t.slice(0, at) + "\n" + lines.join("\n") + t.slice(at);
const appendTop = (t: string, lines: string[]) => (t && !t.endsWith("\n") ? t + "\n" : t) + lines.join("\n") + "\n";

function rootMap(t: string): { root: YAMLMap | null; empty: boolean } | null {
  const doc = parseDocument(t);
  if (doc.errors.length) return null;
  if (doc.contents == null) return { root: null, empty: true };
  return isMap(doc.contents) && !doc.contents.flow ? { root: doc.contents, empty: false } : null;
}
const firstKeyCol = (t: string, m: YAMLMap): number | null => {
  const k = m.items[0]?.key;
  return k && isScalar(k) && k.range ? col(t, k.range[0]) : null;
};

/** Adds globs to `lanes.protected`. Null when the yaml has a shape this cannot edit safely (the proposal then only reports it). */
export function addProtectedGlobs(text: string, globs: string[]): string | null {
  const r = rootMap(text);
  if (!r) return null;
  const withDefaults = (have: string[]) => [...have, ...globs.filter((g) => !have.includes(g))];
  const block = (ind: string, items: string[]) => [`${ind}protected:`, ...items.map((g) => `${ind}  - ${q(g)}`)];
  if (r.empty || !r.root!.has("lanes")) return appendTop(text, ["lanes:", ...block("  ", withDefaults(DEFAULT_PROTECTED))]);
  const lanes = r.root!.get("lanes", true);
  if (!isMap(lanes) || lanes.flow || !lanes.items.length) return null;
  const prot = lanes.get("protected", true);
  if (prot === undefined) {
    const c = firstKeyCol(text, lanes);
    return c === null ? null : insertLines(text, blockEnd(text, lanes), block(" ".repeat(c), withDefaults(DEFAULT_PROTECTED)));
  }
  if (!isSeq(prot) || prot.flow || !prot.items.length || !prot.items.every((i) => isScalar(i) && typeof i.value === "string")) return null;
  const have = prot.items.map((i) => String((i as { value: unknown }).value));
  const add = globs.filter((g) => !have.includes(g));
  if (!add.length) return text;
  const first = prot.items[0] as { range: [number, number, number] };
  const prefix = text.slice(lineStart(text, first.range[0]), first.range[0]);
  if (!/^\s*-\s+$/.test(prefix)) return null;
  return insertLines(text, blockEnd(text, prot), add.map((g) => `${prefix}${q(g)}`));
}

/** Adds `rubrics.notes.<id>`. Returns the text unchanged if the id already has a note. Null when the shape cannot be edited safely. */
export function addRubricNote(text: string, id: string, note: string): string | null {
  if (!NOTE_ID_RE.test(id) || /["\\\n]/.test(note)) return null;
  const r = rootMap(text);
  if (!r) return null;
  const pair = (ind: string) => `${ind}${q(id)}: ${q(note)}`;
  if (r.empty || !r.root!.has("rubrics")) return appendTop(text, ["rubrics:", "  notes:", pair("    ")]);
  const rubrics = r.root!.get("rubrics", true);
  if (!isMap(rubrics) || rubrics.flow || !rubrics.items.length) return null;
  const notes = rubrics.get("notes", true);
  if (notes === undefined) {
    const c = firstKeyCol(text, rubrics);
    if (c === null) return null;
    return insertLines(text, blockEnd(text, rubrics), [`${" ".repeat(c)}notes:`, pair(" ".repeat(c + 2))]);
  }
  if (!isMap(notes)) return null;
  if (notes.has(id)) return text;
  if (notes.flow && !notes.items.length && notes.range) {
    const c = firstKeyCol(text, rubrics);
    if (c === null) return null;
    return text.slice(0, notes.range[0]).replace(/[ \t]+$/, "") + "\n" + pair(" ".repeat(c + 2)) + text.slice(notes.range[1]);
  }
  if (notes.flow) return null;
  const c = firstKeyCol(text, notes);
  return c === null ? null : insertLines(text, blockEnd(text, notes), [pair(" ".repeat(c))]);
}

/**
 * Appends criteria to `rubrics.custom`: pass/fail, high severity, `raise_to: review`. The only fields written are the fixed ones
 * below, and text with `"` / `\` / line breaks is refused. Null when the yaml has a shape this cannot edit safely.
 */
export function addCustomCriteria(text: string, add: { id: string; question: string }[]): string | null {
  if (!add.length || add.some((c) => !LEARNED_ID_RE.test(c.id) || /["\\\n\r]/.test(c.question))) return null;
  const r = rootMap(text);
  if (!r) return null;
  const item = (prefix: string, c: { id: string; question: string }) => {
    const pad = " ".repeat(prefix.length);
    return [`${prefix}id: ${q(c.id)}`, `${pad}question: ${q(c.question)}`, `${pad}severity: high`, `${pad}scoring: pass_fail`, `${pad}raise_to: review`];
  };
  const items = (dash: string) => add.flatMap((c) => item(dash, c));
  if (r.empty || !r.root!.has("rubrics")) return appendTop(text, ["rubrics:", "  custom:", ...items("    - ")]);
  const rubrics = r.root!.get("rubrics", true);
  if (!isMap(rubrics) || rubrics.flow || !rubrics.items.length) return null;
  const c = firstKeyCol(text, rubrics);
  if (c === null) return null;
  const custom = rubrics.get("custom", true);
  if (custom === undefined) return insertLines(text, blockEnd(text, rubrics), [`${" ".repeat(c)}custom:`, ...items(`${" ".repeat(c + 2)}- `)]);
  if (!isSeq(custom)) return null;
  if (custom.flow) {
    if (custom.items.length || !custom.range) return null;
    return text.slice(0, custom.range[0]).replace(/[ \t]+$/, "") + "\n" + items(`${" ".repeat(c + 2)}- `).join("\n") + text.slice(custom.range[1]);
  }
  const first = custom.items[0] as { range?: [number, number, number] } | undefined;
  if (!first?.range) return null;
  const prefix = text.slice(lineStart(text, first.range[0]), first.range[0]);
  if (!/^\s*-\s+$/.test(prefix)) return null;
  return insertLines(text, blockEnd(text, custom), items(prefix));
}

// ---- the no-weaken guard --------------------------------------------------------------------------------------

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** `rubrics.custom` may only grow at the end by expected, well-formed learned criteria; the existing ones stay byte-for-byte equal. */
function guardCustomAdditions(a: Config, b: Config, expected: string[]): void {
  const before = a.rubrics.custom, after = b.rubrics.custom;
  if (after.length > MAX_CUSTOM_CRITERIA) throw new ProposalGuardError("edit makes rubrics.custom longer than 20 entries");
  if (after.length < before.length) throw new ProposalGuardError("edit removes a custom criterion");
  before.forEach((c, i) => { if (!same(c, after[i])) throw new ProposalGuardError(`edit changes the existing criterion ${c.id}`); });
  const taken = new Set([...Object.values(DEFAULT_PACKS).flatMap((p) => p.criteria.map((c) => c.id)), ...before.map((c) => c.id)]);
  for (const c of after.slice(before.length)) {
    if (!expected.includes(c.id)) throw new ProposalGuardError(`unexpected custom criterion "${c.id}"`);
    if (!LEARNED_ID_RE.test(c.id)) throw new ProposalGuardError(`custom criterion "${c.id}" does not have the learned- id form`);
    if (taken.has(c.id)) throw new ProposalGuardError(`custom criterion "${c.id}" duplicates an existing id`);
    taken.add(c.id);
    if (c.raise_to !== "review") throw new ProposalGuardError(`custom criterion "${c.id}" may only raise to review`);
    if (c.severity !== "high" || c.scoring !== "pass_fail" || c.note !== undefined) throw new ProposalGuardError(`custom criterion "${c.id}" has fields a learning proposal may not set`);
    if (!LEARNED_QUESTION_RE.test(c.question) || refuseReason(c.question)) throw new ProposalGuardError(`custom criterion "${c.id}" does not use the fixed question wording`);
  }
}

/**
 * Re-parses both texts with the repo's config parser and throws unless the only differences are
 * (1) more entries in `lanes.protected` (none removed, none that are too broad), (2) new `rubrics.notes`
 * on ids that are not sensitive, and (3) criteria appended to `rubrics.custom` that are listed in `expect.customAdded`:
 * `learned-<8 hex>` id, the fixed question template, pass/fail, high severity, `raise_to: review`, at most 20 in all, with every
 * existing criterion unchanged and in place. Every other setting (lanes.auto, code_auto, max lines, approval, labels, provider,
 * rubrics packs/severity/raise_to of existing criteria, ...) must be identical.
 */
export function guardConfigEdit(before: string, after: string, expect: { protectedAdded?: string[]; notesAdded?: string[]; customAdded?: string[] }): void {
  const a = parseConfig(before), b = parseConfig(after);
  const strip = (c: Config) => ({ ...c, lanes: { ...c.lanes, protected: null }, rubrics: { ...c.rubrics, notes: null, custom: null } });
  if (!same(strip(a), strip(b))) throw new ProposalGuardError("edit changes a setting other than lanes.protected additions, rubrics.notes additions or rubrics.custom additions");
  guardCustomAdditions(a, b, expect.customAdded ?? []);
  for (const p of a.lanes.protected) if (!b.lanes.protected.includes(p)) throw new ProposalGuardError(`edit removes protected path "${p}"`);
  const addedP = b.lanes.protected.filter((p) => !a.lanes.protected.includes(p));
  for (const p of addedP) {
    if (!(expect.protectedAdded ?? []).includes(p)) throw new ProposalGuardError(`unexpected protected path "${p}"`);
    if (globFor(p.replace(/\/\*\*$/, "/x")) === null || /^\.github(\/|$)/.test(p) || p === "**" || p.startsWith("*")) throw new ProposalGuardError(`protected path "${p}" is not allowed`);
  }
  for (const [id, n] of Object.entries(a.rubrics.notes)) if (b.rubrics.notes[id] !== n) throw new ProposalGuardError(`edit changes the existing note for ${id}`);
  for (const id of Object.keys(b.rubrics.notes)) {
    if (id in a.rubrics.notes) continue;
    if (!(expect.notesAdded ?? []).includes(id)) throw new ProposalGuardError(`unexpected note for ${id}`);
    const crit = [...Object.values(DEFAULT_PACKS).flatMap((p) => p.criteria), ...b.rubrics.custom].find((c) => c.id === id);
    if (SENSITIVE_ID.test(id) || crit?.raise_to === "block") throw new ProposalGuardError(`a note may not soften ${id} (security or block criterion)`);
  }
}

// ---- plan + publish -------------------------------------------------------------------------------------------

export interface ProposalPlan { title: string; body: string; files: { path: string; content: string }[]; edits: number }

const list = (n: number[]) => n.slice(0, 10).map((x) => `#${x}`).join(", ") + (n.length > 10 ? `, +${n.length - 10} more` : "");
const BODY_MAX = 60_000;

/**
 * Turn lessons (+ Worker evidence) into real file edits. Returns null when nothing crosses a threshold, edits are off,
 * or no edit survives the guard: the caller then keeps the record-only proposal. Reads one file; never writes.
 */
export async function planProposal(o: {
  ok: Octokit; repo: Repo; cfg: Config; defaultBranch: string; lessons: Lesson[]; extra: ExtraEvidence;
  /** Lessons report appended to the PR body; empty when the proposal rests on outcome evidence alone. */
  reportBody: string; log: { info: (m: string) => void; warning: (m: string) => void };
}): Promise<ProposalPlan | null> {
  const { cfg, log } = o;
  if (!cfg.learning.proposal.edits) { log.info("learning.proposal.edits is off; record-only proposal."); return null; }
  const sug = collectSuggestions(o.lessons, o.extra, cfg);
  const com = collectCommentSuggestions(o.extra.missed, cfg);
  if (!sug.strict.length && !sug.lenient.length && !com.add.length) { log.info("No suggestion crossed a threshold; record-only proposal."); return null; }
  const before = (await fetchRepoFile(o.ok, o.repo, CONFIG_PATH, o.defaultBranch)) ?? "";
  parseConfig(before); // the repo's own config must be valid before we touch it (throws -> caller keeps record-only)
  let text = before;
  const lines: string[] = [];
  const notApplied: string[] = [...sug.skipped];
  const notesAdded: string[] = [];
  const protectedAdded: string[] = [];
  const customAdded: string[] = [];

  for (const s of sug.strict) {
    const why = `${s.prs.length} PRs (${list(s.prs)}), people: ${s.actors.map((x) => `\`${x}\``).join(", ")}; ${s.downs} "wrong" vote(s), ${s.mergedOver} merge(s) over a failed check, ${s.dismissed} dismissed finding(s), ${s.ups} "right" vote(s)`;
    if (SENSITIVE_ID.test(s.id) || cfg.rubrics.custom.find((c) => c.id === s.id)?.raise_to === "block") {
      notApplied.push(`\`${s.id}\` looks too strict (${why}). It is a security or block check, so learning never softens it. Please look at it by hand.`);
      continue;
    }
    if (cfg.rubrics.notes[s.id] || cfg.rubrics.custom.find((c) => c.id === s.id)?.note) {
      notApplied.push(`\`${s.id}\` already has a note; not changed (${why}).`);
      continue;
    }
    const next = addRubricNote(text, s.id, strictNote(s));
    if (next === null || next === text) { notApplied.push(`\`${s.id}\` looks too strict (${why}), but \`${CONFIG_PATH}\` has a layout I cannot edit safely.`); continue; }
    text = next; notesAdded.push(s.id);
    lines.push(`- **Too strict:** add a note to \`${s.id}\` under \`rubrics.notes\`. Evidence: ${why}.`);
  }
  for (const l of sug.lenient) {
    const why = `${l.events.length} reverts or fix follow-ups of auto PRs (${l.events.map((e) => `#${e.pr} ${e.kind === "reverted" ? "reverted" : "fixed after"}`).join(", ")}), e.g. \`${l.paths.join("`, `")}\``;
    const next = addProtectedGlobs(text, [l.glob]);
    if (next === null || next === text) { notApplied.push(`\`${l.glob}\` looks too lenient (${why}), but \`${CONFIG_PATH}\` has a layout I cannot edit safely.`); continue; }
    text = next; protectedAdded.push(l.glob);
    lines.push(`- **Too lenient:** add \`${l.glob}\` to \`lanes.protected\` (changes there then need a human). Evidence: ${why}.`);
  }
  notApplied.push(...com.skipped);
  if (com.add.length) {
    const next = addCustomCriteria(text, com.add);
    if (next === null || next === text) notApplied.push(`${com.add.length} point(s) reviewers raised look like a new check, but \`${CONFIG_PATH}\` has a layout I cannot edit safely.`);
    else {
      text = next;
      for (const c of com.add) {
        customAdded.push(c.id);
        const links = c.urls.map((u, i) => `[${i + 1}](${u})`).join(" ");
        lines.push(`- **Missed by MergeJudge:** add the check \`${c.id}\` under \`rubrics.custom\`: ${c.question} It can only raise a PR to \`review\`, never to \`block\`. Evidence: from ${c.reviewers} reviewer${c.reviewers === 1 ? "" : "s"} across ${c.prs.length} PRs (${list(c.prs)})${links ? `. Comments: ${links}` : ""}.`);
      }
    }
  }
  if (!lines.length) { log.info(`No suggested edit could be applied (${notApplied.length} reported only); record-only proposal.`); return null; }

  try {
    guardConfigEdit(before, text, { protectedAdded, notesAdded, customAdded });
    assertProposalFilePath(CONFIG_PATH);
  } catch (e) {
    log.warning(`Proposal edit refused by the guard (${(e as Error).message}); record-only proposal.`);
    return null;
  }

  const body = [
    "<!-- mergejudge:learning-proposal -->",
    "## MergeJudge learning proposal",
    "",
    `This PR changes \`${CONFIG_PATH}\` based on what people did with MergeJudge reviews. **A human must read the diff and decide.** It is labelled \`do-not-merge\` and \`needs-human\`, and MergeJudge never approves or merges it.`,
    "",
    "### Proposed edits",
    "",
    ...lines,
    "",
    customAdded.length
      ? "These edits only add prompt notes, protected paths and checks that can raise a PR to `review`. They cannot remove a protected path or a check, change `lanes.auto`, `lanes.code_auto`, approval settings or the severity of an existing check."
      : "These edits only add prompt notes and protected paths. They cannot remove a protected path, change `lanes.auto`, `lanes.code_auto`, approval settings or any severity.",
    ...(customAdded.length || com.used ? [
      "",
      "### Where the comment evidence came from",
      "",
      "Review comments left by people with write access on lines where MergeJudge had no finding, read when a PR was merged or closed, were used as evidence. Only short excerpts and links to the original comments are quoted here; no names. To turn this off, set `learning.from_comments: false` in `.mergejudge.yml`.",
    ] : []),
    ...(notApplied.length ? ["", "### Seen, but not changed", "", ...notApplied.map((x) => `- ${x}`)] : []),
    "",
    ...(o.reportBody ? [
      "---",
      "",
      o.reportBody.replace("<!-- mergejudge:learning-proposal -->\n", "").replace(/^## MergeJudge learning proposal\n/, "### Report\n"),
    ] : []),
  ].join("\n").slice(0, BODY_MAX);
  return {
    title: `chore(mergejudge): learning proposal, ${lines.length} suggested edit(s)`,
    body,
    files: [{ path: CONFIG_PATH, content: text }],
    edits: lines.length,
  };
}

/** Labels for the proposal PR. Creating a label may fail (exists, no permission): tolerated. Never approves or merges. */
export async function labelProposalPr(ok: Octokit, repo: Repo, pr: number, log: { warning: (m: string) => void }): Promise<void> {
  for (const l of PROPOSAL_LABELS) {
    try { await ok.rest.issues.createLabel({ ...repo, ...l }); } catch { /* already there, or no permission */ }
  }
  try {
    await ok.rest.issues.addLabels({ ...repo, issue_number: pr, labels: PROPOSAL_LABELS.map((l) => l.name) });
  } catch (e) {
    log.warning(`Could not label proposal PR #${pr} (${(e as Error).message}).`);
  }
}
