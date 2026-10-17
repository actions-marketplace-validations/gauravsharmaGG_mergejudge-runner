// Vendored from the MergeJudge core. Keep in sync.
import { changedSymbols, excerpt, gatherContext, resolveImport, type ContextOptions, type ContextPiece, type ContextSource } from "./context.js";
import { findReferences, importersOf, isSensitivePath, type IndexSnapshot } from "./deepindex.js";
import type { PrFile } from "./types.js";

/**
 * Deep mode for engines that cannot call tools (runner CLIs): instead of a tool loop, the index is queried up front
 * and the answers are sent as context pieces. Pure: reads only the snapshot, makes no network call.
 */

/** Bigger than context mode's defaults: the index is local, so a read costs nothing. */
export const DEEP_RETRIEVE_DEFAULTS: Omit<ContextOptions, "skip"> = { max_bytes: 80_000, max_files: 60, max_symbols: 8, max_callers: 5, max_file_bytes: 12_000 };

/**
 * Extra budgets for the graph/literal stages. Everything is also bounded by `max_bytes` and by `max_files`, which caps the
 * total number of pieces. Order of priority: hop-1 (changed file, its imports, symbol callers, importers), then literal
 * references, then hop-2 (importers of importers, imports of imports).
 */
export interface DeepRetrieveLimits {
  /** Hop-1 importers added (files that import a changed file). */
  max_importers: number;
  /** Hop-2 importers added (files that import a hop-1 importer). */
  max_hop2_importers: number;
  /** Hop-2 importees added (files imported by a hop-1 import). */
  max_hop2_imports: number;
  /** Candidate files whose text is rebuilt and ranked per stage (bounds work on hub files with huge fan-in). */
  max_examine: number;
  /** Distinct literals (strings, object keys, env vars) searched for. */
  max_literals: number;
  /** Literal-reference files added. */
  max_literal_files: number;
  /** A literal found in more than this many other files is too common to say anything and is dropped. */
  literal_common_files: number;
  /** Bytes of index text scanned by the literal search. */
  max_scan_bytes: number;
  /** Per-piece byte cap for literal-reference excerpts. */
  literal_piece_bytes: number;
  /** Wall-time budget (ms) for the stages after the base context; later stages are skipped once spent. */
  max_ms: number;
}
export const DEEP_HOP_DEFAULTS: DeepRetrieveLimits = {
  max_importers: 6, max_hop2_importers: 6, max_hop2_imports: 4, max_examine: 40, max_literals: 12, max_literal_files: 8,
  literal_common_files: 25, max_scan_bytes: 8_000_000, literal_piece_bytes: 6_000, max_ms: 3_000,
};

/** File text rebuilt from snapshot chunks (blank-only chunks were dropped by the indexer; their lines come back empty). */
export function snapshotText(snap: IndexSnapshot, path: string): string | null {
  const f = snap.files[path];
  if (!f) return null;
  const lines: string[] = [];
  for (const c of f.chunks) {
    const parts = c.text.split("\n");
    for (let i = 0; i < parts.length; i++) lines[c.start - 1 + i] = parts[i]!;
  }
  for (let i = 0; i < lines.length; i++) lines[i] ??= "";
  return lines.join("\n");
}

function snapshotSource(snap: IndexSnapshot): ContextSource {
  return {
    listPaths: async () => Object.keys(snap.files),
    readFile: async (p) => snapshotText(snap, p),
    searchSymbol: async (sym) => [...new Set(findReferences(snap, sym, 80).map((h) => h.path))],
  };
}

const baseName = (p: string) => p.replace(/\.[^./]+$/, "").split("/").pop()!;
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wholeToken = (lit: string) => new RegExp(`(?<![\\w$])${escapeRe(lit)}(?![\\w$])`);

/** Strings too generic to identify a consumer. */
const COMMON_LITERALS = new Set([
  "use strict", "utf8", "utf-8", "string", "number", "object", "boolean", "function", "undefined", "default", "error",
  "data", "json", "true", "false", "null", "none", "type", "name", "value", "values", "test", "index", "main", "node",
  "content-type", "application/json", "text/plain", "text/html", "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD",
  "message", "status", "result", "results", "items", "length", "key", "keys", "path", "file", "text", "info", "warn",
  "debug", "require", "exports", "module", "string", "return", "async", "await", "const", "this", "self", "class",
]);

export interface PatchLiteral {
  text: string;
  /** removed = only on `-` lines (consumers may still use the old value); added = only on `+`; both = on each. */
  side: "removed" | "added" | "both";
  kind: "string" | "key" | "env";
}

/** How distinctive a literal is: separators, mixed case and length beat plain lowercase words. */
function distinct(t: string): number {
  let sc = Math.min(t.length, 24) / 4;
  if (/[._:/-]/.test(t)) sc += 3;
  if (/[a-z][A-Z]/.test(t) || /^[A-Z0-9_]{4,}$/.test(t)) sc += 2;
  if (/\d/.test(t)) sc += 1;
  return sc;
}

/**
 * String literals, object keys and env var names on changed lines of a patch, both removed and added. A renamed key or
 * event name is exactly where a consumer outside the import graph breaks. Import specifiers and generic words are ignored.
 */
export function patchLiterals(patch: string | undefined, max = DEEP_HOP_DEFAULTS.max_literals): PatchLiteral[] {
  if (!patch) return [];
  const seen = new Map<string, { removed: boolean; added: boolean; kind: PatchLiteral["kind"] }>();
  const note = (text: string, kind: PatchLiteral["kind"], removed: boolean) => {
    if (text.length < 3 || text.length > 80 || /\s/.test(text) || COMMON_LITERALS.has(text) || /^[\d._-]+$/.test(text)) return;
    if (/^[./]|^@[\w-]+\/|^node:/.test(text)) return; // paths, scoped packages, node: builtins
    const e = seen.get(text) ?? { removed: false, added: false, kind };
    if (removed) e.removed = true; else e.added = true;
    if (kind === "env") e.kind = "env";
    seen.set(text, e);
  };
  for (const line of patch.split("\n")) {
    if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line) || line.length > 600) continue;
    const removed = line[0] === "-";
    const l = line.slice(1);
    if (/^\s*(?:import\b|export\s[^'"]*\sfrom\b|from\s+\S+\s+import\b)|\brequire\s*\(/.test(l)) continue;
    for (const m of l.matchAll(/process\.env\.([A-Za-z_]\w*)|import\.meta\.env\.([A-Za-z_]\w*)|\benv\.([A-Z_][A-Z0-9_]*)|(?:process\.env|os\.environ|env)\[\s*['"]([A-Za-z_]\w*)['"]\s*\]|os\.(?:getenv|environ\.get)\(\s*['"]([A-Za-z_]\w*)['"]/g))
      note(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]!, "env", removed);
    for (const m of l.matchAll(/(["'`])((?:\\.|(?!\1)[^\\$])*?)\1/g)) note(m[2]!, "string", removed);
    for (const m of l.matchAll(/(?:^|[{,(])\s*["']?([A-Za-z_$][\w$-]{4,})["']?\s*:(?!:)/g)) note(m[1]!, "key", removed);
    for (const m of l.matchAll(/\.([a-z][\w$]*[A-Z][\w$]*)\b/g)) note(m[1]!, "key", removed); // obj.camelCaseProp
  }
  const out: PatchLiteral[] = [...seen].map(([text, e]) => ({ text, kind: e.kind, side: e.removed && e.added ? "both" : e.removed ? "removed" : "added" }));
  const rank = (x: PatchLiteral) => (x.side === "removed" ? 4 : x.side === "added" ? 2 : 0) + (x.kind === "env" ? 3 : 0) + distinct(x.text);
  return out.sort((a, b) => rank(b) - rank(a) || (a.text < b.text ? -1 : 1)).slice(0, max);
}

/** Changed files, what they import, files mentioning their changed symbols, the files that import them, and two hops out. */
export async function retrieveDeepContext(
  snap: IndexSnapshot, files: PrFile[], opts: Partial<ContextOptions> & Partial<DeepRetrieveLimits> = {}, log: (m: string) => void = () => {},
): Promise<{ pieces: ContextPiece[]; bytes: number }> {
  const t0 = Date.now();
  const { max_importers, max_hop2_importers, max_hop2_imports, max_examine, max_literals, max_literal_files, literal_common_files, max_scan_bytes, literal_piece_bytes, max_ms } = { ...DEEP_HOP_DEFAULTS, ...opts };
  const o = { ...DEEP_RETRIEVE_DEFAULTS, ...opts };
  const src = snapshotSource(snap);
  const g = await gatherContext(files, src, o, log);
  const pieces = g.pieces.slice();
  let bytes = g.bytes;
  const seen = new Set([...pieces.map((p) => p.path), ...files.map((f) => f.path)]);
  const symbols = [...new Set(files.flatMap((f) => changedSymbols(f.patch)))];
  const timeUp = () => Date.now() - t0 > max_ms;
  const full = () => o.max_bytes - bytes < 512 || pieces.length >= o.max_files;
  const stats = { hop1: 0, literal: 0, hop2: 0, scanned: 0, timedOut: false };

  /** Add `path` as a piece, with an excerpt around the lines matching `re`. */
  const addPiece = (path: string, text: string, kind: ContextPiece["kind"], why: string, re: RegExp | null, cap0 = o.max_file_bytes): boolean => {
    const cap = Math.min(o.max_bytes - bytes, cap0);
    const truncated = text.length > cap;
    const lines = text.split("\n");
    const hit = re ? lines.flatMap((l, i) => (re.test(l) ? [[i + 1, i + 1] as [number, number]] : [])) : [];
    const content = truncated ? excerpt(text, hit.length ? hit : [[1, 40] as [number, number]], cap) : text;
    pieces.push({ path, kind, why: why + (truncated ? ", excerpt around relevant lines" : ""), content, truncated });
    bytes += content.length;
    seen.add(path);
    return true;
  };
  const symRe = (names: string[]) => new RegExp(names.map((n) => escapeRe(n)).join("|"));
  /** Rank not-yet-seen candidates: files that mention `needles` first, then path order. Reads at most max_examine texts. */
  const rankCandidates = (cands: string[], needles: string[]): { path: string; text: string; rel: boolean }[] => {
    const out: { path: string; text: string; rel: boolean }[] = [];
    const uniq = [...new Set(cands)].filter((c) => !seen.has(c) && !o.skip?.(c) && !isSensitivePath(c)).sort();
    const re = needles.length ? symRe(needles) : null;
    for (const c of uniq.slice(0, max_examine)) {
      if (timeUp()) { stats.timedOut = true; break; }
      const text = snapshotText(snap, c);
      if (text !== null) out.push({ path: c, text, rel: re ? re.test(text) : false });
    }
    return out.sort((a, b) => Number(b.rel) - Number(a.rel));
  };

  // hop 1: importers of each changed file
  const hop1: { path: string; via: string }[] = g.pieces.filter((x) => x.kind === "caller").map((x) => ({
    path: x.path, via: files.find((f) => importersOf(snap, f.path).includes(x.path))?.path ?? files[0]?.path ?? "a changed file",
  }));
  for (const f of files) {
    if (f.status === "removed" || full() || timeUp()) continue;
    const needles = [baseName(f.path), ...symbols];
    for (const c of rankCandidates(importersOf(snap, f.path), needles)) {
      if (stats.hop1 >= max_importers || full() || seen.has(c.path)) continue;
      addPiece(c.path, c.text, "caller", `imports ${f.path}`, symRe(needles));
      hop1.push({ path: c.path, via: f.path });
      stats.hop1++;
    }
  }

  // literal search: strings, keys and env vars changed in the diff, wherever they are referenced
  if (!full() && !timeUp() && max_literals > 0 && max_literal_files > 0) {
    const lits = new Map<string, PatchLiteral & { from: string[] }>();
    for (const f of files) for (const l of patchLiterals(f.patch, max_literals)) {
      const e = lits.get(l.text);
      if (e) { e.from.push(f.path); if (e.side !== l.side) e.side = "both"; } else lits.set(l.text, { ...l, from: [f.path] });
    }
    const list = [...lits.values()].slice(0, max_literals);
    if (list.length) {
      const changed = new Set(files.map((f) => f.path));
      const res = list.map((l) => wholeToken(l.text));
      const hits = list.map(() => new Map<string, number[]>()); // literal -> file -> lines
      const common = list.map(() => false);
      let scanned = 0;
      scan: for (const [path, fe] of Object.entries(snap.files)) {
        if (changed.has(path) || o.skip?.(path) || isSensitivePath(path)) continue;
        if (timeUp()) { stats.timedOut = true; break; }
        for (const c of fe.chunks) {
          scanned += c.text.length;
          if (scanned > max_scan_bytes) break scan;
          for (let i = 0; i < list.length; i++) {
            if (common[i] || !c.text.includes(list[i]!.text) || !res[i]!.test(c.text)) continue;
            const m = hits[i]!;
            if (!m.has(path) && m.size >= literal_common_files) { common[i] = true; m.clear(); continue; }
            const lines = m.get(path) ?? [];
            c.text.split("\n").forEach((l, j) => { if (l.includes(list[i]!.text) && res[i]!.test(l)) lines.push(c.start + j); });
            m.set(path, lines);
          }
        }
      }
      stats.scanned = scanned;
      const byFile = new Map<string, { score: number; lits: number[]; lines: number[] }>();
      list.forEach((l, i) => {
        for (const [path, lines] of hits[i]!) {
          const e = byFile.get(path) ?? { score: 0, lits: [], lines: [] };
          e.score += (l.side === "removed" ? 3 : l.side === "both" ? 1 : 2) + distinct(l.text) / 10;
          e.lits.push(i); e.lines.push(...lines);
          byFile.set(path, e);
        }
      });
      const near = new Set(hop1.map((h) => h.path));
      const ranked = [...byFile].filter(([p]) => !seen.has(p)).sort((a, b) => b[1].score - a[1].score || Number(near.has(b[0])) - Number(near.has(a[0])) || (a[0] < b[0] ? -1 : 1));
      for (const [path, e] of ranked) {
        if (stats.literal >= max_literal_files || full()) break;
        const text = snapshotText(snap, path);
        if (text === null) continue;
        const names = e.lits.slice(0, 3).map((i) => `${JSON.stringify(list[i]!.text)} (${list[i]!.side === "removed" ? "removed" : list[i]!.side === "added" ? "added" : "changed"} in ${list[i]!.from[0]})`);
        const re = symRe(e.lits.map((i) => list[i]!.text));
        addPiece(path, text, "caller", `references literal ${names.join(", ")} changed in this PR; may depend on the old or new value`, re, literal_piece_bytes);
        stats.literal++;
      }
    }
  }

  // hop 2: importers of the importers, and what the imported files import (ranked below everything above)
  if (!full() && !timeUp() && (max_hop2_importers > 0 || max_hop2_imports > 0)) {
    for (const h of hop1) {
      if (stats.hop2 >= max_hop2_importers || full()) break;
      const needles = [baseName(h.path), ...symbols];
      for (const c of rankCandidates(importersOf(snap, h.path), needles)) {
        if (stats.hop2 >= max_hop2_importers || full()) break;
        addPiece(c.path, c.text, "caller", `imports ${h.path}, which imports ${h.via} (2 hops from the changed file)`, symRe(needles));
        stats.hop2++;
      }
    }
    let imp2 = 0;
    const pathSet = new Set(Object.keys(snap.files));
    for (const p of g.pieces.filter((x) => x.kind === "import")) {
      if (imp2 >= max_hop2_imports || full() || timeUp()) break;
      const targets = (snap.files[p.path]?.imports ?? []).map((spec) => resolveImport(p.path, spec, pathSet)).filter((t): t is string => !!t);
      for (const c of rankCandidates(targets, symbols)) {
        if (imp2 >= max_hop2_imports || full()) break;
        addPiece(c.path, c.text, "import", `imported by ${p.path}, which a changed file imports (2 hops)`, symbols.length ? symRe(symbols) : null);
        imp2++; stats.hop2++;
      }
    }
  }

  log(`deep: ${pieces.length} piece(s), ${bytes} bytes retrieved from the index (hop1 importers ${stats.hop1}, literal refs ${stats.literal}, hop2 ${stats.hop2}, ${stats.scanned} bytes scanned, ${Date.now() - t0} ms${stats.timedOut ? ", time budget hit" : ""})`);
  return { pieces, bytes };
}
