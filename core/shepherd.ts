import { minimatch } from "minimatch";
import { z } from "zod";
import { DEFAULT_PROTECTED, type Config } from "./config.js";
import type { Octokit, Repo } from "./github.js";
import { escapeMd } from "./render.js";
import { isMergeJudgeConfigPath } from "./rules.js";
import { redact } from "../src/redact.js";

/** Label that turns Shepherd on for a PR (adding) or off (removing). */
export const SHEPHERD_LABEL = "shepherd";
export const SHEPHERD_MARKER = "<!-- mergejudge:shepherd";
/** The state comment only: the hand-off comment's marker (`<!-- mergejudge:shepherd-handoff -->`) starts with SHEPHERD_MARKER too. */
export const isStateComment = (body: string | null | undefined): boolean => /<!-- mergejudge:shepherd [^\s>-]/.test(body ?? "");
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

/** Comment command: "on" for `/mergejudge shepherd [on]`, "off" for `/mergejudge shepherd off`. Quoted lines and fenced code are ignored; the last command wins. */
export function parseShepherdCommand(body: string | null | undefined): "on" | "off" | null {
  let out: "on" | "off" | null = null;
  let fence: string | null = null;
  for (const line of (body ?? "").split(/\r?\n/)) {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = line.match(/^\s*\/mergejudge\s+shepherd(?:\s+(on|off))?\s*$/i);
    if (m) out = m[1]?.toLowerCase() === "off" ? "off" : "on";
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
}
export interface ShepherdState {
  v: 1;
  on: boolean;
  attempts: number;
  maxAttempts: number;
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
});
const stateSchema = z.object({
  v: z.literal(1),
  on: z.boolean(),
  attempts: z.number().int().min(0).max(1000),
  maxAttempts: z.number().int().min(1).max(10),
  status: z.enum(STATUSES),
  entries: z.array(entrySchema),
});

export const newShepherdState = (maxAttempts = 3): ShepherdState =>
  ({ v: 1, on: true, attempts: 0, maxAttempts, status: "watching", entries: [] });

/** Free text goes through the runner's redaction; secrets must never reach the PR comment. */
const clean = (s: string, sanitize: (t: string) => string) => sanitize(String(s)).replace(/\s+/g, " ").trim().slice(0, FIELD_MAX);

export function addEntry(state: ShepherdState, e: ShepherdEntry, sanitize: (t: string) => string = (t) => redact(t)): ShepherdState {
  const entry: ShepherdEntry = {
    at: e.at, kind: e.kind, what: clean(e.what, sanitize), changed: clean(e.changed, sanitize), result: clean(e.result, sanitize),
    ...(e.commit && /^[0-9a-f]{7,40}$/i.test(e.commit) ? { commit: e.commit } : {}),
    ...(e.run && /^https:\/\/[^\s<>()]+$/.test(e.run) ? { run: e.run.slice(0, 300) } : {}),
    ...(e.fingerprints?.length ? { fingerprints: e.fingerprints.filter((f) => /^[0-9a-f]{6,16}$/.test(f)).slice(0, 10) } : {}),
  };
  return { ...state, entries: [...state.entries, entry].slice(-MAX_ENTRIES) };
}

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
  if (state.attempts >= state.maxAttempts) return { allowed: false, reason: `Retry limit reached (${state.attempts}/${state.maxAttempts}).` };
  return { allowed: true, reason: `Attempt ${state.attempts + 1} of ${state.maxAttempts}.` };
}

/** Count one fix attempt, or move to "limit" when none is left. */
export function startAttempt(state: ShepherdState): ShepherdState {
  const n = nextAttempt(state);
  if (n.allowed) return { ...state, attempts: state.attempts + 1, status: "fixing" };
  return state.on && state.status !== "protected" && state.attempts >= state.maxAttempts ? { ...state, status: "limit" } : state;
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
    `**Fix attempts:** ${state.attempts}/${state.maxAttempts}`,
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

/**
 * Create or update the one Shepherd log comment of a PR. `next` is the new state, or a function of the previous one
 * (null when there is no comment yet) so a caller reads and writes with a single listing. Only bot comments are matched,
 * like the sticky summary comment.
 */
export async function upsertShepherdComment(
  ok: Octokit, r: Repo, pull: number, next: ShepherdState | ((prev: ShepherdState | null) => ShepherdState),
): Promise<ShepherdState> {
  const comments = await ok.paginate(ok.rest.issues.listComments, { ...r, issue_number: pull, per_page: 100 });
  const existing = comments.find((c) => isStateComment(c.body) && c.user?.type === "Bot");
  const state = typeof next === "function" ? next(parseShepherdState(existing?.body)) : next;
  const body = renderShepherdComment(state, `https://github.com/${r.owner}/${r.repo}`);
  if (existing) await ok.rest.issues.updateComment({ ...r, comment_id: existing.id, body });
  else await ok.rest.issues.createComment({ ...r, issue_number: pull, body });
  return state;
}
