import { localImports, resolveImport } from "./context.js";
import { readInRelevanceOrder, type Seeds, type StopKind } from "./deeporder.js";

export type { SeedFile, Seeds } from "./deeporder.js";

/**
 * Per-repo code index for `review.mode: deep`: symbol table, import graph and code chunks, built with
 * regexes (JS/TS and simple Python). Runtime-agnostic: files come from an IndexSource, snapshots are plain JSON.
 */

export interface SymbolDef {
  name: string;
  kind: "function" | "class" | "const" | "type";
  /** 1-based line of the definition. */
  line: number;
  exported: boolean;
}
export interface Chunk {
  /** `<path>#<n>`; stable across snapshots so vectors can be replaced in place. */
  id: string;
  /** 1-based inclusive line range. */
  start: number;
  end: number;
  text: string;
}
export interface FileEntry {
  size: number;
  symbols: SymbolDef[];
  /** Relative import specifiers as written; resolved against the file set when queried. */
  imports: string[];
  chunks: Chunk[];
}
export interface IndexSnapshot {
  v: 1;
  /** "<owner>/<repo>" */
  repo: string;
  sha: string;
  createdAt: string;
  files: Record<string, FileEntry>;
  /** Set when caps (files, bytes, time) stopped the build early. */
  partial?: {
    indexed: number; total: number; reason: string;
    /** Which cap stopped it. */
    limit?: StopKind;
    /** Built in relevance order for one PR (see BuildOptions.seeds): biased to that PR, so never store it for reuse by other PRs. */
    ordered?: boolean;
  };
  /** True once every chunk has an embedding in the vector store. */
  embedded?: boolean;
}

export interface IndexSource {
  listPaths(): Promise<string[] | null>;
  readFile(path: string): Promise<string | null>;
  /** Optional: warm the next `paths` (bulk fetch) just before they are read. */
  prefetch?(paths: string[]): Promise<void>;
  /** Optional: paths of files that mention `symbol` (GitHub code search). Used for relevance ordering only; may throw or be rate limited. */
  searchSymbol?(symbol: string): Promise<string[]>;
}

export interface IndexLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  /** Wall-time budget for reading files. */
  maxMs: number;
  chunkLines: number;
  maxChunksPerFile: number;
  /** Parallel file reads. */
  concurrency: number;
}
/** Bounded build inside a review. */
export const INLINE_LIMITS: IndexLimits = { maxFiles: 300, maxFileBytes: 100_000, maxTotalBytes: 3_000_000, maxMs: 20_000, chunkLines: 40, maxChunksPerFile: 60, concurrency: 8 };
/** Background index job (queue consumer). */
export const JOB_LIMITS: IndexLimits = { maxFiles: 2_000, maxFileBytes: 100_000, maxTotalBytes: 12_000_000, maxMs: 300_000, chunkLines: 40, maxChunksPerFile: 60, concurrency: 8 };

const CODE_EXT = /\.(?:[mc]?[jt]sx?|py)$/;
const CONFIG_EXT = /\.(?:json|ya?ml|toml)$/; // searchable text (config keys), no symbols
const SKIP_DIRS = /(?:^|\/)(?:node_modules|dist|build|out|coverage|vendor|\.git|\.next|__pycache__|\.venv|migrations)\//;
const SKIP_FILES = /(?:\.min\.|\.map$|\.d\.ts$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.env[^/]*|[^/]*\.pem|[^/]*\.key)$)/;

/** Files worth indexing. Never secrets (`.env*`, keys) or build output. */
export function isIndexable(path: string): boolean {
  if (SKIP_DIRS.test(path) || SKIP_FILES.test(path)) return false;
  return CODE_EXT.test(path) || CONFIG_EXT.test(path);
}
/** Paths the deep tools must never return, whatever the index says. */
export const isSensitivePath = (path: string): boolean => /(?:^|\/)\.env[^/]*$|\.pem$|\.key$|(?:^|\/)id_(?:rsa|ed25519)/.test(path);

const isPy = (p: string) => p.endsWith(".py");

/** Symbols defined in a file. Cheap line regexes; long (minified) lines are ignored. */
export function parseSymbols(path: string, text: string): SymbolDef[] {
  const out: SymbolDef[] = [];
  if (!CODE_EXT.test(path)) return out;
  const lines = text.split("\n");
  const exportedNames = new Set<string>();
  const py = isPy(path);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.length > 400) continue;
    const line = i + 1;
    if (py) {
      let m = l.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
      if (m) { out.push({ name: m[1]!, kind: "function", line, exported: !m[1]!.startsWith("_") }); continue; }
      m = l.match(/^class\s+([A-Za-z_]\w*)/);
      if (m) { out.push({ name: m[1]!, kind: "class", line, exported: !m[1]!.startsWith("_") }); continue; }
      m = l.match(/^([A-Za-z_]\w*)\s*(?::[^=]+)?=[^=]/);
      if (m) out.push({ name: m[1]!, kind: "const", line, exported: !m[1]!.startsWith("_") });
      continue;
    }
    let m = l.match(/^\s*export\s*\{([^}]*)\}/);
    if (m) {
      for (const part of m[1]!.split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0]?.trim(); // the local symbol, not the alias
        if (name && /^[A-Za-z_$][\w$]*$/.test(name)) exportedNames.add(name);
      }
      continue;
    }
    m = l.match(/^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/);
    if (m) { out.push({ name: m[2]!, kind: "function", line, exported: !!m[1] }); continue; }
    m = l.match(/^\s*(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (m) { out.push({ name: m[2]!, kind: "class", line, exported: !!m[1] }); continue; }
    m = l.match(/^\s*(export\s+)?(?:declare\s+)?(?:const\s+)?(interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
    if (m) { out.push({ name: m[3]!, kind: "type", line, exported: !!m[1] }); continue; }
    m = l.match(/^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.*)$/);
    if (m) {
      const fn = /^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>|^(?:async\s+)?function\b/.test(m[3]!);
      out.push({ name: m[2]!, kind: fn ? "function" : "const", line, exported: !!m[1] });
    }
  }
  if (exportedNames.size) for (const s of out) if (exportedNames.has(s.name)) s.exported = true;
  return out;
}

/** Split text into fixed line windows. */
export function chunkText(path: string, text: string, lines: number, maxChunks: number): Chunk[] {
  const all = text.split("\n");
  const out: Chunk[] = [];
  for (let s = 0; s < all.length && out.length < maxChunks; s += lines) {
    const part = all.slice(s, s + lines).join("\n");
    if (!part.trim()) continue;
    out.push({ id: `${path}#${out.length}`, start: s + 1, end: Math.min(all.length, s + lines), text: part });
  }
  return out;
}

/** Index one file; null for binary / oversized / minified content. */
export function indexFile(path: string, text: string, lim: IndexLimits): FileEntry | null {
  if (text.length > lim.maxFileBytes || text.includes("\u0000")) return null;
  const lineCount = text.split("\n").length;
  if (text.length / lineCount > 300) return null; // minified or generated
  return {
    size: text.length,
    symbols: parseSymbols(path, text),
    imports: localImports(path, text),
    chunks: chunkText(path, text, lim.chunkLines, lim.maxChunksPerFile),
  };
}

export interface BuildResult {
  /** null when the file tree could not be listed. */
  snapshot: IndexSnapshot | null;
  complete: boolean;
  reason?: string;
  /** Which cap stopped the build (set together with `reason`). */
  limit?: StopKind;
  /** Seeded builds only: indexed files from the related stages (changed files, imports/importers, siblings, parents, name matches). */
  related?: number;
  /** Seeded builds only: changed files that exist in the tree and are indexable, and how many of them were indexed. */
  seedsFound?: number;
  seedsIndexed?: number;
}

export interface BuildOptions {
  /** The PR's changed files. When given, files are read most-related-first (core/deeporder.ts); without it the order is the tree order. */
  seeds?: Seeds;
}

async function readMany(
  src: IndexSource, paths: string[], lim: IndexLimits, now: () => number,
): Promise<{ texts: Map<string, string | null>; stopped?: string }> {
  const texts = new Map<string, string | null>();
  const start = now();
  let bytes = 0;
  let stopped: string | undefined;
  for (let i = 0; i < paths.length; i += lim.concurrency) {
    if (now() - start > lim.maxMs) { stopped = `time budget ${lim.maxMs} ms reached`; break; }
    if (bytes > lim.maxTotalBytes) { stopped = `size budget ${lim.maxTotalBytes} bytes reached`; break; }
    const batch = paths.slice(i, i + lim.concurrency);
    const got = await Promise.all(batch.map((p) => src.readFile(p).catch(() => null)));
    batch.forEach((p, j) => { texts.set(p, got[j] ?? null); bytes += got[j]?.length ?? 0; });
  }
  return { texts, stopped };
}

/** Tree order: shallow first, then alphabetical. */
const treeOrder = (a: string, b: string) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1);

/**
 * Full build from the tree of one commit, within the caps. Without `opts.seeds` files are read in tree order.
 * With seeds they are read most-related-first, so a capped build still holds what the PR touches (a complete build is the same either way).
 */
export async function buildIndex(
  src: IndexSource, meta: { repo: string; sha: string }, lim: IndexLimits = INLINE_LIMITS,
  now: () => number = Date.now, opts: BuildOptions = {},
): Promise<BuildResult> {
  const all = await src.listPaths().catch(() => null);
  if (!all) return { snapshot: null, complete: false, reason: "file tree unavailable or truncated" };
  const cands = all.filter(isIndexable).sort(treeOrder);
  const files: Record<string, FileEntry> = {};
  let reason: string | undefined;
  let limit: StopKind | undefined;
  let extra: Pick<BuildResult, "related" | "seedsFound" | "seedsIndexed"> = {};
  if (opts.seeds) {
    const r = await readInRelevanceOrder(src, all, cands, opts.seeds, lim, now, isIndexable);
    for (const p of r.order) {
      const t = r.texts.get(p);
      const e = typeof t === "string" ? indexFile(p, t, lim) : null;
      if (e) files[p] = e;
    }
    reason = r.stopped?.reason;
    limit = r.stopped?.kind;
    extra = {
      related: r.order.slice(0, r.relatedEnd).filter((p) => files[p]).length,
      seedsFound: r.seedPaths.length,
      seedsIndexed: r.seedPaths.filter((p) => files[p]).length,
    };
  } else {
    const wanted = cands.slice(0, lim.maxFiles);
    await src.prefetch?.(wanted).catch(() => {});
    const { texts, stopped } = await readMany(src, wanted, lim, now);
    for (const [p, t] of texts) {
      const e = t === null ? null : indexFile(p, t, lim);
      if (e) files[p] = e;
    }
    reason = stopped ?? (cands.length > wanted.length ? `file cap ${lim.maxFiles} reached (${cands.length} indexable files)` : undefined);
    limit = stopped ? (stopped.startsWith("time") ? "time" : "size") : reason ? "files" : undefined;
  }
  const snapshot: IndexSnapshot = { v: 1, repo: meta.repo, sha: meta.sha, createdAt: new Date(now()).toISOString(), files };
  if (reason) snapshot.partial = { indexed: Object.keys(files).length, total: cands.length, reason, ...(limit ? { limit } : {}), ...(opts.seeds ? { ordered: true } : {}) };
  return { snapshot, complete: !reason, reason, ...(limit ? { limit } : {}), ...extra };
}

/** User-facing fragment for a relevance-ordered partial index (null for a complete or tree-order one). */
export function partialIndexNote(snap: IndexSnapshot): string | null {
  const p = snap.partial;
  if (!p?.ordered) return null;
  const n = Object.keys(snap.files).length;
  const word = { size: "size", time: "time", files: "file" }[p.limit ?? "size"];
  return `used a partial index (${n} file${n === 1 ? "" : "s"}, most related first; ${word} limit reached)`;
}

export interface FileChange { path: string; removed?: boolean }

/** Re-index only the changed paths on top of a previous snapshot (a new object; `prev` is untouched). */
export async function updateIndex(
  prev: IndexSnapshot, src: Pick<IndexSource, "readFile">, changes: FileChange[], sha: string,
  lim: IndexLimits = INLINE_LIMITS, now: () => number = Date.now,
): Promise<{ snapshot: IndexSnapshot; removedChunkIds: string[]; changedChunkIds: string[] }> {
  const files = { ...prev.files };
  const removedChunkIds: string[] = [];
  const changedChunkIds: string[] = [];
  const unique = [...new Map(changes.map((c) => [c.path, c])).values()];
  const toRead = unique.filter((c) => !c.removed && isIndexable(c.path)).map((c) => c.path);
  const { texts } = await readMany({ listPaths: async () => null, readFile: src.readFile }, toRead, lim, now);
  for (const c of unique) {
    const old = files[c.path];
    const t = c.removed ? null : texts.get(c.path) ?? null;
    const fresh = t === null ? null : indexFile(c.path, t, lim);
    if (fresh) files[c.path] = fresh; else delete files[c.path];
    const keep = new Set(fresh?.chunks.map((k) => k.id));
    for (const k of old?.chunks ?? []) if (!keep.has(k.id)) removedChunkIds.push(k.id);
    for (const k of fresh?.chunks ?? []) changedChunkIds.push(k.id);
  }
  const { embedded: _stale, ...rest } = prev; // vectors no longer cover every chunk
  const snapshot: IndexSnapshot = { ...rest, sha, createdAt: new Date(now()).toISOString(), files };
  return { snapshot, removedChunkIds, changedChunkIds };
}

export const encodeSnapshot = (s: IndexSnapshot): string => JSON.stringify(s);
export function decodeSnapshot(text: string): IndexSnapshot {
  const v = JSON.parse(text) as IndexSnapshot;
  if (v?.v !== 1 || typeof v.files !== "object" || !v.files) throw new Error("unsupported index snapshot");
  return v;
}

export const snapshotKey = (installationId: number, repoId: number, sha: string): string => `idx/${installationId}/${repoId}/${sha}.json`;
export const latestKey = (installationId: number, repoId: number): string => `idx/${installationId}/${repoId}/latest`;

// ---- queries ----

const resolvedCache = new WeakMap<IndexSnapshot, { paths: Set<string>; importers: Map<string, string[]> }>();
function graph(snap: IndexSnapshot) {
  let g = resolvedCache.get(snap);
  if (!g) {
    const paths = new Set(Object.keys(snap.files));
    const importers = new Map<string, string[]>();
    for (const [p, f] of Object.entries(snap.files)) {
      for (const spec of f.imports) {
        const t = resolveImport(p, spec, paths);
        if (t) importers.set(t, [...(importers.get(t) ?? []), p]);
      }
    }
    g = { paths, importers };
    resolvedCache.set(snap, g);
  }
  return g;
}

/** Local files `path` imports (resolved against the snapshot's files). */
export function importsOf(snap: IndexSnapshot, path: string): string[] {
  const { paths } = graph(snap);
  const out = new Set<string>();
  for (const spec of snap.files[path]?.imports ?? []) {
    const t = resolveImport(path, spec, paths);
    if (t) out.add(t);
  }
  return [...out];
}
/** Local files that import `path`. */
export const importersOf = (snap: IndexSnapshot, path: string): string[] => graph(snap).importers.get(path) ?? [];

export interface SymbolHit extends SymbolDef { path: string }

/** Symbols whose name matches `query` (exact, then prefix, then substring; exported first). */
export function searchSymbols(snap: IndexSnapshot, query: string, limit = 20): SymbolHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { s: SymbolHit; rank: number }[] = [];
  for (const [path, f] of Object.entries(snap.files)) {
    for (const s of f.symbols) {
      const n = s.name.toLowerCase();
      const rank = n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : -1;
      if (rank >= 0) scored.push({ s: { ...s, path }, rank: rank * 2 + (s.exported ? 0 : 1) });
    }
  }
  return scored.sort((a, b) => a.rank - b.rank || (a.s.path < b.s.path ? -1 : 1)).slice(0, limit).map((x) => x.s);
}

export interface RefHit { path: string; line: number; text: string }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Lines that mention `symbol` as a whole token anywhere in the index (code, strings, config), minus its
 * own definition lines. Files importing a definition's file come first.
 */
export function findReferences(snap: IndexSnapshot, symbol: string, limit = 30): RefHit[] {
  const name = symbol.trim();
  if (!name || name.length > 200) return [];
  const re = new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`);
  const defs = new Map<string, Set<number>>();
  const defFiles: string[] = [];
  for (const [p, f] of Object.entries(snap.files)) {
    const d = f.symbols.filter((s) => s.name === name);
    if (d.length) { defs.set(p, new Set(d.map((s) => s.line))); defFiles.push(p); }
  }
  const near = new Set(defFiles.flatMap((p) => importersOf(snap, p)));
  const hits: (RefHit & { rank: number })[] = [];
  for (const [path, f] of Object.entries(snap.files)) {
    const skip = defs.get(path);
    for (const c of f.chunks) {
      if (!re.test(c.text)) continue;
      c.text.split("\n").forEach((l, i) => {
        const line = c.start + i;
        if (re.test(l) && !skip?.has(line)) hits.push({ path, line, text: l.trim().slice(0, 200), rank: near.has(path) ? 0 : 1 });
      });
    }
  }
  return hits.sort((a, b) => a.rank - b.rank || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line))
    .slice(0, limit).map(({ rank: _r, ...h }) => h);
}

/** Every chunk with its path, for embedding. */
export function allChunks(snap: IndexSnapshot): (Chunk & { path: string })[] {
  return Object.entries(snap.files).flatMap(([path, f]) => f.chunks.map((c) => ({ ...c, path })));
}
export function chunkById(snap: IndexSnapshot, id: string): (Chunk & { path: string }) | null {
  const i = id.lastIndexOf("#");
  const path = id.slice(0, i);
  const c = snap.files[path]?.chunks.find((k) => k.id === id);
  return c ? { ...c, path } : null;
}
/** Text sent to the embedder for a chunk. */
export const embeddingText = (c: { path: string; text: string }): string => `${c.path}\n${c.text}`.slice(0, 1500);
