import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseConfig, type Config } from "../../core/config.js";
import type { LlmProvider } from "../../core/llm/provider.js";
import type { ShepherdCtx, ShepherdPayload } from "../../src/shepherd.js";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export interface Repo3 {
  root: string;
  bare: string;
  /** A developer clone (for making commits on main / feature). */
  dev: string;
  /** The Action workspace (what actions/checkout would leave). */
  ws: string;
  tip(branch: string): string;
  /** Commit files on a branch in the dev clone and push it. */
  commit(branch: string, files: Record<string, string>, message?: string): string;
  /** Create `branch` off `from` in the dev clone and push. */
  branch(branch: string, from: string): void;
  refreshWs(): void;
}

/** A real repo: bare origin, a developer clone and a workspace clone. main has the given files; `feature` starts equal to main. */
export function makeRepo(files: Record<string, string> = { "src/a.ts": "export const a = 1;\n" }): Repo3 {
  const root = mkdtempSync(join(tmpdir(), "mj-shep-"));
  const bare = join(root, "origin.git");
  const dev = join(root, "dev");
  const ws = join(root, "ws");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(root, "clone", "-q", bare, dev);
  git(dev, "checkout", "-q", "-b", "main");
  const write = (dir: string, fs: Record<string, string>) => {
    for (const [p, t] of Object.entries(fs)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), t); }
  };
  write(dev, files);
  git(dev, "add", "-A");
  git(dev, "commit", "-q", "-m", "init");
  git(dev, "push", "-q", "origin", "main");
  git(dev, "branch", "feature");
  git(dev, "push", "-q", "origin", "feature");
  git(root, "clone", "-q", bare, ws);
  const r: Repo3 = {
    root, bare, dev, ws,
    tip: (b) => git(bare, "rev-parse", `refs/heads/${b}`),
    commit(branch, fs, message = `change ${Object.keys(fs).join(",")}`) {
      git(dev, "checkout", "-q", branch);
      write(dev, fs);
      git(dev, "add", "-A");
      git(dev, "commit", "-q", "-m", message);
      git(dev, "push", "-q", "origin", branch);
      return git(dev, "rev-parse", "HEAD");
    },
    branch(branch, from) { git(dev, "checkout", "-q", "-B", branch, from); git(dev, "push", "-q", "origin", branch); },
    refreshWs() { git(ws, "fetch", "-q", "origin"); },
  };
  return r;
}

export interface FakeJob { id: number; name: string; conclusion: string | null; log: string }
export interface GhState {
  labels: Set<string>;
  comments: { id: number; body: string; user: { type: string; login: string } }[];
  /** Commit list for pulls.listCommits; default: git log of the bare repo's branch (oldest first). */
  commits?: () => { sha: string; commit: { message: string } }[];
  jobs: FakeJob[];
  checkRuns: { name: string; status: string; conclusion: string | null }[];
  permissions: Record<string, string>;
  mergeable: boolean | null;
  prFiles: string[];
  headSha?: string;
  state: string;
  fork: boolean;
  calls: string[];
  reruns: number[];
  headCommit?: { message: string; files: string[] };
}

export function fakeGh(repo: Repo3, over: Partial<GhState> = {}) {
  const st: GhState = {
    labels: new Set(["shepherd"]), comments: [], jobs: [], checkRuns: [], permissions: { maintainer: "admin", rando: "read" },
    mergeable: true, prFiles: ["src/a.ts"], state: "open", fork: false, calls: [], reruns: [], ...over,
  };
  let nextId = 1;
  const log = (c: string) => st.calls.push(c);
  const pull = () => ({
    number: 7, state: st.state, labels: [...st.labels].map((name) => ({ name })), mergeable: st.mergeable,
    head: { sha: st.headSha ?? repo.tip("feature"), ref: "feature", repo: { full_name: st.fork ? "forker/repo" : "o/r" } },
    base: { ref: "main", sha: repo.tip("main"), repo: { full_name: "o/r" } },
  });
  const commits = () => st.commits?.() ?? git(repo.bare, "log", "--reverse", "--format=%H", "refs/heads/main..refs/heads/feature").split("\n").filter(Boolean).map((sha) => ({ sha, commit: { message: git(repo.bare, "log", "-1", "--format=%B", sha) } }));
  const rest = {
    pulls: {
      get: async () => (log("pulls.get"), { data: pull() }),
      list: async () => ({ data: [pull()] }),
      listCommits: async () => ({ data: commits() }),
      listFiles: async () => ({ data: st.prFiles.map((filename) => ({ filename, status: "modified" })) }),
    },
    issues: {
      addLabels: async (p: { labels: string[] }) => { log(`addLabels:${p.labels.join(",")}`); p.labels.forEach((l) => st.labels.add(l)); return { data: [] }; },
      removeLabel: async (p: { name: string }) => {
        log(`removeLabel:${p.name}`);
        if (!st.labels.delete(p.name)) throw Object.assign(new Error("not found"), { status: 404 });
        return { data: [] };
      },
      listComments: async () => ({ data: st.comments }),
      createComment: async (p: { body: string }) => { log("createComment"); st.comments.push({ id: nextId++, body: p.body, user: { type: "Bot", login: "mj[bot]" } }); return { data: {} }; },
      updateComment: async (p: { comment_id: number; body: string }) => { log("updateComment"); st.comments.find((c) => c.id === p.comment_id)!.body = p.body; return { data: {} }; },
    },
    repos: {
      getCollaboratorPermissionLevel: async (p: { username: string }) => ({ data: { permission: st.permissions[p.username] ?? "none" } }),
      getCommit: async () => ({ data: { commit: { message: st.headCommit?.message ?? "x" }, files: (st.headCommit?.files ?? []).map((filename) => ({ filename })) } }),
    },
    checks: { listForRef: async () => ({ data: { check_runs: st.checkRuns } }) },
    actions: {
      listJobsForWorkflowRun: async () => { log("listJobs"); return { data: { jobs: st.jobs.map(({ log: _l, ...j }) => j) } }; },
      downloadJobLogsForWorkflowRun: async (p: { job_id: number }) => ({ data: st.jobs.find((j) => j.id === p.job_id)?.log ?? "" }),
      reRunWorkflowFailedJobs: async (p: { run_id: number }) => { log("rerun"); st.reruns.push(p.run_id); return { data: {} }; },
    },
  };
  const paginate = async (fn: (p: unknown) => Promise<{ data: unknown }>, params: unknown) => {
    const d = (await fn(params)).data as Record<string, unknown> | unknown[];
    if (Array.isArray(d)) return d;
    return (d.jobs ?? d.check_runs ?? []) as unknown[];
  };
  const ok = { rest, paginate } as unknown as ShepherdCtx["ok"];
  return { ok, st, pull };
}

export const botComments = (st: GhState) => st.comments.filter((c) => c.user.type === "Bot");
export const handoffs = (st: GhState) => st.comments.filter((c) => c.body.includes("mergejudge:shepherd-handoff"));
export const stateComment = (st: GhState) => st.comments.find((c) => /<!-- mergejudge:shepherd [^\s>-]/.test(c.body));

export const textProvider = (reply: string | (() => string), calls: { n: number } = { n: 0 }): LlmProvider => ({
  label: "mock",
  complete: async () => { calls.n++; return typeof reply === "function" ? reply() : reply; },
});

export function makeCtx(repo: Repo3, gh: ReturnType<typeof fakeGh>, over: Partial<ShepherdCtx> = {}, cfgText = ""): ShepherdCtx & { lines: string[]; cfg: Config } {
  const lines: string[] = [];
  return {
    ok: gh.ok, repo: { owner: "o", repo: "r" }, cfg: parseConfig(cfgText), cwd: repo.ws, token: "ghs_" + "T".repeat(36), botLogin: "mj[bot]",
    provider: null, self: { name: "Shepherd", ref: "o/r/.github/workflows/shepherd.yml@refs/heads/main" },
    log: { info: (m) => lines.push(m), warning: (m) => lines.push(`WARN ${m}`) },
    sleep: async () => {}, now: () => "2026-10-29T00:00:00Z",
    ...over, lines,
  } as ShepherdCtx & { lines: string[]; cfg: Config };
}

export const wr = (gh: ReturnType<typeof fakeGh>, o: { conclusion?: string; run_attempt?: number; id?: number; head_sha?: string; name?: string; path?: string } = {}): ShepherdPayload => ({
  workflow_run: {
    id: o.id ?? 100, name: o.name ?? "CI", path: o.path ?? ".github/workflows/ci.yml", conclusion: o.conclusion ?? "failure", head_sha: o.head_sha ?? gh.pull().head.sha,
    head_branch: "feature", run_attempt: o.run_attempt ?? 2, pull_requests: [{ number: 7 }],
  },
});

export const failLog = (msg: string, extra = "") =>
  `2026-10-29T10:00:00.1234567Z ##[group]Run npm test\n2026-10-29T10:00:01.1234567Z FAIL src/a.test.ts\n2026-10-29T10:00:01.1234567Z ${msg}\n${extra}2026-10-29T10:00:02.0000000Z ##[error]Process completed with exit code 1.\n`;

export const readFile = (dir: string, p: string) => readFileSync(join(dir, p), "utf8");
