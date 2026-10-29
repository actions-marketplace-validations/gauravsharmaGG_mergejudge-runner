import { describe, expect, it } from "vitest";
import { addEntry, addGrant, newShepherdState, parseShepherdState, readShepherdState, renderShepherdComment, type ShepherdState } from "../core/shepherd.js";
import { buildCommitMessage, extractFailureSection, fingerprintFailure, tailLog } from "../core/shepherdfail.js";
import { redactLog, runShepherd, type ShepherdPayload } from "../src/shepherd.js";
import { failLog, fakeGh, git, handoffs, makeCtx, makeRepo, stateComment, textProvider, wr, type Repo3 } from "./support/shepherdkit.js";

const dirty = (repo: Repo3) => git(repo.ws, "status", "--porcelain");
const sync: ShepherdPayload = { action: "synchronize", pull_request: { number: 7 } };
function conflictRepo(files: Record<string, string>, feature: Record<string, string>, main: Record<string, string>, over: Parameters<typeof fakeGh>[1] = {}, ctxOver: Parameters<typeof makeCtx>[2] = {}, cfg = "") {
  const repo = makeRepo(files);
  repo.commit("feature", feature, "pr change");
  repo.commit("main", main, "base change");
  const gh = fakeGh(repo, { mergeable: false, ...over });
  const ctx = makeCtx(repo, gh, ctxOver, cfg);
  return { repo, gh, ctx, run: (p: ShepherdPayload, ev = "pull_request") => runShepherd(ctx, ev, p) };
}

const URL = "https://github.com/o/r";
const bot = { type: "Bot", login: "mj[bot]" };
const stateOf = (s: ShepherdState) => renderShepherdComment(s, URL);
const cmd = (body: string, id = 1): ShepherdPayload => ({ action: "created", issue: { number: 7, pull_request: {} }, comment: { id, body, user: { login: "maintainer", type: "User" } }, sender: { login: "maintainer", type: "User" } });
const info = (at: string, what: string) => ({ at, kind: "info" as const, what, changed: "nothing", result: "ok" });

describe("one state comment per PR (concurrency race)", () => {
  const withGrant = (s: ShepherdState, comment: number, who = "maintainer") => addGrant(s, { who, at: "2026-10-29T00:00:00Z", comment });

  it("readShepherdState uses the oldest own state comment and adds the grants of every duplicate", () => {
    const older = addEntry(withGrant(newShepherdState(3), 11), info("2026-10-29T00:00:01Z", "older row"));
    const newer = addEntry(withGrant(newShepherdState(3), 12), info("2026-10-29T00:00:02Z", "newer row"));
    const comments = [{ id: 20, body: stateOf(newer), user: bot }, { id: 10, body: stateOf(older), user: bot }, { id: 5, body: stateOf(withGrant(newShepherdState(3), 99)), user: { type: "User", login: "evil" } }];
    const s = readShepherdState(comments, "mj[bot]")!;
    expect(s.entries.map((e) => e.what)).toEqual(["older row"]);
    expect(s.grants).toBe(2);
    expect(s.grantLog.map((g) => g.comment)).toEqual([11, 12]);
    expect(readShepherdState([{ id: 1, body: "hi", user: bot }], "mj[bot]")).toBeNull();
  });

  it("with two state comments the oldest is updated and grants from both count", async () => {
    const repo = makeRepo();
    const older = addEntry(withGrant(newShepherdState(3), 11), info("2026-10-29T00:00:01Z", "older row"));
    const newer = addEntry(withGrant(newShepherdState(3), 12), info("2026-10-29T00:00:02Z", "newer row"));
    const gh = fakeGh(repo, { comments: [{ id: 30, body: stateOf(newer), user: bot }, { id: 10, body: stateOf(older), user: bot }] });
    const ctx = makeCtx(repo, gh);
    await runShepherd(ctx, "issue_comment", cmd("/mergejudge shepherd retry", 13));
    expect(gh.st.comments.map((c) => c.id)).toEqual([10]);
    expect(gh.st.calls).toContain("deleteComment");
    const s = parseShepherdState(stateComment(gh.st)!.body)!;
    expect(s.grants).toBe(3);
    expect(s.grantLog.map((g) => g.comment).sort()).toEqual([11, 12, 13]);
    expect(s.entries.map((e) => e.what)).toEqual(expect.arrayContaining(["older row", "newer row", "Retry granted"]));
  });

  it("the next write folds a duplicate state comment into the oldest and keeps its grant", async () => {
    const repo = makeRepo();
    const gh = fakeGh(repo, { comments: [{ id: 10, body: stateOf(newShepherdState(3)), user: bot }, { id: 11, body: stateOf(withGrant(newShepherdState(3), 12)), user: bot }] });
    const ctx = makeCtx(repo, gh);
    await runShepherd(ctx, "issue_comment", cmd("/mergejudge shepherd off", 14));
    expect(gh.st.comments.map((c) => c.id)).toEqual([10]);
    expect(parseShepherdState(stateComment(gh.st)!.body)).toMatchObject({ on: false, grants: 1 });
  });

  it("a simulated create race ends with one live state comment holding both entries", async () => {
    const repo = makeRepo();
    const gh = fakeGh(repo, { labels: new Set() });
    // A rival run creates its state comment first, but only becomes visible after this run created its own.
    gh.st.onCreate = (id) => {
      gh.st.onCreate = undefined;
      const rival = addEntry(withGrant(newShepherdState(3), 77, "rival"), info("2026-10-29T00:00:00Z", "rival row"));
      gh.st.comments.unshift({ id: id - 1, body: stateOf(rival), user: bot });
    };
    const ctx = makeCtx(repo, gh);
    await runShepherd(ctx, "issue_comment", cmd("/mergejudge shepherd"));
    const live = gh.st.comments.filter((c) => /<!-- mergejudge:shepherd [^\s>-]/.test(c.body));
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(0);
    const s = parseShepherdState(live[0]!.body)!;
    expect(s.entries.map((e) => e.what)).toEqual(expect.arrayContaining(["rival row", "Shepherd turned on"]));
    expect(s.grants).toBe(1);
    expect(s.grantLog[0]!.who).toBe("rival");
    expect(gh.st.comments).toHaveLength(1);
  });
});

// ---------------- base branch moved: sweep ----------------

interface SweepSpec { n: number; branch: string; labels?: string[]; draft?: boolean; base?: string; mergeable?: (boolean | null)[]; state?: string; fork?: boolean;
  /** mergeable true: the merge commit was computed against the old main (stale), not the current tip. */
  stale?: boolean;
  /** Force a change that conflicts with main even when the last answer is true. */
  conflicting?: boolean;
  /** Report this head sha (not on origin) instead of the branch tip. */
  headSha?: string }
const mergeSha = (s: SweepSpec) => "c".repeat(36) + String(s.n).padStart(4, "0");
const imports = (...n: string[]) => n.map((x) => `import ${x} from "${x}";`).join("\n") + "\n";

/** PRs on real branches (each adds an import line to src/m.ts, or touches g.txt when `clean`), then main changes the same import line. */
function sweepSetup(specs: SweepSpec[], ctxOver: Parameters<typeof makeCtx>[2] = {}) {
  const repo = makeRepo({ "src/m.ts": imports("z"), "g.txt": "1\n" });
  const oldMain = repo.tip("main");
  for (const s of specs) {
    repo.branch(s.branch, "main");
    repo.commit(s.branch, s.mergeable?.at(-1) === true && !s.conflicting ? { "g.txt": `pr ${s.n}\n` } : { "src/m.ts": imports("z", `p${s.n}`) }, `pr ${s.n}`);
  }
  repo.commit("main", { "src/m.ts": imports("z", "q") }, "base change");
  const gh = fakeGh(repo, { commits: () => [] });
  const asked: Record<string, unknown>[] = [];
  const polls: Record<number, number> = {};
  const shape = (s: SweepSpec, withMergeable: boolean) => ({
    number: s.n, state: s.state ?? "open", draft: !!s.draft, labels: (s.labels ?? ["shepherd"]).map((name) => ({ name })),
    head: { sha: s.headSha ?? repo.tip(s.branch), ref: s.branch, repo: { full_name: s.fork ? "forker/r" : "o/r" } },
    base: { ref: s.base ?? "main", sha: repo.tip("main"), repo: { full_name: "o/r" } },
    merge_commit_sha: mergeSha(s),
    ...(withMergeable ? (() => {
      const seq = s.mergeable ?? [false];
      const i = Math.min(polls[s.n] = (polls[s.n] ?? -1) + 1, seq.length - 1);
      return { mergeable: seq[i], mergeable_state: seq[i] === false ? "dirty" : seq[i] ? "clean" : "unknown" };
    })() : {}),
  });
  const rest = gh.ok.rest as unknown as { pulls: Record<string, unknown> };
  rest.pulls.list = async (p: Record<string, unknown>) => { asked.push(p); return { data: specs.filter((s) => !p.base || (s.base ?? "main") === p.base).map((s) => shape(s, false)) }; };
  rest.pulls.get = async (p: { pull_number: number }) => ({ data: shape(specs.find((s) => s.n === p.pull_number)!, true) });
  // The PR's merge commit has the base tip GitHub computed against as first parent: the current tip, or the old one when stale.
  const repos = gh.ok.rest.repos as unknown as { getCommit: (p: { ref: string }) => Promise<unknown> };
  const getCommit = repos.getCommit;
  repos.getCommit = async (p) => {
    const spec = specs.find((x) => p.ref === mergeSha(x));
    return spec ? { data: { parents: [{ sha: spec.stale ? oldMain : repo.tip("main") }, { sha: repo.tip(spec.branch) }] } } : getCommit(p);
  };
  (gh.ok.rest as unknown as { git: unknown }).git = { getRef: async (p: { ref: string }) => ({ data: { object: { sha: repo.tip(p.ref.replace(/^heads\//, "")) } } }) };
  const slept: number[] = [];
  const ctx = makeCtx(repo, gh, { sleep: async (ms) => { slept.push(ms); }, ...ctxOver });
  const run = (ev: string, p: ShepherdPayload = {}) => runShepherd(ctx, ev, p);
  const tip = (b: string) => repo.tip(b);
  return { repo, gh, ctx, run, asked, polls, slept, tip };
}
const push = (over: ShepherdPayload = {}): ShepherdPayload => ({ ref: "refs/heads/main", sender: { login: "maintainer", type: "User" }, head_commit: { message: "merge something" }, ...over });

describe("base branch moved: sweep", () => {
  it("a push to main runs conflictCheck only for the conflicting shepherd PR", async () => {
    const s = sweepSetup([
      { n: 11, branch: "conf" },
      { n: 12, branch: "clean", mergeable: [true] },
      { n: 13, branch: "unlabeled", labels: [] },
    ]);
    const before = { conf: s.tip("conf"), clean: s.tip("clean"), unlabeled: s.tip("unlabeled") };
    await s.run("push", push());
    expect(s.tip("conf")).not.toBe(before.conf);
    expect(git(s.repo.bare, "log", "-1", "--format=%B", "refs/heads/conf")).toContain("MergeJudge-Shepherd-Kind: conflict");
    expect(s.tip("clean")).toBe(before.clean);
    expect(s.tip("unlabeled")).toBe(before.unlabeled);
    expect(s.asked[0]).toMatchObject({ state: "open", base: "main" });
    expect(s.polls[13]).toBeUndefined();
    expect(s.ctx.lines.join("\n")).toContain("#12 has no merge conflict");
  });

  it("a mergeable of null and then false is polled with a backoff and handled", async () => {
    const s = sweepSetup([{ n: 11, branch: "conf", mergeable: [null, null, false] }]);
    const before = s.tip("conf");
    await s.run("push", push());
    expect(s.slept).toEqual([1000, 2000]);
    expect(s.tip("conf")).not.toBe(before);
  });

  it("a mergeable that stays null, after a capped wait, is decided by a local merge check", async () => {
    const s = sweepSetup([{ n: 11, branch: "conf", mergeable: [null] }]);
    const before = s.tip("conf");
    await s.run("push", push());
    expect(s.slept).toEqual([1000, 2000, 4000]);
    expect(s.tip("conf")).not.toBe(before);
    expect(s.ctx.lines.join("\n")).toContain("has not computed mergeable; checking the merge locally");
  });

  it("a stale mergeable true (merge commit built on the old main) is polled, then a local merge check finds the conflict", async () => {
    const s = sweepSetup([{ n: 11, branch: "conf", mergeable: [true], stale: true, conflicting: true }]);
    const before = s.tip("conf");
    const old = git(s.repo.bare, "rev-parse", "refs/heads/main~1");
    await s.run("push", push({ after: s.tip("main") }));
    expect(s.slept).toEqual([1000, 2000, 4000]);
    expect(s.tip("conf")).not.toBe(before);
    expect(git(s.repo.bare, "log", "-1", "--format=%B", "refs/heads/conf")).toContain("MergeJudge-Shepherd-Kind: conflict");
    const log = s.ctx.lines.join("\n");
    expect(log).toContain(`#11: GitHub's mergeable answer is stale (computed against ${old.slice(0, 7)}, base is ${s.tip("main").slice(0, 7)})`);
    expect(log).toContain("a local merge check");
  });

  it("a fresh mergeable true (first parent is the base tip) is trusted with no polling and no local check", async () => {
    const s = sweepSetup([{ n: 11, branch: "ok", mergeable: [true], conflicting: true }]);
    const before = s.tip("ok");
    await s.run("schedule", {});
    expect(s.slept).toEqual([]);
    expect(s.tip("ok")).toBe(before);
    const log = s.ctx.lines.join("\n");
    expect(log).toContain("#11 has no merge conflict");
    expect(log).not.toContain("locally");
  });

  it("a stale true that turns false on a later poll goes to the conflict work", async () => {
    const s = sweepSetup([{ n: 11, branch: "conf", mergeable: [true, false], stale: true, conflicting: true }]);
    const before = s.tip("conf");
    await s.run("schedule", {});
    expect(s.slept).toEqual([1000]);
    expect(s.tip("conf")).not.toBe(before);
    expect(s.ctx.lines.join("\n")).not.toContain("locally");
  });

  it("a stale true with a local check that cannot decide leaves the PR and says so", async () => {
    const s = sweepSetup([{ n: 11, branch: "conf", mergeable: [true], stale: true, conflicting: true, headSha: "d".repeat(40) }]);
    const before = s.tip("conf");
    await s.run("push", push());
    expect(s.tip("conf")).toBe(before);
    expect(s.ctx.lines.join("\n")).toContain("#11: the local merge check could not decide; the sweep leaves it.");
  });

  it("a stale true with a clean local merge is left", async () => {
    const s = sweepSetup([{ n: 11, branch: "ok", mergeable: [true], stale: true }]);
    const before = s.tip("ok");
    await s.run("push", push());
    expect(s.tip("ok")).toBe(before);
    expect(s.ctx.lines.join("\n")).toContain("the local merge check finds no merge conflict");
  });

  it("a schedule sweep looks at every base branch and skips drafts, needs-human, forks and PRs Shepherd is not on for", async () => {
    const s = sweepSetup([
      { n: 11, branch: "a" },
      { n: 12, branch: "b" },
      { n: 13, branch: "draft", draft: true },
      { n: 14, branch: "nh", labels: ["shepherd", "needs-human"] },
      { n: 15, branch: "fork", fork: true },
      { n: 16, branch: "off", labels: [] },
    ]);
    const before = Object.fromEntries(["a", "b", "draft", "nh", "fork", "off"].map((b) => [b, s.tip(b)]));
    await s.run("schedule", {});
    expect(s.asked[0]).not.toHaveProperty("base");
    expect(s.tip("a")).not.toBe(before.a);
    expect(s.tip("b")).not.toBe(before.b);
    for (const b of ["draft", "nh", "fork", "off"]) expect(s.tip(b)).toBe(before[b]);
    await s.run("workflow_dispatch", {});
    expect(s.tip("draft")).toBe(before.draft);
  });

  it("a PR without the label is swept when Shepherd is on in its state comment", async () => {
    const s = sweepSetup([{ n: 11, branch: "conf", labels: [] }]);
    s.gh.st.comments.push({ id: 90, issue: 11, body: stateOf(newShepherdState(3)), user: bot });
    const before = s.tip("conf");
    await s.run("workflow_dispatch", {});
    expect(s.tip("conf")).not.toBe(before);
  });

  it("a push by Shepherd itself, or to a tag, is ignored", async () => {
    const s = sweepSetup([{ n: 11, branch: "conf" }]);
    const before = s.tip("conf");
    await s.run("push", push({ sender: { login: "mj[bot]", type: "Bot" } }));
    await s.run("push", push({ head_commit: { message: "x\n\nMergeJudge-Shepherd: attempt 1\n" } }));
    await s.run("push", push({ ref: "refs/tags/v1" }));
    await s.run("push", push({ deleted: true }));
    expect(s.asked).toHaveLength(0);
    expect(s.tip("conf")).toBe(before);
  });

  it("a push only sweeps PRs based on the pushed branch", async () => {
    const s = sweepSetup([{ n: 11, branch: "conf" }, { n: 12, branch: "rel", base: "release" }]);
    const rel = s.tip("rel");
    await s.run("push", push());
    expect(s.tip("rel")).toBe(rel);
    expect(s.polls[12]).toBeUndefined();
  });

  it("caps the shepherded PRs looked at per run", async () => {
    const specs = Array.from({ length: 12 }, (_, i) => ({ n: 20 + i, branch: `b${i}`, mergeable: [true] }));
    const s = sweepSetup(specs);
    await s.run("push", push());
    expect(Object.keys(s.polls)).toHaveLength(10);
    expect(s.ctx.lines.join("\n")).toContain("Sweep limit reached");
  });

  it("one failing PR does not stop the sweep", async () => {
    const s = sweepSetup([{ n: 11, branch: "a" }, { n: 12, branch: "b" }]);
    const get = (s.gh.ok.rest.pulls as unknown as { get: (p: { pull_number: number }) => Promise<unknown> }).get;
    (s.gh.ok.rest.pulls as unknown as { get: unknown }).get = async (p: { pull_number: number }) => { if (p.pull_number === 11) throw new Error("boom"); return get(p); };
    const b = s.tip("b");
    await s.run("push", push());
    expect(s.tip("b")).not.toBe(b);
    expect(s.ctx.lines.join("\n")).toContain("Sweep of #11 failed");
  });
});

// ---------------- retry re-checks the outstanding CI failure ----------------

describe("retry re-checks the outstanding CI failure", () => {
  const LOG = failLog("TypeError: boom is not a function");
  const fpOf = (log: string) => fingerprintFailure("test", redactLog(tailLog(extractFailureSection(log), 200, 20_000))).hash;
  const RETRY = "/mergejudge shepherd retry";
  const text = (src: string) => JSON.stringify({ files: [{ path: "src/a.ts", content: src }], explanation: "fix" });
  /** One earlier attempt (cap 1) carrying `fps`, then a human commit on top; the CI run on that head failed. */
  function stopped(fps: string[], conclusion = "failure", calls = { n: 0 }) {
    const repo = makeRepo({ "src/a.ts": "export const a = 1;\n", "src/keep.ts": "export const k = 1;\n" });
    repo.commit("feature", { "src/keep.ts": "export const k = 2;\n" }, buildCommitMessage({ subject: "shepherd: fix test (attempt 1/1)", attempt: 1, kind: "ci", fingerprints: fps, failures: 1 }));
    repo.commit("feature", { "src/a.ts": "export const a = 2;\n" }, "human: change a");
    const gh = fakeGh(repo, { jobs: [{ id: 1, name: "test", conclusion: "failure", log: LOG }] });
    gh.st.runs = [{ id: 100, name: "CI", workflow_id: 1, conclusion, head_sha: repo.tip("feature"), run_attempt: 1 }];
    const ctx = makeCtx(repo, gh, { provider: textProvider(text("export const a = 3;\n"), calls) }, "shepherd:\n  max_attempts: 1\n");
    return { repo, gh, ctx, calls, run: (p: ShepherdPayload, ev = "workflow_run") => runShepherd(ctx, ev, p) };
  }
  const tipMsg = (repo: Repo3) => git(repo.bare, "log", "-1", "--format=%B", "refs/heads/feature");

  it("after an L1 stop with a known failure, a retry pushes one fix attempt", async () => {
    const s = stopped([fpOf(LOG)]);
    await s.run(wr(s.gh, { run_attempt: 1 }));
    expect(handoffs(s.gh.st)).toHaveLength(1);
    expect(handoffs(s.gh.st)[0]!.body).toContain("Loop breaker L1");
    expect(s.gh.st.labels.has("needs-human")).toBe(true);
    const before = s.repo.tip("feature");
    await s.run(cmd("/mergejudge shepherd retry", 5), "issue_comment");
    expect(s.repo.tip("feature")).not.toBe(before);
    expect(tipMsg(s.repo)).toContain("MergeJudge-Shepherd: attempt 2");
    expect(tipMsg(s.repo)).toContain("(attempt 2/2)");
    expect(s.calls.n).toBe(1);
    expect(s.gh.st.reruns).toEqual([]);
    expect(s.gh.st.labels.has("needs-human")).toBe(false);
    const st = parseShepherdState(stateComment(s.gh.st)!.body)!;
    expect(st.grants).toBe(1);
    expect(st.entries.map((e) => e.what)).toContainEqual(expect.stringContaining("is still failing on the head"));
    const row = st.entries.find((e) => e.what.includes("is still failing"))!;
    expect(row.run).toBe("https://github.com/o/r/actions/runs/100");
    expect(st.entries.at(-1)).toMatchObject({ kind: "ci", run: "https://github.com/o/r/actions/runs/100", commit: s.repo.tip("feature") });
  });

  it("a second retry command for the same failure is not needed: one retry gives exactly one attempt", async () => {
    const s = stopped([fpOf(LOG)]);
    await s.run(wr(s.gh, { run_attempt: 1 }));
    await s.run(cmd(RETRY, 5), "issue_comment");
    expect(s.calls.n).toBe(1);
    await s.run(cmd(RETRY, 5), "issue_comment");
    expect(s.calls.n).toBe(1);
  });

  it("a retry with an unknown failure re-runs the failed jobs instead of fixing", async () => {
    const s = stopped(["abcdef0123"]);
    await s.run(wr(s.gh, { run_attempt: 1 }));
    expect(handoffs(s.gh.st)[0]!.body).toContain("Loop breaker L1");
    const before = s.repo.tip("feature");
    await s.run(cmd(RETRY, 5), "issue_comment");
    expect(s.gh.st.reruns).toEqual([100]);
    expect(s.repo.tip("feature")).toBe(before);
    expect(s.calls.n).toBe(0);
    const st = parseShepherdState(stateComment(s.gh.st)!.body)!;
    expect(st.entries.at(-1)).toMatchObject({ result: expect.stringContaining("Re-running failed jobs"), run: "https://github.com/o/r/actions/runs/100" });
    // The re-run's own workflow_run event (attempt 2) is then handled normally and fixes it.
    await s.run(wr(s.gh, { run_attempt: 2 }));
    expect(tipMsg(s.repo)).toContain("MergeJudge-Shepherd: attempt 2");
  });

  it("a retry on a green head runs only the conflict check", async () => {
    const s = stopped([fpOf(LOG)], "success");
    s.gh.st.mergeable = true;
    await s.run(wr(s.gh, { conclusion: "success" }));
    const before = s.repo.tip("feature");
    await s.run(cmd(RETRY, 5), "issue_comment");
    expect(s.repo.tip("feature")).toBe(before);
    expect(s.gh.st.reruns).toEqual([]);
    expect(s.calls.n).toBe(0);
    expect(s.gh.st.calls).toContain("listRuns");
    expect(handoffs(s.gh.st)).toHaveLength(0);
    expect(parseShepherdState(stateComment(s.gh.st)!.body)!.entries.map((e) => e.what)).not.toContainEqual(expect.stringContaining("still failing"));
  });

  it("a newer green run of the same workflow, a cancelled run and Shepherd's own failed run are not outstanding failures", async () => {
    const s = stopped([fpOf(LOG)]);
    const sha = s.repo.tip("feature");
    s.gh.st.runs = [
      { id: 100, name: "CI", workflow_id: 1, conclusion: "failure", head_sha: sha },
      { id: 101, name: "CI", workflow_id: 1, conclusion: "success", head_sha: sha },
      { id: 102, name: "Lint", workflow_id: 2, conclusion: "cancelled", head_sha: sha },
      { id: 103, name: "Shepherd", workflow_id: 3, conclusion: "failure", head_sha: sha },
      { id: 104, name: "Elsewhere", workflow_id: 4, conclusion: "failure", head_sha: "f".repeat(40) },
    ];
    const before = s.repo.tip("feature");
    await s.run(cmd(RETRY, 5), "issue_comment");
    expect(s.repo.tip("feature")).toBe(before);
    expect(s.gh.st.reruns).toEqual([]);
    expect(s.calls.n).toBe(0);
  });

  it("a plain /mergejudge shepherd (no retry) does not look at failed runs", async () => {
    const s = stopped([fpOf(LOG)]);
    await s.run(cmd("/mergejudge shepherd", 6), "issue_comment");
    expect(s.gh.st.calls).not.toContain("listRuns");
  });
});

// ---------------- cosmetics ----------------

describe("cosmetics", () => {
  const plainText = (s: string) => s.replace(/\\/g, "");

  it("/mergejudge shepherd on a PR that is already on logs no second 'turned on' row", async () => {
    const repo = makeRepo();
    const gh = fakeGh(repo, { labels: new Set() });
    const ctx = makeCtx(repo, gh);
    await runShepherd(ctx, "issue_comment", cmd("/mergejudge shepherd", 1));
    const rows = () => parseShepherdState(stateComment(gh.st)!.body)!.entries.filter((e) => e.what === "Shepherd turned on").length;
    expect(rows()).toBe(1);
    const writes = gh.st.calls.filter((x) => x === "updateComment" || x === "createComment").length;
    await runShepherd(ctx, "issue_comment", cmd("/mergejudge shepherd", 2));
    expect(rows()).toBe(1);
    expect(gh.st.calls.filter((x) => x === "updateComment" || x === "createComment").length).toBe(writes);
    // After a hand-off (needs-human) the same command does resume and logs.
    gh.st.labels.add("needs-human");
    await runShepherd(ctx, "issue_comment", cmd("/mergejudge shepherd", 3));
    expect(gh.st.labels.has("needs-human")).toBe(false);
    expect(rows()).toBe(2);
  });

  it("turning off a PR that is already off logs no second 'turned off' row", async () => {
    const repo = makeRepo();
    const gh = fakeGh(repo);
    const ctx = makeCtx(repo, gh);
    await runShepherd(ctx, "issue_comment", cmd("/mergejudge shepherd off", 1));
    await runShepherd(ctx, "issue_comment", cmd("/mergejudge shepherd off", 2));
    expect(parseShepherdState(stateComment(gh.st)!.body)!.entries.filter((e) => e.what === "Shepherd turned off")).toHaveLength(1);
  });

  const readme = "# Title\n\nIntro.\n";
  it("the H4 hunk preview names the branches, and the H4 row and hand-off link the base commit", async () => {
    const { repo, gh, run } = conflictRepo({ "src/m.ts": "export const f = () => 1;\n" }, { "src/m.ts": "export const f = () => 2;\n" }, { "src/m.ts": "export const f = () => 3;\n" });
    await run(sync);
    const b = plainText(handoffs(gh.st)[0]!.body);
    expect(b).toContain("Hand-off H4");
    expect(b).toContain("main (base):");
    expect(b).toContain("feature (this PR):");
    expect(b).not.toMatch(/ ours: | base: /);
    const baseSha = repo.tip("main");
    expect(b).toContain(`https://github.com/o/r/commit/${baseSha}`);
    expect(parseShepherdState(stateComment(gh.st)!.body)!.entries.at(-1)).toMatchObject({ commit: baseSha });
  });

  it("the H1 row and hand-off link the base commit being merged", async () => {
    const { repo, gh, run } = conflictRepo(
      { "README.md": readme, ".github/workflows/ci.yml": "name: ci\n" },
      { "README.md": readme + "\nfunction a() {}\n" },
      { "README.md": readme + "\nfunction b() {}\n", ".github/workflows/ci.yml": "name: ci2\n" },
    );
    await run(sync);
    const baseSha = repo.tip("main");
    expect(handoffs(gh.st)[0]!.body).toContain(`[${baseSha.slice(0, 7)}](https://github.com/o/r/commit/${baseSha})`);
    expect(parseShepherdState(stateComment(gh.st)!.body)!.entries.at(-1)).toMatchObject({ commit: baseSha });
  });

  it("the L1 'all fix attempts are used' row and hand-off link the CI run that triggered them", async () => {
    const repo = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    repo.commit("feature", { "src/a.ts": "export const a = 2;\n" }, buildCommitMessage({ subject: "s", attempt: 1, kind: "ci", fingerprints: ["abcdef0123"], failures: 1 }));
    repo.commit("feature", { "src/a.ts": "export const a = 3;\n" }, "human: change a");
    const gh = fakeGh(repo, { jobs: [{ id: 1, name: "test", conclusion: "failure", log: failLog("TypeError: boom") }] });
    const ctx = makeCtx(repo, gh, {}, "shepherd:\n  max_attempts: 1\n");
    await runShepherd(ctx, "workflow_run", wr(gh, { id: 4242, run_attempt: 2 }));
    const h = handoffs(gh.st)[0]!.body;
    expect(h).toContain("Loop breaker L1");
    expect(h).toContain("https://github.com/o/r/actions/runs/4242");
    expect(parseShepherdState(stateComment(gh.st)!.body)!.entries.at(-1)).toMatchObject({ run: "https://github.com/o/r/actions/runs/4242" });
  });
});

describe("H1 comes first (live PR 11)", () => {
  const readme = "# Title\n\nIntro.\n";
  it("a logic conflict plus an incoming .github change reports H1, not H4", async () => {
    const { repo, gh, run } = conflictRepo(
      { "README.md": readme, ".github/workflows/ci.yml": "name: ci\n" },
      { "README.md": readme + "\nfunction fromPr() { return 1; }\n" },
      { "README.md": readme + "\nfunction fromBase() { return 2; }\n", ".github/workflows/ci.yml": "name: ci2\n" },
    );
    const before = repo.tip("feature");
    await run(sync);
    expect(repo.tip("feature")).toBe(before);
    expect(dirty(repo)).toBe("");
    const b = handoffs(gh.st)[0]!.body;
    expect(b).toContain("Hand-off H1");
    expect(b).not.toContain("Hand-off H4");
    expect(b).toContain(".github/workflows/ci.yml");
    expect(gh.st.labels.has("needs-human")).toBe(true);
    expect(handoffs(gh.st)).toHaveLength(1);
  });

  it("oversized + protected reports H1", async () => {
    const many = (p: string) => Array.from({ length: 60 }, (_, i) => `import ${p}${i} from "${p}${i}";`).join("\n") + "\n";
    const { repo, gh, run } = conflictRepo(
      { "src/m.ts": 'import z from "z";\n' },
      { "src/m.ts": 'import z from "z";\n' + many("p") },
      { "src/m.ts": 'import z from "z";\n' + many("q"), ".github/workflows/ci.yml": "name: ci\n" },
    );
    const before = repo.tip("feature");
    await run(sync);
    expect(repo.tip("feature")).toBe(before);
    expect(dirty(repo)).toBe("");
    const b = handoffs(gh.st)[0]!.body;
    expect(b).toContain("Hand-off H1");
    expect(b).not.toContain("Hand-off H2");
  });

  it("a conflict inside a protected file still reports H1 with the conflict wording", async () => {
    const { gh, run } = conflictRepo({ "deploy.sh": "echo 1\n" }, { "deploy.sh": "echo 2\n" }, { "deploy.sh": "echo 3\n" });
    await run(sync);
    expect(handoffs(gh.st)[0]!.body).toContain("merge conflict is in a protected path");
  });
});
