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
