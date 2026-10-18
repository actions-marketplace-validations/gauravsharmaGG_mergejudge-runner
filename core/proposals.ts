import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml";
import { minimatch } from "minimatch";
import { DEFAULT_PROTECTED, parseConfig, type Config } from "./config.js";
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

// ---- the no-weaken guard --------------------------------------------------------------------------------------

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Re-parses both texts with the repo's config parser and throws unless the only differences are
 * (1) more entries in `lanes.protected` (none removed, none that are too broad), and (2) new `rubrics.notes`
 * on ids that are not sensitive. Every other setting (lanes.auto, code_auto, max lines, approval, labels, provider,
 * rubrics packs/custom/severity/raise_to, ...) must be identical.
 */
export function guardConfigEdit(before: string, after: string, expect: { protectedAdded?: string[]; notesAdded?: string[] }): void {
  const a = parseConfig(before), b = parseConfig(after);
  const strip = (c: Config) => ({ ...c, lanes: { ...c.lanes, protected: null }, rubrics: { ...c.rubrics, notes: null } });
  if (!same(strip(a), strip(b))) throw new ProposalGuardError("edit changes a setting other than lanes.protected additions or rubrics.notes additions");
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
  if (!sug.strict.length && !sug.lenient.length) { log.info("No suggestion crossed a threshold; record-only proposal."); return null; }
  const before = (await fetchRepoFile(o.ok, o.repo, CONFIG_PATH, o.defaultBranch)) ?? "";
  parseConfig(before); // the repo's own config must be valid before we touch it (throws -> caller keeps record-only)
  let text = before;
  const lines: string[] = [];
  const notApplied: string[] = [...sug.skipped];
  const notesAdded: string[] = [];
  const protectedAdded: string[] = [];

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
  if (!lines.length) { log.info(`No suggested edit could be applied (${notApplied.length} reported only); record-only proposal.`); return null; }

  try {
    guardConfigEdit(before, text, { protectedAdded, notesAdded });
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
    "These edits only add prompt notes and protected paths. They cannot remove a protected path, change `lanes.auto`, `lanes.code_auto`, approval settings or any severity.",
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
