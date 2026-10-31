import { validateStory } from "../core/story.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregate } from "../core/aggregate.js";
import { parseConfig } from "../core/config.js";
import type { ReviewResult } from "../core/review.js";
import { applyRunnerSecretHits, SCAN_LIMITS, scanLocalDiff } from "../src/secretscan.js";
import { tmp } from "./helpers.js";

const ENV = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
// Built at runtime: the repo's own secret rule must not see a literal key.
const REAL_AWS = "AKIA" + "Q7ZK3M9TXB2WPD4N";
const DOC_AWS = "AKIAIOSFODNN7" + "EXAMPLE";

/** base commit, then a head commit that adds `files`. */
function repo(files: Record<string, string>) {
  const dir = tmp("mjr-scan-");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# x\n");
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD");
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), t); }
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "head");
  return { dir, base, head: git(dir, "rev-parse", "HEAD") };
}
const quiet = () => { const lines: string[] = []; return { lines, log: (m: string) => lines.push(m) }; };

describe("scanLocalDiff", () => {
  it("finds a real-looking key in a file, names the pattern, never returns the value", async () => {
    const r = repo({ "vendor/big.js": `var k = "${REAL_AWS}";\n`, "src/ok.ts": "export const a = 1;\n" });
    const q = quiet();
    const s = await scanLocalDiff(r.dir, r.base, r.head, r.head, ENV, q.log);
    expect([...s.hits]).toEqual([["vendor/big.js", ["AWS access key"]]]);
    expect(s.scanned).toBe(2);
    expect(JSON.stringify([...s.hits]) + q.lines.join("\n")).not.toContain(REAL_AWS);
  });
  it("placeholder keys are not hits (same skip rules as the Worker)", async () => {
    const r = repo({ "a.txt": `k=${DOC_AWS}\nj=AKIA${"X".repeat(16)}\n` });
    const s = await scanLocalDiff(r.dir, r.base, r.head, r.head, ENV, quiet().log);
    expect(s.hits.size).toBe(0);
  });
  it("only added lines count", async () => {
    const r = repo({ "a.txt": `${REAL_AWS}\n` });
    writeFileSync(join(r.dir, "a.txt"), "clean\n");
    git(r.dir, "commit", "-qam", "remove");
    const head2 = git(r.dir, "rev-parse", "HEAD");
    expect((await scanLocalDiff(r.dir, r.base, head2, head2, ENV, quiet().log)).hits.size).toBe(0);
  });
  it("skips (and logs) when the local head is not the job head", async () => {
    const r = repo({ "a.txt": `${REAL_AWS}\n` });
    const q = quiet();
    const s = await scanLocalDiff(r.dir, r.base, r.head, r.base, ENV, q.log);
    expect(s.hits.size).toBe(0);
    expect(s.skipped).toMatch(/head does not match/);
    expect(q.lines[0]).toMatch(/skipped/);
  });
  it("a git error is a skip, not a failure", async () => {
    const r = repo({ "a.txt": `${REAL_AWS}\n` });
    const s = await scanLocalDiff(r.dir, "0".repeat(40), r.head, r.head, ENV, quiet().log);
    expect(s.hits.size).toBe(0);
    expect(s.skipped).toMatch(/git error/);
    const s2 = await scanLocalDiff(join(r.dir, "nope"), r.base, r.head, r.head, ENV, quiet().log);
    expect(s2.skipped).toBeDefined();
  });
  it("binary files are not scanned", async () => {
    const r = repo({ "x.txt": "1\n" });
    r.base = r.head;
    writeFileSync(join(r.dir, "b.bin"), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(REAL_AWS)]));
    git(r.dir, "add", "-A"); git(r.dir, "commit", "-qm", "bin");
    const head = git(r.dir, "rev-parse", "HEAD");
    const s = await scanLocalDiff(r.dir, r.base, head, head, ENV, quiet().log);
    expect(s.hits.size).toBe(0);
    expect(s.scanned).toBe(0);
  });
  it("size caps: file count, bytes per file, and the per-file fallback for an oversize whole diff", async () => {
    const pad = "x".repeat(200) + "\n";
    const r = repo({ "a.txt": `${REAL_AWS}\n`, "late.txt": pad.repeat(50) + `${REAL_AWS}\n`, "z.txt": `${REAL_AWS}\n` });
    // file cap
    const capped = quiet();
    const c = await scanLocalDiff(r.dir, r.base, r.head, r.head, ENV, capped.log, undefined, { ...SCAN_LIMITS, maxFiles: 1 });
    expect(c.scanned).toBe(1);
    expect(capped.lines.join()).toMatch(/only the first 1 files/);
    // bytes per file: the key sits past the cut, so late.txt is not a hit
    const b = await scanLocalDiff(r.dir, r.base, r.head, r.head, ENV, quiet().log, undefined, { ...SCAN_LIMITS, maxBytesPerFile: 1000 });
    expect([...b.hits.keys()].sort()).toEqual(["a.txt", "z.txt"]);
    // whole-diff cap exceeded -> per-file diffs still find everything within the per-file cap
    const f = await scanLocalDiff(r.dir, r.base, r.head, r.head, ENV, quiet().log, undefined, { ...SCAN_LIMITS, maxDiffBytes: 100 });
    expect([...f.hits.keys()].sort()).toEqual(["a.txt", "late.txt", "z.txt"]);
    // a per-file diff over its cap is skipped for that file only
    const g = await scanLocalDiff(r.dir, r.base, r.head, r.head, ENV, quiet().log, undefined, { ...SCAN_LIMITS, maxDiffBytes: 100, maxFileDiffBytes: 500 });
    expect([...g.hits.keys()].sort()).toEqual(["a.txt", "z.txt"]);
    expect(g.skipped).toMatch(/too large/);
  });
});

describe("applyRunnerSecretHits", () => {
  const cfg = parseConfig("");
  const resultOf = (files: { path: string; additions: number; deletions: number; status: string; patch?: string }[]): ReviewResult => {
    const agg = aggregate(files, [], cfg, null);
    return { schemaVersion: 1, kind: "review", prNumber: 1, headSha: "h".repeat(40), prNodeId: "n", lane: agg.lane, agg, body: "old", findings: [], syncInline: false,
      usage: { lane: agg.lane, mode: "deep", model: "runner:x", cached: false, breakdown: null, tokens: 5 } } as ReviewResult;
  };
  it("raises a file with no patch and the PR to block, with a runner-scan reason that names no value", () => {
    const r = resultOf([{ path: "docs/a.md", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+hi" }, { path: "dist/v.js", status: "modified", additions: 1, deletions: 0 }]);
    expect(r.lane).toBe("review");
    expect(applyRunnerSecretHits(r, new Map([["dist/v.js", ["AWS access key"]]]))).toBe(1);
    expect(r.lane).toBe("block");
    expect(r.agg.lane).toBe("block");
    expect(r.usage.lane).toBe("block");
    const v = r.agg.files.find((f) => f.path === "dist/v.js")!;
    expect(v.lane).toBe("block");
    expect(v.reasons.at(-1)).toBe("secret found in full local diff (runner): AWS access key");
    expect(r.agg.files.find((f) => f.path === "docs/a.md")!.lane).toBe("auto");
    expect(r.body).toContain("full local diff");
    expect(r.agg.explanation?.reasons.some((x) => x.path === "dist/v.js")).toBe(true);
  });
  it("keeps the original notes when it re-renders the body, and adds the scan note", () => {
    const r = resultOf([{ path: "dist/v.js", status: "modified", additions: 1, deletions: 0 }]);
    applyRunnerSecretHits(r, new Map([["dist/v.js", ["AWS access key"]]]), { notes: ["Deep mode on a runner with a local clone: test note."] });
    expect(r.body).toContain("Deep mode on a runner with a local clone: test note.");
    expect(r.body).toContain("full local diff");
  });
  it("preserves the story, hosted URL and style when re-rendering", () => {
    const r = resultOf([{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }]);
    r.story = validateStory({ steps: ["Read the input", "Return the result"].map(title => ({ title, refs: [{ path: "a.ts" }] })) }, [{ path: "a.ts" }]);
    r.storyImageUrl = "https://example.com/story.svg"; r.storyStyle = "svg"; r.storyAnimate = false;
    applyRunnerSecretHits(r, new Map([["a.ts", ["test secret kind"]]]));
    expect(r.body).toContain('<img src="https://example.com/story.svg"');
    expect(r.body).toContain("<details><summary>Steps as text</summary>\n\n1. Read the input\n2. Return the result\n</details>");
  });
  it("does nothing without hits, and does not double-report a file the rules already blocked", () => {
    const r = resultOf([{ path: "a.ts", status: "modified", additions: 1, deletions: 0, patch: `@@ -1 +1 @@\n+k=${REAL_AWS}` }]);
    expect(r.lane).toBe("block");
    const before = JSON.stringify(r);
    expect(applyRunnerSecretHits(r, new Map())).toBe(0);
    expect(applyRunnerSecretHits(r, new Map([["a.ts", ["AWS access key"]]]))).toBe(0);
    expect(JSON.stringify(r)).toBe(before);
  });
});
