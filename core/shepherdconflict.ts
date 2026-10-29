/**
 * Merge-conflict classification for Shepherd (pure). Only mechanical conflicts are resolved: import blocks where both
 * sides add or remove distinct import lines, and lockfiles. Anything else is a judgment call (H4) and is handed off.
 * Git itself already merges non-overlapping hunks; this only sees what git could not.
 */

export type Segment =
  | { type: "text"; text: string }
  | { type: "conflict"; ours: string[]; theirs: string[]; base: string[] | null; line: number };

const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "go.sum"]);
export const isLockfile = (path: string) => LOCKFILES.has(path.split("/").pop() ?? "");

/** Split a file with conflict markers (merge or diff3 style) into text and conflict segments. Null when the markers are malformed. */
export function parseConflicts(text: string): Segment[] | null {
  const lines = text.split("\n");
  const out: Segment[] = [];
  let buf: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (!l.startsWith("<<<<<<< ")  && l !== "<<<<<<<") { buf.push(l); i++; continue; }
    const start = i + 1;
    const ours: string[] = [], theirs: string[] = [];
    let base: string[] | null = null;
    let mode: "ours" | "base" | "theirs" = "ours";
    i++;
    let closed = false;
    for (; i < lines.length; i++) {
      const c = lines[i]!;
      if (c.startsWith("||||||| ") || c === "|||||||") { mode = "base"; base = []; }
      else if (c === "=======") mode = "theirs";
      else if (c.startsWith(">>>>>>> ") || c === ">>>>>>>") { closed = true; i++; break; }
      else (mode === "ours" ? ours : mode === "base" ? base! : theirs).push(c);
    }
    if (!closed || mode !== "theirs") return null;
    if (buf.length) out.push({ type: "text", text: buf.join("\n") + "\n" });
    buf = [];
    out.push({ type: "conflict", ours, theirs, base, line: start });
  }
  const tail = buf.join("\n");
  if (tail !== "" || out.length === 0) out.push({ type: "text", text: tail });
  return out;
}

const IMPORT_LINE = [
  /^\s*import\s[^;]*;?\s*$/, // js/ts single-line, python `import x`, java
  /^\s*import\s*["'][^"']+["'];?\s*$/,
  /^\s*from\s+\S+\s+import\s+[^(]+$/,
  /^\s*(?:const|let|var)\s+(?:\w+|\{[^}]*\})\s*=\s*require\(\s*["'][^"']+["']\s*\)\s*;?\s*$/,
  /^\s*use\s+[\w\\:{}*,\s]+;\s*$/, // rust, php
  /^\s*#include\s+[<"][^>"]+[>"]\s*$/,
];
const isImportLine = (l: string) => IMPORT_LINE.some((re) => re.test(l)) && !/[{(]\s*$/.test(l);

/**
 * Resolve an import-only hunk: the union of both sides, de-duplicated, ours first then their additions. With a diff3 base,
 * a line one side removed stays removed. Returns null when either side holds anything but import lines or blanks.
 */
export function mergeImportHunk(ours: string[], theirs: string[], base: string[] | null): string[] | null {
  const body = (ls: string[]) => ls.filter((l) => l.trim() !== "");
  const o = body(ours), t = body(theirs), b = base ? body(base) : null;
  if (![...o, ...t, ...(b ?? [])].every(isImportLine)) return null;
  const removed = new Set<string>();
  if (b) for (const l of b) if (!o.includes(l) || !t.includes(l)) removed.add(l);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of [...o, ...t]) {
    if (removed.has(l) || seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}

export interface HunkInfo { index: number; line: number; ours: string; theirs: string }
export type ConflictVerdict =
  | { kind: "lockfile" }
  | { kind: "resolved"; text: string; hunks: number }
  | { kind: "logic"; hunks: HunkInfo[] };

const preview = (ls: string[]) => ls.filter((l) => l.trim()).slice(0, 3).join(" / ").slice(0, 160);

/** Classify one conflicted file. `resolved.text` is the file with every hunk resolved; `logic` lists the hunks that need a human. */
export function classifyConflictFile(path: string, text: string): ConflictVerdict {
  if (isLockfile(path)) return { kind: "lockfile" };
  const segs = parseConflicts(text);
  if (!segs) return { kind: "logic", hunks: [{ index: 0, line: 1, ours: "(malformed conflict markers)", theirs: "" }] };
  if (!segs.some((s) => s.type === "conflict")) return { kind: "logic", hunks: [{ index: 0, line: 1, ours: "(no text hunks: a deleted, renamed or binary file conflicts)", theirs: "" }] };
  const bad: HunkInfo[] = [];
  let n = 0, out = "";
  for (const s of segs) {
    if (s.type === "text") { out += s.text; continue; }
    const merged = mergeImportHunk(s.ours, s.theirs, s.base);
    if (merged) { n++; if (merged.length) out += merged.join("\n") + "\n"; }
    else bad.push({ index: n + bad.length, line: s.line, ours: preview(s.ours), theirs: preview(s.theirs) });
  }
  return bad.length ? { kind: "logic", hunks: bad } : { kind: "resolved", text: out, hunks: n };
}

/** go.sum: the union of both sides' lines, sorted and de-duplicated. */
export function unionLines(...texts: string[]): string {
  const set = new Set(texts.flatMap((t) => t.split("\n")).filter((l) => l.trim()));
  return [...set].sort().join("\n") + "\n";
}

/** Manifest a lockfile is generated from (a PR that changed it cannot just take the base lockfile). */
export function manifestOf(lockfile: string): string | null {
  const dir = lockfile.includes("/") ? lockfile.slice(0, lockfile.lastIndexOf("/") + 1) : "";
  switch (lockfile.split("/").pop()) {
    case "package-lock.json": case "yarn.lock": case "pnpm-lock.yaml": return dir + "package.json";
    case "Cargo.lock": return dir + "Cargo.toml";
    case "poetry.lock": return dir + "pyproject.toml";
    default: return null;
  }
}
