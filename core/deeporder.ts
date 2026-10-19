import { changedSymbols, localImports, resolveImport } from "./context.js";
import { patchLiterals } from "./deepretrieve.js";
import type { IndexLimits, IndexSource } from "./deepindex.js";

/**
 * Relevance order for a size-capped index build: given the files a PR changed ("seeds"), decide which files to read first.
 * Pure ordering and bounded reading; the caller turns the texts into index entries. Stages, each de-duplicated:
 *   a. the changed files themselves
 *   b. importers of a changed file in the changed directories, then the local imports of the changed files
 *      (read order: the imports first, then the sibling probe that finds the importers, so a big directory cannot use up
 *      the budget before the imports are read; the resulting order lists importers first)
 *   c. the other indexable files in the changed directories
 *   d. files of the parent directories, closest first (package modules such as `__init__.py` / `index.*` before the rest)
 *   e. files found for changed identifiers, strings and env var names (code search if the source has it, else a path heuristic)
 *   f. everything else, in tree order
 * Stages a-e are the "related" files. Every read counts against the same caps (files, bytes, wall time) as an unseeded build.
 */

/** A file the PR changed. `patch` (optional) is used to find changed identifiers and literals. */
export interface SeedFile { path: string; patch?: string }
export interface Seeds { files: SeedFile[] }

export type StopKind = "size" | "time" | "files";

/** Same-directory files read to look for importers (the probe also feeds stage c, so nothing is read twice). */
export const SIBLING_PROBE_CAP = 100;
/** Files taken from one parent directory. */
export const PARENT_DIR_CAP = 40;
/** Code-search queries per build. */
export const MAX_SEARCH_QUERIES = 4;
/** Results kept per search query. */
export const MAX_SEARCH_RESULTS = 10;
/** Time allowed for one search call (ms). */
export const SEARCH_TIMEOUT_MS = 4_000;
/** Paths picked by the path heuristic. */
export const MAX_HEURISTIC_FILES = 30;
const PREFETCH_SLICE = 500;

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.split("/").pop()!.replace(/\.[^.]+$/, "");
const norm = (s: string) => s.toLowerCase().replace(/[_\-.]/g, "");
/** Path names too common to say anything about an identifier that merely contains them. */
const GENERIC_NAMES = new Set(["helpers", "utils", "common", "config", "components", "models", "tests", "const", "constants", "types", "services", "handlers"]);
const PKG_FILE = /(?:^|\/)(?:__init__\.py|index\.[^/]+)$/;

/** Python absolute imports (`from pkg.mod import x`, `import pkg.mod`) that resolve to a file in the tree: `pkg/mod.py`, `pkg/mod/__init__.py`, `pkg/mod/x.py`. Used for ordering only. */
export function pythonAbsoluteImports(text: string, paths: Set<string>): string[] {
  const out = new Set<string>();
  const tryModule = (mod: string) => {
    const rel = mod.replace(/\./g, "/");
    for (const root of ["", "src/"]) for (const c of [`${root}${rel}.py`, `${root}${rel}/__init__.py`]) if (paths.has(c)) out.add(c);
  };
  for (const m of text.matchAll(/^[ \t]*from[ \t]+([A-Za-z_][\w.]*)[ \t]+import[ \t]+([^\n#]+)/gm)) {
    tryModule(m[1]!);
    for (const n of m[2]!.replace(/[()]/g, "").split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!).filter((s) => /^[A-Za-z_]\w*$/.test(s)).slice(0, 20)) tryModule(`${m[1]}.${n}`);
  }
  for (const m of text.matchAll(/^[ \t]*import[ \t]+([A-Za-z_][\w., \t]*)/gm)) {
    for (const mod of m[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!).filter((s) => /^[A-Za-z_][\w.]*$/.test(s)).slice(0, 10)) tryModule(mod);
  }
  return [...out];
}

/** Files `path` imports that exist in the tree: relative imports as retrieval resolves them, plus Python absolute imports. */
export function importTargets(path: string, text: string, paths: Set<string>): string[] {
  const out = new Set<string>();
  for (const spec of localImports(path, text)) {
    const t = resolveImport(path, spec, paths);
    if (t) out.add(t);
  }
  if (path.endsWith(".py")) for (const t of pythonAbsoluteImports(text, paths)) out.add(t);
  out.delete(path);
  return [...out];
}

/** Names worth looking for, most useful first: changed symbols, env var names, then other distinctive literals. */
export function seedIdentifiers(seeds: Seeds): string[] {
  const symbols = [...new Set(seeds.files.flatMap((f) => changedSymbols(f.patch)))];
  const lits = seeds.files.flatMap((f) => patchLiterals(f.patch, 6));
  const ident = (t: string) => /^[A-Za-z_]\w{3,}$/.test(t);
  const env = [...new Set(lits.filter((l) => l.kind === "env").map((l) => l.text))];
  const other = [...new Set(lits.filter((l) => l.kind !== "env" && ident(l.text)).map((l) => l.text))];
  return [...new Set([...symbols.slice(0, 2), ...env, ...symbols.slice(2), ...other])].slice(0, 12);
}

/** Paths whose file name or a directory name contains the identifier (snake_case / camelCase / kebab-case compare equal). */
export function heuristicPaths(ids: string[], cands: string[], skip: Set<string>, max = MAX_HEURISTIC_FILES): string[] {
  const wanted = [...new Set(ids.map(norm))].filter((n) => n.length >= 4);
  if (!wanted.length) return [];
  const exact: string[] = [], partial: string[] = [];
  for (const p of cands) {
    if (skip.has(p)) continue;
    const base = norm(baseOf(p));
    const dirs = dirOf(p).split("/").map(norm);
    if (wanted.some((w) => base === w)) exact.push(p);
    else if (wanted.some((w) => base.includes(w) || dirs.some((d) => d.includes(w)) || [base, ...dirs].some((t) => t.length >= 6 && !GENERIC_NAMES.has(t) && w.includes(t)))) partial.push(p);
  }
  return [...exact, ...partial].slice(0, max);
}

export interface SeededRead {
  /** Paths in relevance order (read, or attempted). */
  order: string[];
  texts: Map<string, string | null>;
  /** How many leading entries of `order` belong to stages a-e. */
  relatedEnd: number;
  /** Seed paths that exist in the tree and are indexable. */
  seedPaths: string[];
  stopped?: { kind: StopKind; reason: string };
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => new Promise<T>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`search timed out after ${ms} ms`)), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

/**
 * Read the candidate files in relevance order within the caps. `cands` are the indexable tree paths in tree order,
 * `all` every path of the tree. Never throws on a failing read or search.
 */
export async function readInRelevanceOrder(
  src: IndexSource, all: string[], cands: string[], seeds: Seeds, lim: IndexLimits, now: () => number,
  isIndexable: (p: string) => boolean,
): Promise<SeededRead> {
  const pathSet = new Set(all);
  const candSet = new Set(cands);
  const texts = new Map<string, string | null>();
  const order: string[] = [];
  const emitted = new Set<string>();
  const start = now();
  let bytes = 0, attempted = 0;
  let stopped: SeededRead["stopped"];
  const stop = (kind: StopKind, reason: string) => { stopped ??= { kind, reason }; };
  const timeUp = () => now() - start > lim.maxMs;
  const sizeUp = () => bytes > lim.maxTotalBytes;

  const read = async (paths: string[]): Promise<void> => {
    const todo = [...new Set(paths)].filter((p) => candSet.has(p) && !texts.has(p));
    for (let i = 0; i < todo.length && !stopped;) {
      if (timeUp()) return stop("time", `time budget ${lim.maxMs} ms reached`);
      if (sizeUp()) return stop("size", `size budget ${lim.maxTotalBytes} bytes reached`);
      if (attempted >= lim.maxFiles) return stop("files", `file cap ${lim.maxFiles} reached (${cands.length} indexable files)`);
      const slice = todo.slice(i, i + Math.min(PREFETCH_SLICE, lim.maxFiles - attempted));
      await src.prefetch?.(slice).catch(() => {});
      for (let j = 0; j < slice.length && !stopped; j += lim.concurrency) {
        if (timeUp()) return stop("time", `time budget ${lim.maxMs} ms reached`);
        if (sizeUp()) return stop("size", `size budget ${lim.maxTotalBytes} bytes reached`);
        const batch = slice.slice(j, j + lim.concurrency);
        const got = await Promise.all(batch.map((p) => src.readFile(p).catch(() => null)));
        batch.forEach((p, k) => { texts.set(p, got[k] ?? null); bytes += got[k]?.length ?? 0; attempted++; });
      }
      i += slice.length;
    }
  };
  const emit = (paths: string[]) => {
    for (const p of paths) if (texts.has(p) && !emitted.has(p)) { emitted.add(p); order.push(p); }
  };

  // a. changed files
  const seedPaths = [...new Set(seeds.files.map((f) => f.path))].filter((p) => candSet.has(p));
  const seedSet = new Set(seedPaths);
  await read(seedPaths);
  emit(seedPaths);

  const dirs = [...new Set(seeds.files.map((f) => dirOf(f.path)))];
  const byDir = new Map<string, string[]>();
  for (const p of cands) { const d = dirOf(p); const l = byDir.get(d); if (l) l.push(p); else byDir.set(d, [p]); }
  const siblings = [...new Set(dirs.flatMap((d) => byDir.get(d) ?? []))].filter((p) => !seedSet.has(p));

  // b. the imports of the changed files are READ first (few, and often the most useful), then a bounded probe of
  // same-directory siblings finds the importers. In `order`, importers still come before imports.
  const imports = [...new Set(seedPaths.flatMap((p) => { const t = texts.get(p); return typeof t === "string" ? importTargets(p, t, pathSet) : []; }))]
    .filter((p) => candSet.has(p));
  await read(imports);
  const probe = siblings.slice(0, SIBLING_PROBE_CAP);
  await read(probe);
  const importers = probe.filter((p) => {
    const t = texts.get(p);
    return typeof t === "string" && importTargets(p, t, pathSet).some((x) => seedSet.has(x));
  });
  emit(importers);
  emit(imports);

  // c. other files in the changed directories
  await read(siblings);
  emit(siblings);

  // d. parent directories, closest first
  const pkgFirst = (a: string, b: string) => Number(PKG_FILE.test(b)) - Number(PKG_FILE.test(a));
  const parents: string[] = [];
  const parentSeen = new Set<string>();
  const maxUp = Math.max(0, ...dirs.map((d) => (d ? d.split("/").length : 0)));
  for (let up = 1; up <= maxUp && parents.length < 4_000; up++) {
    for (const d of dirs) {
      const parts = d ? d.split("/") : [];
      if (parts.length < up) continue;
      const pd = parts.slice(0, parts.length - up).join("/");
      if (parentSeen.has(pd)) continue;
      parentSeen.add(pd);
      parents.push(...(byDir.get(pd) ?? []).slice().sort(pkgFirst).slice(0, PARENT_DIR_CAP));
    }
  }
  await read(parents);
  emit(parents);

  // e. files for changed identifiers / literals: code search if the source has it, else a path heuristic
  if (!stopped) {
    const ids = seedIdentifiers(seeds);
    let found: string[] = [];
    let searchOk = !!src.searchSymbol && ids.length > 0;
    if (src.searchSymbol && ids.length) {
      for (const q of ids.slice(0, MAX_SEARCH_QUERIES)) {
        const left = lim.maxMs - (now() - start);
        if (left <= 0) { stop("time", `time budget ${lim.maxMs} ms reached`); break; }
        try {
          const hits = await withTimeout(src.searchSymbol(q), Math.min(SEARCH_TIMEOUT_MS, left));
          found.push(...hits.filter((h) => pathSet.has(h) && isIndexable(h)).slice(0, MAX_SEARCH_RESULTS));
        } catch { searchOk = false; break; } // 403 / 422 / rate limit / timeout: no more queries, use paths instead
      }
    }
    if (!stopped && (!searchOk || !found.length)) found = heuristicPaths(ids, cands, new Set(texts.keys()));
    found = [...new Set(found)];
    await read(found);
    emit(found);
  }
  const relatedEnd = order.length;

  // f. everything else, in tree order
  await read(cands);
  emit(cands);
  return { order, texts, relatedEnd, seedPaths, stopped };
}
