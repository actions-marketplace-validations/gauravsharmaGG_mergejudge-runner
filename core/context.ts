import type { PrFile } from "./types.js";

/** One read-only piece of context sent next to the diff in `review.mode: context`. */
export interface ContextPiece {
  path: string;
  kind: "changed" | "import" | "caller";
  /** Why it was included, e.g. "imported by src/a.ts" or "calls formatPrice". */
  why: string;
  content: string;
  truncated: boolean;
}

/** How context is fetched. The Action and the Worker back this with the GitHub API. */
export interface ContextSource {
  /** All file paths at the head commit (one tree call), or null if unavailable. */
  listPaths(): Promise<string[] | null>;
  /** File text at the head commit, or null if missing/binary. */
  readFile(path: string): Promise<string | null>;
  /** Paths of files that mention `symbol` (code search), excluding none. May return []. */
  searchSymbol(symbol: string): Promise<string[]>;
}

export interface ContextOptions {
  max_bytes: number;
  /** Hard cap on file reads (keeps Worker subrequests bounded). */
  max_files: number;
  /** Max symbols searched for callers. */
  max_symbols: number;
  /** Max callers kept per symbol. */
  max_callers: number;
  /** Per-file cap; larger files are sent as excerpts around the relevant lines. */
  max_file_bytes: number;
  /** Paths never sent (e.g. diff_exclude matches). */
  skip?: (path: string) => boolean;
}

export const CONTEXT_DEFAULTS: Omit<ContextOptions, "skip"> = { max_bytes: 40_000, max_files: 25, max_symbols: 3, max_callers: 3, max_file_bytes: 12_000 };

const JS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const isJs = (p: string) => /\.(m|c)?[jt]sx?$/.test(p);
const isPy = (p: string) => p.endsWith(".py");

const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/** Local relative imports of a JS/TS or Python file (specifiers, unresolved). */
export function localImports(path: string, text: string): string[] {
  const specs = new Set<string>();
  if (isJs(path)) {
    const re = /(?:import\s[^'"]*?from\s*|import\s*\(?\s*|export\s[^'"]*?from\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
    for (const m of text.matchAll(re)) specs.add(m[1]!);
  } else if (isPy(path)) {
    for (const m of text.matchAll(/^\s*from\s+(\.+)([\w.]*)\s+import\s+([\w, ]+)/gm)) {
      const dots = m[1]!.length;
      const mod = m[2]!;
      const up = "../".repeat(Math.max(0, dots - 1)) || "./";
      if (mod) specs.add(up + mod.replace(/\./g, "/"));
      else for (const n of m[3]!.split(",").map((s) => s.trim()).filter(Boolean)) specs.add(up + n);
    }
  }
  return [...specs];
}

/** Resolve a relative specifier against the importing file using the known path set. */
export function resolveImport(from: string, spec: string, paths: Set<string>): string | null {
  const base = normalize(`${dirname(from)}/${spec}`);
  const cands = isPy(from)
    ? [`${base}.py`, `${base}/__init__.py`]
    : [base, ...JS_EXT.map((e) => base.replace(/\.js$/, "") + e), ...JS_EXT.map((e) => `${base}/index${e}`)];
  return cands.find((c) => paths.has(c)) ?? null;
}

/** Function/class/const names defined or exported on changed (+/-) lines of a patch. */
export function changedSymbols(patch: string | undefined): string[] {
  if (!patch) return [];
  const out = new Set<string>();
  for (const line of patch.split("\n")) {
    if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
    const l = line.slice(1);
    const m =
      l.match(/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/) ??
      l.match(/^\s*(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*\(/) ??
      l.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/) ??
      l.match(/^\s*class\s+([A-Za-z_]\w*)/);
    if (m && m[1]!.length >= 3) out.add(m[1]!);
  }
  return [...out];
}

/** New-file line ranges touched by a patch's hunks. */
export function hunkRanges(patch: string | undefined): [number, number][] {
  const out: [number, number][] = [];
  for (const m of (patch ?? "").matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    out.push([start, start + Math.max(0, Number(m[2] ?? 1) - 1)]);
  }
  return out;
}

/**
 * Excerpt of `text` around 1-based line ranges (±pad lines), each line prefixed "L<n> ", within maxBytes.
 * Used when a file is larger than max_file_bytes.
 */
export function excerpt(text: string, ranges: [number, number][], maxBytes: number, pad = 30): string {
  const lines = text.split("\n");
  const wins = ranges
    .map(([a, b]) => [Math.max(1, a - pad), Math.min(lines.length, b + pad)] as [number, number])
    .sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const w of wins) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1] + 1) last[1] = Math.max(last[1], w[1]);
    else merged.push([...w]);
  }
  let out = "";
  for (const [a, b] of merged) {
    const chunk = `[... excerpt L${a}-L${b} of ${lines.length} lines ...]\n` +
      lines.slice(a - 1, b).map((l, i) => `L${a + i} ${l}`).join("\n") + "\n";
    if (out.length + chunk.length > maxBytes) { out += chunk.slice(0, Math.max(0, maxBytes - out.length)); break; }
    out += chunk;
  }
  return out;
}

const lineHits = (text: string, re: RegExp): [number, number][] =>
  text.split("\n").flatMap((l, i) => (re.test(l) ? [[i + 1, i + 1] as [number, number]] : []));

/**
 * Gather context in priority order (changed files → their imports → callers of changed symbols)
 * within `max_bytes`, reading at most `max_files` files.
 */
export async function gatherContext(
  files: PrFile[], src: ContextSource, opts: Partial<ContextOptions> = {},
  log: (m: string) => void = () => {},
): Promise<{ pieces: ContextPiece[]; bytes: number; reads: number; dropped: string[] }> {
  const o = { ...CONTEXT_DEFAULTS, ...opts };
  const pieces: ContextPiece[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let reads = 0;
  const changedPaths = files.filter((f) => f.status !== "removed").map((f) => f.path);
  const changedSet = new Set(files.map((f) => f.path));

  const add = (path: string, kind: ContextPiece["kind"], why: string, text: string, focus?: [number, number][]): boolean => {
    const left = o.max_bytes - bytes;
    if (left < 512) { dropped.push(path); return false; }
    const cap = Math.min(left, o.max_file_bytes);
    let content = text;
    let truncated = false;
    if (text.length > cap) {
      truncated = true;
      content = focus?.length ? excerpt(text, focus, cap) : text.slice(0, cap);
      why += focus?.length ? ", excerpt around relevant lines" : "";
    }
    pieces.push({ path, kind, why, content, truncated });
    bytes += content.length;
    return true;
  };
  const read = async (p: string): Promise<string | null> => {
    if (o.skip?.(p)) return null;
    if (reads >= o.max_files) { dropped.push(p); return null; }
    reads++;
    try {
      const t = await src.readFile(p);
      return t !== null && t.includes("\u0000") ? null : t; // binary
    } catch { return null; }
  };

  // 1. Changed files in full at head.
  const texts = new Map<string, string>();
  for (const p of changedPaths) {
    if (seen.has(p)) continue;
    seen.add(p);
    const t = await read(p);
    if (t === null) continue;
    texts.set(p, t);
    add(p, "changed", "changed file, full text at head", t, hunkRanges(files.find((f) => f.path === p)?.patch));
  }

  // 2. Local imports of changed files.
  const all = await src.listPaths().catch(() => null);
  const pathSet = new Set(all ?? []);
  if (all) {
    for (const [p, t] of texts) {
      for (const spec of localImports(p, t)) {
        const target = resolveImport(p, spec, pathSet);
        if (!target || seen.has(target)) continue;
        seen.add(target);
        const it = await read(target);
        if (it !== null && !add(target, "import", `imported by ${p}`, it)) break;
      }
    }
  }

  // 3. Callers of changed symbols (code search; may lag the head commit).
  const symbols = [...new Set(files.flatMap((f) => changedSymbols(f.patch)))].slice(0, o.max_symbols);
  for (const sym of symbols) {
    let hits: string[] = [];
    try { hits = await src.searchSymbol(sym); } catch (e) { log(`context: search for ${sym} failed (${(e as Error).message})`); }
    let kept = 0;
    for (const h of hits) {
      if (kept >= o.max_callers) break;
      if (seen.has(h) || changedSet.has(h)) continue;
      if (all && !pathSet.has(h)) continue; // not at head (deleted / renamed)
      seen.add(h);
      const t = await read(h);
      if (t === null || !new RegExp(`\\b${sym.replace(/\$/g, "\\$")}\\b`).test(t)) continue;
      kept++;
      if (!add(h, "caller", `uses ${sym}`, t, lineHits(t, new RegExp(`\\b${sym.replace(/\$/g, "\\$")}\\b`)))) break;
    }
  }
  log(`context: ${pieces.length} piece(s), ${bytes} bytes, ${reads} read(s)${dropped.length ? `, dropped ${dropped.length}` : ""}`);
  return { pieces, bytes, reads, dropped };
}
