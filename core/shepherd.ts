import { minimatch } from "minimatch";
import { z } from "zod";
import { DEFAULT_PROTECTED, type Config } from "./config.js";
import type { Octokit, Repo } from "./github.js";
import { escapeMd } from "./render.js";
import { isMergeJudgeConfigPath } from "./rules.js";
import { redact } from "../src/redact.js";
import { effectiveCap } from "./shepherdrules.js";

/** Label that turns Shepherd on for a PR (adding) or off (removing). */
export const SHEPHERD_LABEL = "shepherd";
export const SHEPHERD_MARKER = "<!-- mergejudge:shepherd";
/** The state comment only: the hand-off comment's marker (`<!-- mergejudge:shepherd-handoff -->`) starts with SHEPHERD_MARKER too. */
export const isStateComment = (body: string | null | undefined): boolean => /<!-- mergejudge:shepherd [^\s>-]/.test(body ?? "");
/**
 * A state comment Shepherd can trust: written by a bot, and by Shepherd's own bot login when that is known (an App slug).
 * Without a known login only the Bot account type is checked.
 */
export const isOwnStateComment = (c: { body?: string | null; user?: { type?: string; login?: string } | null }, selfLogin?: string | null): boolean =>
  isStateComment(c.body) && c.user?.type === "Bot" && (!selfLogin || c.user.login === selfLogin);
export const MAX_ENTRIES = 20;
const FIELD_MAX = 300;

/** Paths Shepherd never edits on its own: CI, MergeJudge config, deploy/rollback, auth and secrets. Repo `shepherd.protected_paths` adds to these. */
export const DEFAULT_PROTECTED_PATHS = [
  ...DEFAULT_PROTECTED,
  ".mergejudge.yml",
  ".mergejudge.yaml",
  "**/deploy*",
  "**/deploy*/**",
  "**/*deploy*.sh",
  "**/rollback*",
  "**/rollback*/**",
  "scripts/deploy/**",
  "**/*secret*",
  "**/*.env",
  "**/.env*",
  "**/*auth*.{ts,js,py,go}",
  "**/*.pem",
  "**/*.key",
  "wrangler.toml",
];

type ShepherdCfg = { shepherd: Pick<Config["shepherd"], "protected_paths"> };

const norm = (p: string) => p.replace(/^\.\//, "");

export function isProtectedPath(path: string, cfg: ShepherdCfg): boolean {
  const p = norm(path);
  if (isMergeJudgeConfigPath(p)) return true;
  return [...DEFAULT_PROTECTED_PATHS, ...cfg.shepherd.protected_paths].some((g) => minimatch(p, g, { dot: true, nocase: true }));
}

/** The subset of `paths` Shepherd must not edit. */
export const protectedHits = (paths: string[], cfg: ShepherdCfg): string[] => paths.filter((p) => isProtectedPath(p, cfg));

/** Comment command: "on" for `/mergejudge shepherd [on]`, "off" for `/mergejudge shepherd off`, "retry" for `/mergejudge shepherd retry`. Quoted lines and fenced code are ignored; the last command wins. */
export function parseShepherdCommand(body: string | null | undefined): "on" | "off" | "retry" | null {
  let out: "on" | "off" | "retry" | null = null;
  let fence: string | null = null;
  for (const line of (body ?? "").split(/\r?\n/)) {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = line.match(/^\s*\/mergejudge\s+shepherd(?:\s+(on|off|retry))?\s*$/i);
    if (m) out = m[1] ? (m[1].toLowerCase() as "on" | "off" | "retry") : "on";
  }
  return out;
}

export const isShepherdOn = (labels: readonly (string | { name?: string })[] | null | undefined): boolean =>
  (labels ?? []).some((l) => (typeof l === "string" ? l : l.name ?? "").toLowerCase() === SHEPHERD_LABEL);

// ---------------- state ----------------

export const STATUSES = ["watching", "fixing", "green", "stopped", "limit", "protected", "off"] as const;
export type ShepherdStatus = (typeof STATUSES)[number];
export type EntryKind = "ci" | "conflict" | "suggestion" | "info";

export interface ShepherdEntry {
  at: string;
  kind: EntryKind;
  what: string;
  changed: string;
  result: string;
  /** Commit sha (hex). */
  commit?: string;
  /** https URL of the CI run. */
  run?: string;
  /** Failure fingerprints this step set out to fix (mirror of the commit trailers; the commits are authoritative). */
  fingerprints?: string[];
  /** "Waiting for checks": L4 could not decide because a counted check on `sha` was still pending. Re-evaluated on the next trigger for the same head. */
  waiting?: WaitingRun;
}
/** The failed workflow run Shepherd could not decide on yet, and the head it ran for. */
export interface WaitingRun { sha: string; runId: number; conclusion: string; attempt: number }
/** One `/mergejudge shepherd retry`: who granted the extra attempt and when. `comment` is the command comment's id (a re-run of the same event grants nothing twice). */
export interface ShepherdGrant { who: string; at: string; comment?: number }
export interface ShepherdState {
  v: 1;
  on: boolean;
  attempts: number;
  maxAttempts: number;
  /** Extra attempts humans granted with `/mergejudge shepherd retry`; the cap is `maxAttempts + grants`. */
  grants: number;
  grantLog: ShepherdGrant[];
  status: ShepherdStatus;
  entries: ShepherdEntry[];
}

const entrySchema = z.object({
  at: z.string().max(40),
  kind: z.enum(["ci", "conflict", "suggestion", "info"]),
  what: z.string(),
  changed: z.string(),
  result: z.string(),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/i).optional(),
  run: z.string().regex(/^https:\/\/[^\s<>()]+$/).max(300).optional(),
  fingerprints: z.array(z.string().regex(/^[0-9a-f]{6,16}$/)).max(10).optional(),
  waiting: z.object({ sha: z.string().regex(/^[0-9a-f]{7,40}$/i), runId: z.number().int(), conclusion: z.string().max(30), attempt: z.number().int().min(1).max(1000) }).optional(),
});
const grantSchema = z.object({ who: z.string().max(100), at: z.string().max(40), comment: z.number().int().optional() });
const stateSchema = z.object({
  v: z.literal(1),
  on: z.boolean(),
  attempts: z.number().int().min(0).max(1000),
  maxAttempts: z.number().int().min(1).max(10),
  grants: z.number().int().min(0).max(1000).default(0),
  grantLog: z.array(grantSchema).default([]),
  status: z.enum(STATUSES),
  entries: z.array(entrySchema),
});

export const newShepherdState = (maxAttempts = 3): ShepherdState =>
  ({ v: 1, on: true, attempts: 0, maxAttempts, grants: 0, grantLog: [], status: "watching", entries: [] });

/** Record one retry grant (+1 attempt). The same command comment never grants twice. */
export function addGrant(state: ShepherdState, g: ShepherdGrant): ShepherdState {
  if (g.comment != null && state.grantLog.some((x) => x.comment === g.comment)) return state;
  const who = g.who.replace(/[^A-Za-z0-9_.\[\]-]/g, "").slice(0, 100);
  return { ...state, grants: state.grants + 1, grantLog: [...state.grantLog, { who, at: g.at, ...(g.comment != null ? { comment: g.comment } : {}) }].slice(-MAX_ENTRIES) };
}

/** Free text goes through the runner's redaction; secrets must never reach the PR comment. */
const clean = (s: string, sanitize: (t: string) => string) => sanitize(String(s)).replace(/\s+/g, " ").trim().slice(0, FIELD_MAX);

export function addEntry(state: ShepherdState, e: ShepherdEntry, sanitize: (t: string) => string = (t) => redact(t)): ShepherdState {
  const entry: ShepherdEntry = {
    at: e.at, kind: e.kind, what: clean(e.what, sanitize), changed: clean(e.changed, sanitize), result: clean(e.result, sanitize),
    ...(e.commit && /^[0-9a-f]{7,40}$/i.test(e.commit) ? { commit: e.commit } : {}),
    ...(e.run && /^https:\/\/[^\s<>()]+$/.test(e.run) ? { run: e.run.slice(0, 300) } : {}),
    ...(e.fingerprints?.length ? { fingerprints: e.fingerprints.filter((f) => /^[0-9a-f]{6,16}$/.test(f)).slice(0, 10) } : {}),
    ...(e.waiting && /^[0-9a-f]{7,40}$/i.test(e.waiting.sha) ? { waiting: { ...e.waiting, conclusion: e.waiting.conclusion.slice(0, 30) } } : {}),
  };
  return { ...state, entries: [...state.entries, entry].slice(-MAX_ENTRIES) };
}

/** The waiting entry for this head, if any. */
export const findWaiting = (state: ShepherdState | null | undefined, sha: string): WaitingRun | null =>
  state?.entries.find((e) => e.waiting && e.waiting.sha.toLowerCase() === sha.toLowerCase())?.waiting ?? null;

/** Entries marked "waiting for checks" (at most one is kept, see `addWaiting`). */
export const hasWaiting = (state: ShepherdState | null | undefined): boolean => !!state?.entries.some((e) => e.waiting);

/**
 * Record a "waiting for checks" entry. Idempotent: the same head and run is never added twice, and a newer failed run
 * replaces an older waiting entry (one waiting entry at most, so a trigger re-evaluates exactly one run).
 */
export function addWaiting(state: ShepherdState, e: Omit<ShepherdEntry, "waiting">, w: WaitingRun): ShepherdState {
  if (state.entries.some((x) => x.waiting && x.waiting.sha.toLowerCase() === w.sha.toLowerCase() && x.waiting.runId === w.runId)) return state;
  return addEntry(dropWaiting(state), { ...e, waiting: w });
}

/** Drop waiting entries: all of them, or only those not for `keepSha` (the head moved). */
export const dropWaiting = (state: ShepherdState, keepSha?: string): ShepherdState => ({
  ...state, entries: state.entries.filter((e) => !e.waiting || (keepSha != null && e.waiting.sha.toLowerCase() === keepSha.toLowerCase())),
});

export function parseShepherdState(body: string | null | undefined): ShepherdState | null {
  const m = body?.match(/<!-- mergejudge:shepherd (\S+) -->/);
  if (!m) return null;
  try {
    const r = stateSchema.safeParse(JSON.parse(decodeURIComponent(m[1]!)));
    return r.success ? { ...r.data, entries: r.data.entries.slice(-MAX_ENTRIES) } : null;
  } catch {
    return null;
  }
}

/** Whether another fix attempt may start. Pure: use `startAttempt` to record it. */
export function nextAttempt(state: ShepherdState): { allowed: boolean; reason: string } {
  if (!state.on || state.status === "off") return { allowed: false, reason: "Shepherd is off for this PR." };
  if (state.status === "protected") return { allowed: false, reason: "A fix needs a protected path; a human must make it." };
  const cap = effectiveCap(state.maxAttempts, state.grants);
  if (state.attempts >= cap) return { allowed: false, reason: `Retry limit reached (${state.attempts}/${cap}).` };
  return { allowed: true, reason: `Attempt ${state.attempts + 1} of ${cap}.` };
}

/** Count one fix attempt, or move to "limit" when none is left. */
export function startAttempt(state: ShepherdState): ShepherdState {
  const n = nextAttempt(state);
  if (n.allowed) return { ...state, attempts: state.attempts + 1, status: "fixing" };
  return state.on && state.status !== "protected" && state.attempts >= effectiveCap(state.maxAttempts, state.grants) ? { ...state, status: "limit" } : state;
}

// ---------------- comment ----------------

const STATUS_TEXT: Record<ShepherdStatus, string> = {
  watching: "👀 Watching",
  fixing: "🔧 Fixing",
  green: "✅ Checks pass",
  stopped: "⏹️ Stopped",
  limit: "🛑 Stopped: retry limit reached",
  protected: "🔒 Stopped: a fix needs a protected path",
  off: "💤 Off",
};

/** Untrusted-text-safe single line: markdown-escaped, `|` and @mentions neutralised. */
const cell = (s: string) => escapeMd(s).replace(/@(?=[A-Za-z0-9])/g, "@​");

export function renderShepherdComment(state: ShepherdState, repoUrl: string): string {
  const out = [
    "### 🐑 MergeJudge Shepherd — Watch and auto-fix",
    "",
    "MergeJudge watches this PR and keeps fixing it until checks and review pass.",
    "",
    `**Status:** ${STATUS_TEXT[state.status]}  `,
    `**Fix attempts:** ${state.attempts}/${effectiveCap(state.maxAttempts, state.grants)}${state.grants ? ` (+${state.grants} granted)` : ""}`,
    "",
  ];
  if (state.entries.length) {
    out.push("| When | Kind | What failed | What changed | Result | Links |", "| --- | --- | --- | --- | --- | --- |");
    for (const e of state.entries) {
      const links = [
        e.commit ? `[commit ${e.commit.slice(0, 7)}](${repoUrl}/commit/${e.commit})` : "",
        e.run ? `[run](${e.run})` : "",
      ].filter(Boolean).join(" · ");
      out.push(`| ${cell(e.at)} | ${e.kind} | ${cell(e.what)} | ${cell(e.changed)} | ${cell(e.result)} | ${links} |`);
    }
    out.push("");
  } else out.push("_No steps yet._", "");
  out.push(
    "Shepherd never merges. A human still merges.",
    "To turn it off, comment `/mergejudge shepherd off` or remove the `shepherd` label.",
    "",
    `${SHEPHERD_MARKER} ${encodeURIComponent(JSON.stringify(state))} -->`,
  );
  return out.join("\n");
}

// ---------------- one state comment per PR, even after a race ----------------

type CommentLite = { id: number; body?: string | null; user?: { type?: string; login?: string } | null };

/** Shepherd's own state comments, oldest first. The oldest is the live one; later ones are leftovers of a create race. */
export const ownStateComments = <T extends CommentLite>(comments: readonly T[], selfLogin?: string | null): T[] =>
  comments.filter((c) => isOwnStateComment(c, selfLogin)).sort((a, b) => a.id - b.id);

const grantKey = (g: ShepherdGrant) => (g.comment != null ? `c${g.comment}` : `${g.who}@${g.at}`);
const entryKey = (e: ShepherdEntry) => JSON.stringify([e.at, e.kind, e.what, e.changed, e.result, e.commit, e.run]);

/** `base` plus the retry grants of the other states, each grant once (by command comment id), so no grant is lost to a split state. */
export function mergeGrants(base: ShepherdState, others: readonly ShepherdState[]): ShepherdState {
  const log = [...base.grantLog];
  const seen = new Set(log.map(grantKey));
  let extra = 0;
  for (const g of others.flatMap((o) => o.grantLog)) if (!seen.has(grantKey(g))) { seen.add(grantKey(g)); log.push(g); extra++; }
  const grants = Math.max(base.grants + extra, ...others.map((o) => o.grants), log.length);
  return extra || grants !== base.grants ? { ...base, grants, grantLog: log.slice(-MAX_ENTRIES) } : base;
}

/**
 * Fold duplicate state comments into one state: grants and grant log (see mergeGrants) and log entries, each once, in time
 * order. The status, on/off and attempt fields come from the state whose newest entry is the latest (later argument wins a tie).
 */
export function mergeStates(base: ShepherdState, others: readonly ShepherdState[]): ShepherdState {
  const all = [base, ...others];
  const seen = new Set<string>();
  const entries = all.flatMap((x) => x.entries).filter((e) => !seen.has(entryKey(e)) && seen.add(entryKey(e))).sort((a, b) => a.at.localeCompare(b.at)).slice(-MAX_ENTRIES);
  const newest = all.reduce((best, x) => ((x.entries.at(-1)?.at ?? "") >= (best.entries.at(-1)?.at ?? "") ? x : best), base);
  return { ...mergeGrants(newest, all.filter((x) => x !== newest)), entries };
}

/** The state Shepherd reads for a PR: the oldest own state comment, with the grants of any duplicates added. Null when there is none. */
export function readShepherdState(comments: readonly CommentLite[], selfLogin?: string | null): ShepherdState | null {
  const [first, ...rest] = ownStateComments(comments, selfLogin);
  const base = parseShepherdState(first?.body);
  if (!base) return null;
  return mergeGrants(base, rest.map((c) => parseShepherdState(c.body)).filter((x): x is ShepherdState => !!x));
}

export const SUPERSEDED_MARKER = "<!-- mergejudge:shepherd-superseded -->";

/** Remove duplicate state comments (Shepherd's own): delete, else turn into a short pointer to the live one. */
async function retire(ok: Octokit, r: Repo, pull: number, extras: readonly CommentLite[], liveId: number): Promise<void> {
  const link = `https://github.com/${r.owner}/${r.repo}/pull/${pull}#issuecomment-${liveId}`;
  for (const c of extras) {
    try { await ok.rest.issues.deleteComment({ ...r, comment_id: c.id }); } catch (e) {
      if ((e as { status?: number }).status === 404) continue;
      await ok.rest.issues.updateComment({ ...r, comment_id: c.id, body: `${SUPERSEDED_MARKER}\nSuperseded by ${link}.` }).catch(() => undefined);
    }
  }
}

/**
 * Create or update the one Shepherd log comment of a PR. `next` is the new state, or a function of the previous one
 * (null when there is no comment yet) so a caller reads and writes with a single listing. Only bot comments are matched,
 * like the sticky summary comment.
 *
 * The OLDEST own state comment is always the live one. Existing duplicates are folded into it and removed. After a create the
 * comments are listed again: if another run created one first (a concurrency group keeps only one pending run, but two runs
 * can still overlap), this run's state is merged into the older comment and the newer one is removed, so the log never splits.
 */
export async function upsertShepherdComment(
  ok: Octokit, r: Repo, pull: number, next: ShepherdState | ((prev: ShepherdState | null) => ShepherdState), selfLogin?: string | null,
): Promise<ShepherdState> {
  const url = `https://github.com/${r.owner}/${r.repo}`;
  const list = () => ok.paginate(ok.rest.issues.listComments, { ...r, issue_number: pull, per_page: 100 });
  const parsed = (cs: readonly CommentLite[]) => cs.map((c) => parseShepherdState(c.body)).filter((x): x is ShepherdState => !!x);
  const own = ownStateComments(await list(), selfLogin);
  const existing = own[0];
  const prev = parseShepherdState(existing?.body);
  const folded = prev ? mergeStates(prev, parsed(own.slice(1))) : prev;
  const state = typeof next === "function" ? next(folded) : next;
  if (existing) {
    await ok.rest.issues.updateComment({ ...r, comment_id: existing.id, body: renderShepherdComment(state, url) });
    await retire(ok, r, pull, own.slice(1), existing.id);
    return state;
  }
  const created = await ok.rest.issues.createComment({ ...r, issue_number: pull, body: renderShepherdComment(state, url) });
  const myId = (created as { data?: { id?: number } } | undefined)?.data?.id;
  if (myId == null) return state;
  const after = ownStateComments(await list(), selfLogin);
  const winner = after[0];
  if (!winner || (winner.id === myId && after.length < 2)) return state;
  const others = after.slice(1);
  const merged = mergeStates(parseShepherdState(winner.body) ?? state, [...parsed(others.filter((c) => c.id !== myId)), ...(winner.id === myId ? [] : [state])]);
  await ok.rest.issues.updateComment({ ...r, comment_id: winner.id, body: renderShepherdComment(merged, url) });
  await retire(ok, r, pull, others, winner.id);
  return merged;
}
