import { describe, expect, it } from "vitest";
import { buildIndex, INLINE_LIMITS, type IndexLimits, type IndexSource } from "../core/deepindex.js";
import { MIN_PARTIAL_RELATED_FILES, prepareDeepIndex, type DeepEnv } from "../core/deepsetup.js";
import { heuristicPaths, MAX_SEARCH_QUERIES, pythonAbsoluteImports } from "../core/deeporder.js";
import type { PrFile } from "../core/types.js";

/** In-memory repo; counts reads and searches. */
function repo(files: Record<string, string>, search?: (q: string) => Promise<string[]>) {
  const reads: string[] = [];
  const searches: string[] = [];
  const src: IndexSource = {
    listPaths: async () => Object.keys(files),
    readFile: async (p) => { reads.push(p); return files[p] ?? null; },
    ...(search ? { searchSymbol: async (q: string) => { searches.push(q); return search(q); } } : {}),
  };
  return { src, reads, searches };
}
const lim = (over: Partial<IndexLimits> = {}): IndexLimits => ({ ...INLINE_LIMITS, concurrency: 1, ...over });
const body = (s = "x") => `export const ${s} = 1;\n`;

const TREE: Record<string, string> = {
  "a0.ts": body("a0"), "a1.ts": body("a1"), "a2.ts": body("a2"),
  "pkg/__init__.py": "", "pkg/util.py": "def helper():\n    return 1\n",
  "pkg/sub/mod.py": "from pkg.util import helper\nfrom . import dep\n\ndef run():\n    return helper()\n",
  "pkg/sub/dep.py": "X = 1\n",
  "pkg/sub/user.py": "from pkg.sub.mod import run\n\ndef go():\n    run()\n",
  "pkg/sub/other.py": "Y = 2\n",
  "pkg/sub/a_first.py": "Z = 3\n",
  "other/deep/z.py": "Q = 1\n",
};
const SEEDS = { files: [{ path: "pkg/sub/mod.py" }] };

describe("relevance-ordered build", () => {
  it("without seeds the order is the tree order (shallow first, alphabetical), as before", async () => {
    const r = await buildIndex(repo(TREE).src, { repo: "o/r", sha: "s" }, lim());
    expect(Object.keys(r.snapshot!.files)).toEqual(["a0.ts", "a1.ts", "a2.ts", "pkg/__init__.py", "pkg/util.py", "other/deep/z.py", "pkg/sub/a_first.py", "pkg/sub/dep.py", "pkg/sub/mod.py", "pkg/sub/other.py", "pkg/sub/user.py"]);
    expect(r.complete).toBe(true);
    expect(r.related).toBeUndefined();
  });

  it("with seeds: changed file, importers, imports, siblings, parents, then the rest; each file once", async () => {
    const r = await buildIndex(repo(TREE).src, { repo: "o/r", sha: "s" }, lim(), Date.now, { seeds: SEEDS });
    const keys = Object.keys(r.snapshot!.files);
    expect(keys.slice(0, 1)).toEqual(["pkg/sub/mod.py"]); // a. changed
    expect(keys.slice(1, 2)).toEqual(["pkg/sub/user.py"]); // b. importer of the changed file (same dir)
    expect(keys.slice(2, 4)).toEqual(["pkg/util.py", "pkg/sub/dep.py"].sort((x, y) => keys.indexOf(x) - keys.indexOf(y))); // b. imports
    expect(keys.indexOf("pkg/util.py")).toBeLessThan(keys.indexOf("pkg/sub/a_first.py")); // imports before other siblings
    expect(keys.slice(4, 6).sort()).toEqual(["pkg/sub/a_first.py", "pkg/sub/other.py"]); // c. siblings
    expect(keys[6]).toBe("pkg/__init__.py"); // d. parent package file before other parent files
    expect(keys.slice(-4)).toContain("other/deep/z.py"); // f. the rest
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(11);
    expect(r.complete).toBe(true);
  });

  it("resolves Python absolute imports for ordering", () => {
    const paths = new Set(["pkg/util.py", "pkg/sub/__init__.py", "pkg/sub/mod.py"]);
    expect(pythonAbsoluteImports("from pkg.util import helper\nimport pkg.sub\nfrom pkg.sub import mod\nimport os\n", paths).sort())
      .toEqual(["pkg/sub/__init__.py", "pkg/sub/mod.py", "pkg/util.py"]);
  });

  it("a file cap keeps the related files and reports the file limit", async () => {
    const r = await buildIndex(repo(TREE).src, { repo: "o/r", sha: "s" }, lim({ maxFiles: 7 }), Date.now, { seeds: SEEDS });
    const keys = Object.keys(r.snapshot!.files);
    expect(keys).toHaveLength(7);
    expect(keys).toContain("pkg/sub/mod.py");
    expect(keys).not.toContain("other/deep/z.py");
    expect(r.complete).toBe(false);
    expect(r.limit).toBe("files");
    expect(r.snapshot!.partial).toMatchObject({ ordered: true, limit: "files" });
  });

  it("the unseeded file cap is unchanged (tree order) and now reports its limit", async () => {
    const r = await buildIndex(repo(TREE).src, { repo: "o/r", sha: "s" }, lim({ maxFiles: 3 }));
    expect(Object.keys(r.snapshot!.files)).toEqual(["a0.ts", "a1.ts", "a2.ts"]);
    expect(r.limit).toBe("files");
    expect(r.snapshot!.partial?.ordered).toBeUndefined();
  });

  it("a size cap stops reading and reports the size limit", async () => {
    const big: Record<string, string> = { "d/changed.ts": "export const c = 1;\n" + "// pad\n".repeat(200) };
    for (let i = 0; i < 20; i++) big[`d/s${i}.ts`] = "export const s = 1;\n" + "// pad\n".repeat(200);
    const r = await buildIndex(repo(big).src, { repo: "o/r", sha: "s" }, lim({ maxTotalBytes: 5_000 }), Date.now, { seeds: { files: [{ path: "d/changed.ts" }] } });
    expect(r.limit).toBe("size");
    expect(Object.keys(r.snapshot!.files)[0]).toBe("d/changed.ts");
    expect(Object.keys(r.snapshot!.files).length).toBeLessThan(21);
  });

  it("the time cap stops reading (fake clock) and search time counts against it", async () => {
    let t = 0;
    const now = () => t;
    const files: Record<string, string> = { "d/changed.ts": "export function widgetThing() {}\n" };
    for (let i = 0; i < 6; i++) files[`d/s${i}.ts`] = body(`s${i}`);
    const r1 = repo(files);
    const slowRead: IndexSource = { ...r1.src, readFile: async (p) => { t += 400; return r1.src.readFile(p); } };
    const a = await buildIndex(slowRead, { repo: "o/r", sha: "s" }, lim({ maxMs: 1_000 }), now, { seeds: { files: [{ path: "d/changed.ts" }] } });
    expect(a.limit).toBe("time");
    expect(Object.keys(a.snapshot!.files).length).toBeLessThan(7);

    t = 0;
    const patch = "@@ -0,0 +1 @@\n+export function widgetThing() {}";
    const r2 = repo({ "d/changed.ts": "export function widgetThing() {}\n", "z/consumer.ts": "widgetThing();\n" }, async () => { t += 2_000; return ["z/consumer.ts"]; });
    const b = await buildIndex(r2.src, { repo: "o/r", sha: "s" }, lim({ maxMs: 1_000 }), now, { seeds: { files: [{ path: "d/changed.ts", patch }] } });
    expect(b.limit).toBe("time"); // the search itself used up the budget
    expect(r2.searches.length).toBe(1);
  });
});

describe("search and path heuristic", () => {
  const files = {
    "src/changed.ts": "export function parseWidgetConfig() {}\n",
    "src/sibling.ts": body("sib"),
    "far/away/consumer.ts": "parseWidgetConfig();\n",
    "far/widget_config/loader.ts": body("loader"),
    "far/misc.ts": body("misc"),
  };
  const patch = "@@ -0,0 +1 @@\n+export function parseWidgetConfig() {}";
  const seeds = { files: [{ path: "src/changed.ts", patch }] };

  it("code search results (filtered to the tree) are read before unrelated files", async () => {
    const r = repo(files, async () => ["far/away/consumer.ts", "not/in/tree.ts", "README.md"]);
    const b = await buildIndex(r.src, { repo: "o/r", sha: "s" }, lim(), Date.now, { seeds });
    const keys = Object.keys(b.snapshot!.files);
    expect(keys.indexOf("far/away/consumer.ts")).toBeLessThan(keys.indexOf("far/misc.ts"));
    expect(keys).not.toContain("not/in/tree.ts");
    expect(r.searches).toEqual(["parseWidgetConfig"]);
  });

  it("a failing search (403 / rate limit) stops searching and falls back to the path heuristic", async () => {
    const r = repo(files, async () => { throw new Error("403 rate limit exceeded"); });
    const b = await buildIndex(r.src, { repo: "o/r", sha: "s" }, lim({ maxFiles: 4 }), Date.now, { seeds });
    const keys = Object.keys(b.snapshot!.files);
    expect(r.searches.length).toBe(1);
    expect(keys).toContain("far/widget_config/loader.ts"); // directory name widget_config is part of parseWidgetConfig
  });

  it("a source without search uses the heuristic", async () => {
    const b = await buildIndex(repo(files).src, { repo: "o/r", sha: "s" }, lim({ maxFiles: 3 }), Date.now, { seeds: { files: [{ path: "src/changed.ts", patch: "@@ -0,0 +1 @@\n+export function widget_config_loader() {}" }] } });
    expect(Object.keys(b.snapshot!.files)).toContain("far/widget_config/loader.ts");
  });

  it("heuristicPaths compares snake / camel / kebab spellings and ranks exact file names first", () => {
    const cands = ["a/other.ts", "a/widget-config.ts", "b/widgetConfigHelper.ts", "c/widget_config/x.ts", "d/y.ts"];
    expect(heuristicPaths(["widget_config"], cands, new Set())).toEqual(["a/widget-config.ts", "b/widgetConfigHelper.ts", "c/widget_config/x.ts"]);
    expect(heuristicPaths(["ab"], cands, new Set())).toEqual([]); // too short to mean anything
  });

  it("makes at most MAX_SEARCH_QUERIES search calls", async () => {
    const fns = Array.from({ length: 10 }, (_, i) => `export function changedName${i}() {}`).join("\n");
    const r = repo(files, async () => []);
    await buildIndex(r.src, { repo: "o/r", sha: "s" }, lim(), Date.now, { seeds: { files: [{ path: "src/changed.ts", patch: "@@ -0,0 +1 @@\n" + fns.split("\n").map((l) => "+" + l).join("\n") }] } });
    expect(r.searches.length).toBe(MAX_SEARCH_QUERIES);
  });
});

describe("prepareDeepIndex with a partial temporary index", () => {
  /** A big tree: 400 files of ~10 KB, so the 3 MB inline budget runs out before the 300-file cap, plus the PR's directory. */
  function bigRepo(extra: Record<string, string> = {}) {
    const files: Record<string, string> = { ...extra };
    const filler = "// filler line\n".repeat(700);
    for (let i = 0; i < 400; i++) files[`a/f${String(i).padStart(3, "0")}.ts`] = `export const f${i} = ${i};\n${filler}`;
    return files;
  }
  const changed: PrFile = { path: "deep/dir/feature.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+export const feature = 2;" };
  const env = (files: Record<string, string>, over: Partial<DeepEnv> = {}): DeepEnv => ({
    repoId: 1, installationId: 1, repoName: "o/r", policy: "none",
    base: repo(files).src, baseSha: "b".repeat(40), head: repo({ ...files, [changed.path]: "export const feature = 2;\n" }).src, headSha: "h".repeat(40), ...over,
  });

  it("uses the partial index when related files made it in, and says so", async () => {
    const files = bigRepo({ "deep/dir/feature.ts": "export const feature = 1;\n", "deep/dir/sib1.ts": body("s1"), "deep/dir/sib2.ts": body("s2"), "deep/index.ts": body("i") });
    const p = await prepareDeepIndex(env(files), [changed]);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.partial).toMatch(/^used a partial index \(\d+ files, most related first; (size|file) limit reached\)$/);
    expect(p.notes).toContain(p.partial);
    expect(p.snap.files["deep/dir/feature.ts"]).toBeDefined();
    expect(p.snap.files["deep/dir/sib1.ts"]).toBeDefined();
    expect(p.snap.files["deep/index.ts"]).toBeDefined();
  });

  it("a PR that only adds files can still use a partial index built from siblings and parents", async () => {
    const files = bigRepo({ "deep/dir/sib1.ts": body("s1"), "deep/dir/sib2.ts": body("s2"), "deep/index.ts": body("i") });
    const added: PrFile = { path: "deep/dir/new.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+export const n = 1;" };
    const p = await prepareDeepIndex(env(files), [added]);
    expect(p.ok).toBe(true);
  });

  it("falls back to context when too little related code could be indexed", async () => {
    const files = bigRepo({ "deep/dir/feature.ts": "export const feature = 1;\n" }); // only the changed file is related
    const p = await prepareDeepIndex(env(files), [changed]);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.reason).toMatch(/^repo too big for a temporary index \(.*(budget|cap).*; only 1 related file could be indexed\)$/);
    expect(MIN_PARTIAL_RELATED_FILES).toBe(3);
  });

  it("falls back when the changed files that exist at base could not be indexed", async () => {
    const files = bigRepo({ "deep/dir/feature.ts": "x".repeat(150_000), "deep/dir/sib1.ts": body("s1"), "deep/dir/sib2.ts": body("s2"), "deep/dir/sib3.ts": body("s3") });
    const p = await prepareDeepIndex(env(files), [changed]);
    expect(p.ok).toBe(false);
  });

  it("stored policy: partial is used and the queued build is noted", async () => {
    const files = bigRepo({ "deep/dir/feature.ts": "export const feature = 1;\n", "deep/dir/sib1.ts": body("s1"), "deep/dir/sib2.ts": body("s2") });
    let queued = 0;
    const store = { latest: async () => null } as unknown as DeepEnv["store"];
    const p = await prepareDeepIndex(env(files, { policy: "stored", store, enqueueIndex: async () => { queued++; } }), [changed]);
    expect(p.ok).toBe(true);
    expect(queued).toBe(1);
    if (p.ok) expect(p.notes).toContain("stored index build queued");
  });

  it("a complete build keeps the old note and no partial text", async () => {
    const p = await prepareDeepIndex(env({ "deep/dir/feature.ts": "export const feature = 1;\n" }), [changed]);
    expect(p.ok).toBe(true);
    if (p.ok) { expect(p.partial).toBeUndefined(); expect(p.notes[0]).toBe("temporary index built for this review; nothing stored"); }
  });
});
