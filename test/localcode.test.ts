import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aggregate } from "../core/aggregate.js";
import { loadPolicies } from "../core/policy.js";
import { parseConfig } from "../core/config.js";
import { buildIndex } from "../core/deepindex.js";
import type { RunnerJobPayload } from "../core/protocol.js";
import { cachePaths, cachePolicyFromEnv, cleanupCache, DEFAULT_CACHE, SnapshotStore, touchRepo, withRepoLock } from "../src/cache.js";
import { produceResult } from "../src/job.js";
import { afterLocalJob, GitSource, LocalCodeError, localPrFiles, prepareLocalJob, remoteUrl, resolveLocalCode, splitPatches, type LocalCodeOptions } from "../src/localcode.js";
import { runLoop } from "../src/run.js";
import { captureLog, FakeWorker, makeFakeClaude, tmp, tok, writeCfg } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();

const SENTINEL = "LOCAL_DIFF_SENTINEL_5e1f";
/** Built at runtime so the repo's own secret rule never sees a literal key. */
const FAKE_AWS = "AKIA" + "Q7ZK3M9TXB2WPD4N";
/** A real git repo at <root>/acme/app.git (served over file://) with main, a feature branch and a later main commit. */
function makeOrigin() {
  const root = tmp("mjr-origin-");
  const dir = join(root, "acme", "app.git");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "uploadpack.allowFilter", "true");
  git(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  const put = (p: string, t: string) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), t); };
  put("src/a.ts", "export function compute(x: number) {\n  return x + 1;\n}\n");
  put("src/b.ts", 'import { compute } from "./a";\nexport const useIt = () => compute(41);\n');
  put("README.md", "# app\n");
  put("POLICY.md", "Be strict about POLICY_SENTINEL.\n");
  put("BIG.md", "A".repeat(27_000));
  put("MID.md", "B".repeat(5_400));
  put("dist/bundle.js", "var generated = 1;\n");
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "init");
  const base0 = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "feature");
  put("src/a.ts", `export function compute(x: number) {\n  const t = "${SENTINEL}";\n  return x + 2;\n}\n`);
  put("src/c.ts", 'import { compute } from "./a";\nexport const c = compute(1);\n');
  put("dist/bundle.js", `var generated = 2;\nvar k = "${FAKE_AWS}"; // diff_exclude'd: no patch reaches the review, only the local secret scan sees it\n`);
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "feature");
  const head = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  const advance = (file: string, text: string) => { put(file, text); git(dir, "add", "-A"); git(dir, "commit", "-qm", `touch ${file}`); return git(dir, "rev-parse", "HEAD"); };
  return { root, dir, base0, head, advance, template: `file://${root}/{owner}/{repo}.git` };
}

let home: string;
let o: LocalCodeOptions;
const logs: string[] = [];
let origin: ReturnType<typeof makeOrigin>;
beforeEach(() => {
  origin = makeOrigin();
  home = tmp("mjr-home-");
  logs.length = 0;
  o = resolveLocalCode({ MERGEJUDGE_HOME: home, PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }, { remoteUrlTemplate: origin.template });
});
afterEach(() => { /* temp dirs live in os.tmpdir() */ });

const cfgOf = (extra = "") => parseConfig(`policy_files: [POLICY.md]\n${extra}`);
const input = (over: Record<string, unknown> = {}) => ({ owner: "acme", repo: "app", prNumber: 5, baseSha: origin.base0, headSha: origin.head, cfg: cfgOf("diff_exclude: ['dist/**']\n"), cfgRef: origin.base0, ...over });

describe("settings and paths", () => {
  it("MERGEJUDGE_HOME moves the cache; defaults are ~/.mergejudge, 5 GB, 3 snapshots", () => {
    expect(cachePaths({ MERGEJUDGE_HOME: "/x/mj" }, "/h").idx).toBe("/x/mj/idx");
    expect(cachePaths({}, "/h").repos).toBe("/h/.mergejudge/repos");
    expect(DEFAULT_CACHE).toMatchObject({ maxBytes: 5 * 1024 ** 3, keepSnapshots: 3 });
    expect(cachePolicyFromEnv({ MERGEJUDGE_CACHE_MAX_GB: "0.5", MERGEJUDGE_CACHE_KEEP_SNAPSHOTS: "2", MERGEJUDGE_CACHE_MAX_AGE_DAYS: "7" })).toMatchObject({ maxBytes: 0.5 * 1024 ** 3, keepSnapshots: 2, maxAgeMs: 7 * 86_400_000 });
    expect(cachePolicyFromEnv({ MERGEJUDGE_CACHE_MAX_GB: "junk" })).toEqual(DEFAULT_CACHE);
  });
  it("remote template: default github, file/env/flag precedence, validated names", () => {
    expect(resolveLocalCode({}).remoteTemplate).toBe("https://github.com/{owner}/{repo}.git");
    expect(resolveLocalCode({ MERGEJUDGE_REMOTE_URL_TEMPLATE: "git@h:{owner}/{repo}" }, { remoteUrlTemplate: "https://f/{owner}/{repo}" }).remoteTemplate).toBe("git@h:{owner}/{repo}");
    expect(resolveLocalCode({ MERGEJUDGE_REMOTE_URL_TEMPLATE: "e/{owner}/{repo}" }, {}, { remoteUrlTemplate: "flag/{owner}/{repo}" }).remoteTemplate).toBe("flag/{owner}/{repo}");
    expect(() => resolveLocalCode({}, { remoteUrlTemplate: "https://x/fixed.git" })).toThrow(LocalCodeError);
    expect(remoteUrl("https://github.com/{owner}/{repo}.git", "acme", "app")).toBe("https://github.com/acme/app.git");
    for (const bad of [["..", "x"], ["a", "../b"], ["-x", "y"], ["a/b", "c"]]) expect(() => remoteUrl("u/{owner}/{repo}", bad[0]!, bad[1]!)).toThrow(LocalCodeError);
  });
  it("flags beat env for the cache size", () => {
    const x = resolveLocalCode({ MERGEJUDGE_CACHE_MAX_GB: "9" }, { cacheMaxGb: 3 }, { cacheMaxGb: 1 });
    expect(x.policy.maxBytes).toBe(1024 ** 3);
    expect(resolveLocalCode({}, { cacheMaxGb: 3, keepSnapshots: 5 }).policy).toMatchObject({ maxBytes: 3 * 1024 ** 3, keepSnapshots: 5 });
  });
});

describe("patch splitting", () => {
  it("returns GitHub-style patches per path, skips binary, follows renames", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts", "index 1..2 100644", "--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-a", "+b",
      "diff --git a/img.png b/img.png", "index 1..2 100644", "Binary files a/img.png and b/img.png differ",
      "diff --git a/old.ts b/new.ts", "similarity index 90%", "rename from old.ts", "rename to new.ts", "--- a/old.ts", "+++ b/new.ts", "@@ -1 +1 @@", "-1", "+2", "",
    ].join("\n");
    const m = splitPatches(diff);
    expect([...m.keys()]).toEqual(["x.ts", "new.ts"]);
    expect(m.get("x.ts")).toBe("@@ -1 +1 @@\n-a\n+b");
  });
});

describe("local clone and diff", () => {
  it("clones partially, fetches the SHAs, computes the PR files with patches (diff_exclude respected)", async () => {
    const data = await prepareLocalJob(o, input(), (m) => logs.push(m));
    const byPath = Object.fromEntries(data.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(["dist/bundle.js", "src/a.ts", "src/c.ts"]);
    expect(byPath["src/a.ts"]).toMatchObject({ status: "modified", additions: 2, deletions: 1 });
    expect(byPath["src/a.ts"]!.patch).toContain(SENTINEL);
    expect(byPath["src/c.ts"]!.status).toBe("added");
    expect(byPath["dist/bundle.js"]!.patch).toBeUndefined(); // diff_exclude: listed, no patch
    const clone = join(home, "repos", "acme__app.git");
    expect(existsSync(join(clone, "HEAD"))).toBe(true);
    expect(git(clone, "config", "remote.origin.partialclonefilter")).toBe("blob:none");
    expect(data.policyFiles["POLICY.md"]).toContain("POLICY_SENTINEL");
    // blobs were fetched in bulk (present without any lazy fetch), not just on demand
    expect(execFileSync("git", ["cat-file", "-e", `${origin.base0}:src/b.ts`], { cwd: clone, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } }).length).toBe(0);
  });

  it("big policy files both reach the runner, and loadPolicies there reports the cut", async () => {
    const cfg = parseConfig("policy_files: [BIG.md, MID.md]\n");
    const data = await prepareLocalJob(o, input({ cfg }), () => {});
    expect(Object.keys(data.policyFiles)).toEqual(["BIG.md", "MID.md"]);
    expect(data.policyFiles["BIG.md"]!.length).toBe(8 * 1024 + 1);
    const p = await loadPolicies(cfg.policy_files, async (x) => data.policyFiles[x] ?? null, { each: cfg.policy.max_each_bytes, total: cfg.policy.max_total_bytes });
    expect(p.used).toEqual([{ path: "BIG.md", truncated: true }, { path: "MID.md", truncated: true }]);
    expect(p.skipped).toEqual([]);
  });

  it("retrieves callers/importers from the index of the local clone", async () => {
    const data = await prepareLocalJob(o, input(), () => {});
    const paths = data.pieces.map((p) => p.path);
    expect(paths).toEqual(expect.arrayContaining(["src/a.ts", "src/b.ts"]));
    expect(data.pieces.find((p) => p.path === "src/b.ts")!.content).toContain("compute(41)");
  });

  it("a second job reuses the clone and snapshot; a newer base is brought up incrementally", async () => {
    await prepareLocalJob(o, input(), () => {});
    const store = new SnapshotStore(join(home, "idx", "acme__app"));
    expect(store.latestSha()).toBe(origin.base0);
    expect(Object.keys(store.latest()!.files).sort()).toEqual(["src/a.ts", "src/b.ts"]); // README/POLICY/dist are not indexable code
    const again = await prepareLocalJob(o, input(), () => {});
    expect(again.notes.join()).toMatch(/reused/);
    const base1 = origin.advance("src/d.ts", "export const d = 1;\n");
    // feature head still has base0 as merge-base; the job's base is the new main tip
    const inc = await prepareLocalJob(o, input({ baseSha: base1 }), () => {});
    expect(inc.notes.join()).toMatch(/incrementally from .*\(1 changed file/);
    const snap = store.latest()!;
    expect(snap.sha).toBe(base1);
    expect(Object.keys(snap.files)).toContain("src/d.ts");
    expect(store.list().map((s) => s.sha).sort()).toEqual([base1, origin.base0].sort());
  });

  it("builds without a 300-file cap", async () => {
    for (let i = 0; i < 350; i++) writeFileSync(join(origin.dir, `m${i}.ts`), `export const v${i} = ${i};\n`);
    git(origin.dir, "add", "-A"); git(origin.dir, "commit", "-qm", "many");
    const base = git(origin.dir, "rev-parse", "HEAD");
    await prepareLocalJob(o, input({ baseSha: base }), () => {});
    const snap = new SnapshotStore(join(home, "idx", "acme__app")).latest()!;
    expect(Object.keys(snap.files).length).toBe(352);
    expect(snap.partial).toBeUndefined();
  });

  it("fails with an explicit, actionable message when git cannot reach the repo (never a diff-only review)", async () => {
    const bad = resolveLocalCode({ MERGEJUDGE_HOME: home, PATH: process.env.PATH, HOME: home }, { remoteUrlTemplate: `file://${origin.root}/nope/{owner}/{repo}.git` });
    await expect(prepareLocalJob(bad, input(), () => {})).rejects.toThrow(/cannot read acme\/app with this runner's own git access.*credential helper/);
    expect(existsSync(join(home, "repos", "acme__app.git"))).toBe(false); // no half clone left behind
  });

  it("fails clearly for a commit the remote does not have", async () => {
    await expect(prepareLocalJob(o, input({ headSha: "1".repeat(40) }), () => {})).rejects.toThrow(LocalCodeError);
  });

  it("GitSource lists and reads blobs from a commit, and returns null for binary/missing", async () => {
    await prepareLocalJob(o, input(), () => {});
    writeFileSync(join(origin.dir, "bin.dat"), Buffer.from([0, 1, 2, 0]));
    git(origin.dir, "add", "-A"); git(origin.dir, "commit", "-qm", "bin");
    const sha = git(origin.dir, "rev-parse", "HEAD");
    const clone = join(home, "repos", "acme__app.git");
    git(clone, "fetch", "-q", "--filter=blob:none", "origin", `+${sha}:refs/mj/${sha}`);
    const src = new GitSource(clone, sha, o.env, o.limits);
    try {
      const paths = await src.listPaths();
      expect(paths).toEqual(expect.arrayContaining(["src/a.ts", "bin.dat"]));
      expect(await src.readFile("src/b.ts")).toContain("compute(41)");
      expect(await src.readFile("bin.dat")).toBeNull();
      expect(await src.readFile("nope.ts")).toBeNull();
      expect((await buildIndex(src, { repo: "acme/app", sha }, o.limits)).complete).toBe(true);
    } finally { src.close(); }
    const files = await localPrFiles(clone, origin.base0, origin.head, { diff_exclude: [] }, o.env);
    expect(files.find((f) => f.path === "dist/bundle.js")!.patch).toContain("generated = 2");
  });

  it("afterLocalJob drops pins nobody needs, keeps the snapshot commit pinned", async () => {
    await prepareLocalJob(o, input(), () => {});
    const clone = join(home, "repos", "acme__app.git");
    expect(git(clone, "for-each-ref", "refs/mj/").split("\n").length).toBe(2);
    await afterLocalJob(o, "acme", "app", () => {});
    expect(git(clone, "for-each-ref", "--format=%(refname)", "refs/mj/")).toBe(`refs/mj/${origin.base0}`);
  });
});

describe("cache cleanup", () => {
  const seedRepo = (p: ReturnType<typeof cachePaths>, key: string, bytes: number, usedAgoMs: number, snaps = 0) => {
    mkdirSync(join(p.repos, `${key}.git`), { recursive: true });
    writeFileSync(join(p.repos, `${key}.git`, "pack"), Buffer.alloc(bytes));
    touchRepo(p, key, Date.now() - usedAgoMs);
    const store = new SnapshotStore(join(p.idx, key));
    for (let i = 0; i < snaps; i++) {
      const sha = (i + 1).toString(16).padStart(40, "0");
      store.put({ v: 1, repo: key, sha, createdAt: "", files: {} });
      const t = new Date(Date.now() - (snaps - i) * 1000);
      utimesSync(join(p.idx, key, `${sha}.json`), t, t);
    }
  };
  const DAY = 86_400_000;

  it("keeps the newest N snapshots per repo and always the latest one", () => {
    const p = cachePaths({ MERGEJUDGE_HOME: home });
    seedRepo(p, "o__r", 10, 0, 5);
    const res = cleanupCache(p, { ...DEFAULT_CACHE, keepSnapshots: 3 });
    expect(res.prunedSnapshots).toBe(2);
    expect(new SnapshotStore(join(p.idx, "o__r")).list()).toHaveLength(3);
    expect(new SnapshotStore(join(p.idx, "o__r")).latest()).not.toBeNull();
  });
  it("evicts repos untouched for longer than the max age", () => {
    const p = cachePaths({ MERGEJUDGE_HOME: home });
    seedRepo(p, "o__old", 10, 40 * DAY); seedRepo(p, "o__new", 10, 1 * DAY);
    const res = cleanupCache(p, { ...DEFAULT_CACHE, maxAgeMs: 30 * DAY });
    expect(res.evicted).toEqual([{ key: "o__old", reason: "age" }]);
    expect(existsSync(join(p.repos, "o__old.git"))).toBe(false);
    expect(existsSync(join(p.idx, "o__old"))).toBe(false);
    expect(existsSync(join(p.repos, "o__new.git"))).toBe(true);
  });
  it("over the size limit: evicts least recently used first, never a repo in use", () => {
    const p = cachePaths({ MERGEJUDGE_HOME: home });
    seedRepo(p, "o__a", 1000, 3 * DAY); seedRepo(p, "o__b", 1000, 2 * DAY); seedRepo(p, "o__c", 1000, 1 * DAY);
    const res = cleanupCache(p, { ...DEFAULT_CACHE, maxBytes: 2500 }, new Set(["o__a"]));
    expect(res.evicted).toEqual([{ key: "o__b", reason: "size" }]);
    expect(readdirSync(p.repos).sort()).toEqual(["o__a.git", "o__c.git"]);
    expect(res.bytes).toBeLessThanOrEqual(2500 + 200);
  });
  it("a repo with a fresh lock from another process is left alone", () => {
    const p = cachePaths({ MERGEJUDGE_HOME: home });
    seedRepo(p, "o__locked", 1000, 90 * DAY);
    mkdirSync(join(p.locks, "o__locked.lock"), { recursive: true });
    expect(cleanupCache(p, { ...DEFAULT_CACHE, maxAgeMs: DAY }).evicted).toEqual([]);
  });
});

describe("repo lock", () => {
  it("serialises jobs on the same repo and lets different repos run together", async () => {
    const p = cachePaths({ MERGEJUDGE_HOME: home });
    const order: string[] = [];
    const task = (key: string, name: string) => withRepoLock(p, key, async () => { order.push(`${name}:in`); await new Promise((r) => setTimeout(r, 60)); order.push(`${name}:out`); });
    await Promise.all([task("o__r", "a"), task("o__r", "b"), task("o__s", "c")]);
    expect(order.indexOf("a:out")).toBeLessThan(order.indexOf("b:in"));
    expect(order.indexOf("c:in")).toBeLessThan(order.indexOf("a:out"));
    expect(existsSync(join(p.locks, "o__r.lock"))).toBe(false);
  });
  it("a lock held by a crashed process (stale) is taken over", async () => {
    const p = cachePaths({ MERGEJUDGE_HOME: home });
    mkdirSync(join(p.locks, "o__r.lock"), { recursive: true });
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(join(p.locks, "o__r.lock"), old, old);
    expect(await withRepoLock(p, "o__r", async () => "ok")).toBe("ok");
  });
});

// ---------------------------------------------------------------- end to end
describe("end to end: runner job path against a real git repo (file:// remote, fake engine)", () => {
  let w: FakeWorker;
  let fc: ReturnType<typeof makeFakeClaude>;
  beforeEach(async () => { w = await new FakeWorker().start(); w.validAuth.add(tok("A")); fc = makeFakeClaude(); });
  afterEach(async () => { await w.stop(); });

  const localPayload = (): RunnerJobPayload => {
    const cfg = cfgOf("diff_exclude: ['dist/**']\nreview:\n  mode: deep\nrunner:\n  code_source: local\n");
    const files = [{ path: "src/a.ts", status: "modified", additions: 2, deletions: 1 }, { path: "src/c.ts", status: "added", additions: 2, deletions: 0 }];
    const agg = aggregate(files, [], cfg, null);
    return {
      v: 2, codeSource: "local", repo: { owner: "acme", repo: "app" },
      pr: { number: 5, title: "Change a", body: "body", author: "alice", labels: [], node_id: "PR_x", head: { sha: origin.head, ref: "feature" }, base: { sha: origin.base0, ref: "main" } },
      mode: "deep", cfg, cfgRef: origin.base0, files, policyFiles: {}, policy: { text: "", used: [{ path: "POLICY.md", truncated: false }] },
      rules: { lane: agg.lane, files: agg.files, labelReasons: agg.labelReasons, stripped: [] },
    } as unknown as RunnerJobPayload;
  };
  const jobOf = (payload: RunnerJobPayload) => ({
    status: 200 as const,
    body: {
      job: { id: "job1", repo: "acme/app", pr: 5, headSha: origin.head, baseSha: origin.base0, mode: "deep-local", attempt: 1, payload },
      lease: { id: "lease1", expiresAt: "2099-01-01T00:00:00Z", heartbeatEveryS: 15 },
    },
  });
  const env = () => ({ PATH: `${fc.dir}:${process.env.PATH}`, HOME: home, USER: "u", LANG: "C", MERGEJUDGE_HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
  const runOnce = async (local: LocalCodeOptions) => {
    const dir = tmp();
    const { path, cfg } = writeCfg(dir, w.url);
    const cap = captureLog();
    const code = await runLoop({
      cfg, configPath: path, log: cap.log, signal: new AbortController().signal, once: true, waitS: 1, heartbeatMs: 100,
      backoff: { baseMs: 1, maxMs: 5 }, shutdownGraceMs: 300, claude: { bin: fc.bin, env: env(), killGraceMs: 100 }, env: env(), local,
    });
    return { code, lines: cap.lines };
  };

  it("the payload carries no code, the runner clones, indexes, reviews and returns only the structured result", async () => {
    const payload = localPayload();
    const wire = JSON.stringify(payload);
    for (const needle of [SENTINEL, "compute(41)", "POLICY_SENTINEL"]) expect(wire).not.toContain(needle);
    w.polls.push(jobOf(payload));
    const { code, lines } = await runOnce(o);
    expect(code).toBe(0);
    // engine saw the locally computed diff, the policy read from the clone and the retrieved caller
    const prompt = fc.records()[0]!.stdin;
    expect(prompt).toContain(SENTINEL);
    expect(prompt).toContain("POLICY_SENTINEL");
    expect(prompt).toContain("compute(41)");
    expect(prompt).not.toContain("generated = 2"); // diff_exclude
    // result: valid, mode deep, structured only
    expect(w.validations).toEqual([{ ok: true }]);
    const res = w.of(/result/)[0]!.body.result;
    expect(res.usage.mode).toBe("deep");
    expect(res.findings[0]).toMatchObject({ path: "src/a.ts" });
    expect(w.nacks).toEqual([]);
    expect(w.of(/nack/)).toHaveLength(0);
    // persistent state on disk
    expect(existsSync(join(home, "repos", "acme__app.git", "HEAD"))).toBe(true);
    expect(new SnapshotStore(join(home, "idx", "acme__app")).latestSha()).toBe(origin.base0);
    expect(lines.join("\n")).not.toContain(SENTINEL);
  });

  it("a secret in a diff_exclude'd file (no patch anywhere) raises the file and the PR to block, without echoing the key", async () => {
    w.polls.push(jobOf(localPayload()));
    const { code, lines } = await runOnce(o);
    expect(code).toBe(0);
    expect(w.validations).toEqual([{ ok: true }]);
    const res = w.of(/result/)[0]!.body.result;
    expect(res.lane).toBe("block");
    expect(res.agg.lane).toBe("block");
    const f = res.agg.files.find((x: any) => x.path === "dist/bundle.js");
    expect(f.lane).toBe("block");
    expect(f.reasons).toContain("secret found in full local diff (runner): AWS access key");
    expect(res.body).toContain("full local diff");
    expect(res.body).toContain("Deep mode on a runner with a local clone"); // original note kept
    expect(JSON.stringify(res)).not.toContain(FAKE_AWS);
    expect(lines.join("\n")).not.toContain(FAKE_AWS);
    expect(fc.records()[0]!.stdin).not.toContain(FAKE_AWS);
  });

  it("an old-style (v1, worker-built) deep job is still handled by the same runner", async () => {
    const p = localPayload() as any;
    const v1 = { ...p, v: 1, codeSource: undefined, files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+OLD_STYLE_SENTINEL" }], policyFiles: {}, context: [{ path: "src/b.ts", kind: "caller", why: "uses a", content: "export const V1_PIECE = 1;", truncated: false }], deep: { ok: true, notes: ["worker-built"] } };
    w.polls.push({ ...jobOf(v1), body: { ...(jobOf(v1).body), job: { ...jobOf(v1).body.job, mode: "deep" } } });
    const { code } = await runOnce(o);
    expect(code).toBe(0);
    expect(fc.records()[0]!.stdin).toContain("V1_PIECE");
    expect(existsSync(join(home, "repos"))).toBe(false); // no clone for the old path
    expect(w.validations).toEqual([{ ok: true }]);
  });

  it("git access failure: the job is nacked with an explicit reason, the engine never runs", async () => {
    const bad = resolveLocalCode(env(), { remoteUrlTemplate: `file://${origin.root}/missing/{owner}/{repo}.git` });
    w.polls.push(jobOf(localPayload()));
    const { code } = await runOnce(bad);
    expect(code).toBe(0);
    const nack = w.of(/nack/);
    expect(nack).toHaveLength(1);
    expect(nack[0]!.body.reason).toMatch(/cannot read acme\/app with this runner's own git access/);
    expect(nack[0]!.body.code).toBeUndefined(); // a failure, not "unsupported"
    expect(fc.records()).toHaveLength(0);
    expect(w.of(/result/)).toHaveLength(0);
  });

  it("produceResult directly: a payload version it does not know is nacked", async () => {
    const bad = { ...localPayload(), v: 3 } as unknown as RunnerJobPayload;
    await expect(produceResult({ id: "j", repo: "acme/app", pr: 5, headSha: origin.head, baseSha: origin.base0, mode: "deep-local", attempt: 1, payload: bad }, new AbortController().signal, captureLog().log, { caps: [], options: () => ({}) })).rejects.toThrow(/unsupported job payload/);
  });

  it("registers and announces the local-code feature", async () => {
    const { code } = await runOnce(o);
    expect(code).toBe(0);
    const hb = w.of(/^\/heartbeat$/)[0]!;
    expect(hb.body.features).toEqual(["local-code"]);
    expect(hb.body.version).toBe("0.4.7");
  });
});
