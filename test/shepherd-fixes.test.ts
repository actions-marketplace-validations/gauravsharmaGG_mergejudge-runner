import { describe, expect, it } from "vitest";
import { addEntry, addGrant, newShepherdState, parseShepherdState, readShepherdState, renderShepherdComment, type ShepherdState } from "../core/shepherd.js";
import { runShepherd, type ShepherdPayload } from "../src/shepherd.js";
import { fakeGh, git, handoffs, makeCtx, makeRepo, stateComment, type Repo3 } from "./support/shepherdkit.js";

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

interface SweepSpec { n: number; branch: string; labels?: string[]; draft?: boolean; base?: string; mergeable?: (boolean | null)[]; state?: string; fork?: boolean }
const imports = (...n: string[]) => n.map((x) => `import ${x} from "${x}";`).join("\n") + "\n";

/** PRs on real branches (each adds an import line to src/m.ts, or touches g.txt when `clean`), then main changes the same import line. */
function sweepSetup(specs: SweepSpec[], ctxOver: Parameters<typeof makeCtx>[2] = {}) {
  const repo = makeRepo({ "src/m.ts": imports("z"), "g.txt": "1\n" });
  for (const s of specs) {
    repo.branch(s.branch, "main");
    repo.commit(s.branch, s.mergeable?.at(-1) === true ? { "g.txt": `pr ${s.n}\n` } : { "src/m.ts": imports("z", `p${s.n}`) }, `pr ${s.n}`);
  }
  repo.commit("main", { "src/m.ts": imports("z", "q") }, "base change");
  const gh = fakeGh(repo, { commits: () => [] });
  const asked: Record<string, unknown>[] = [];
  const polls: Record<number, number> = {};
  const shape = (s: SweepSpec, withMergeable: boolean) => ({
    number: s.n, state: s.state ?? "open", draft: !!s.draft, labels: (s.labels ?? ["shepherd"]).map((name) => ({ name })),
    head: { sha: repo.tip(s.branch), ref: s.branch, repo: { full_name: s.fork ? "forker/r" : "o/r" } },
    base: { ref: s.base ?? "main", sha: repo.tip("main"), repo: { full_name: "o/r" } },
    ...(withMergeable ? (() => {
      const seq = s.mergeable ?? [false];
      const i = Math.min(polls[s.n] = (polls[s.n] ?? -1) + 1, seq.length - 1);
      return { mergeable: seq[i], mergeable_state: seq[i] === false ? "dirty" : seq[i] ? "clean" : "unknown" };
    })() : {}),
  });
  const rest = gh.ok.rest as unknown as { pulls: Record<string, unknown> };
  rest.pulls.list = async (p: Record<string, unknown>) => { asked.push(p); return { data: specs.filter((s) => !p.base || (s.base ?? "main") === p.base).map((s) => shape(s, false)) }; };
  rest.pulls.get = async (p: { pull_number: number }) => ({ data: shape(specs.find((s) => s.n === p.pull_number)!, true) });
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

  it("gives up on a mergeable that stays null, after a capped wait", async () => {
    const s = sweepSetup([{ n: 11, branch: "conf", mergeable: [null] }]);
    const before = s.tip("conf");
    await s.run("push", push());
    expect(s.slept).toEqual([1000, 2000, 4000]);
    expect(s.tip("conf")).toBe(before);
    expect(s.ctx.lines.join("\n")).toContain("still unknown");
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
