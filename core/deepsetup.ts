// Vendored from the MergeJudge core. Keep in sync.
import { hitText, type SemanticHit } from "./deep.js";
import {
  allChunks, buildIndex, INLINE_LIMITS, updateIndex, type FileChange, type IndexSnapshot, type IndexSource,
} from "./deepindex.js";
import type { R2IndexStore } from "./indexstore.js";
import type { PrFile } from "./types.js";
import { embedChunks, MemoryVectorStore, type Embedder, type VectorStore } from "./vectors.js";

/** Everything the core needs to give a deep review an index. All of it is optional; the Worker supplies what is bound. */
export interface DeepEnv {
  repoId: number;
  installationId: number;
  /** "<owner>/<repo>" */
  repoName: string;
  policy: "stored" | "none";
  /** Present only when an R2 bucket is bound. Without it the policy is effectively `none`. */
  store?: R2IndexStore;
  /** Persistent vectors (Vectorize, one namespace per repo); only used with `stored`. */
  vectors?: VectorStore;
  embedder?: Embedder;
  /** Files at the PR base commit (used to build when there is no snapshot, or to catch a stale one up). */
  base: IndexSource;
  baseSha: string;
  /** Files at the PR head commit. */
  head: IndexSource;
  headSha: string;
  /** Paths changed between two commits (compare API), or null if unknown. */
  changedBetween?(from: string, to: string): Promise<FileChange[] | null>;
  /** Queue an index build/refresh for this repo (best effort, de-duplicated by the caller). */
  enqueueIndex?(): Promise<void>;
  /** Max files a stale snapshot may be behind and still be caught up inline. */
  maxStaleFiles?: number;
  /** Max chunks embedded in memory for one review. */
  maxLazyChunks?: number;
}

export type DeepPrep =
  | { ok: true; snap: IndexSnapshot; semantic?: (q: string, k: number) => Promise<SemanticHit[]>; notes: string[] }
  | { ok: false; reason: string };

/** Effective policy: `stored` needs R2; otherwise nothing may be persisted. */
export const effectivePolicy = (e: Pick<DeepEnv, "policy" | "store">): "stored" | "none" => (e.policy === "stored" && e.store ? "stored" : "none");

const MAX_OVERLAY_FILES = 60;

/**
 * Get an index for a deep review: stored snapshot (caught up to the PR base and overlaid with the PR head
 * versions of changed files), or a bounded temporary build. Returns a reason when the caller should fall back to `context`.
 * With policy `none` (or no R2) nothing is written anywhere.
 */
export async function prepareDeepIndex(e: DeepEnv, prFiles: PrFile[], log: (m: string) => void = () => {}): Promise<DeepPrep> {
  const policy = effectivePolicy(e);
  const notes: string[] = [];
  if (e.policy === "stored" && !e.store) log("deep: INDEX_BUCKET not bound; treating index.policy as none");
  const queue = () => e.enqueueIndex?.().catch((err: Error) => log(`deep: could not queue index job (${err.message})`));

  let snap: IndexSnapshot | null = null;
  if (policy === "stored") {
    snap = await e.store!.latest(e.installationId, e.repoId).catch((err: Error) => { log(`deep: reading snapshot failed (${err.message})`); return null; });
    if (!snap) await queue();
  }

  if (snap && snap.sha !== e.baseSha) {
    const changes = await e.changedBetween?.(snap.sha, e.baseSha).catch(() => null);
    if (!changes || changes.length > (e.maxStaleFiles ?? 100)) {
      await queue();
      return { ok: false, reason: `index snapshot ${snap.sha.slice(0, 7)} is stale (base is ${e.baseSha.slice(0, 7)}); refresh queued` };
    }
    snap = (await updateIndex(snap, e.base, changes, e.baseSha, INLINE_LIMITS)).snapshot;
    notes.push(`index caught up ${changes.length} file(s) to base ${e.baseSha.slice(0, 7)} in memory`);
  }

  if (!snap) {
    const built = await buildIndex(e.base, { repo: e.repoName, sha: e.baseSha }, INLINE_LIMITS);
    if (!built.snapshot || !built.complete) {
      return { ok: false, reason: policy === "stored"
        ? `no index yet and the repo is too big for an inline build (${built.reason ?? "unknown"}); index build queued`
        : `repo too big for a temporary index (${built.reason ?? "unknown"})` };
    }
    snap = built.snapshot;
    notes.push("temporary index built for this review" + (policy === "stored" ? "; stored index build queued" : "; nothing stored"));
  } else if (snap.partial) {
    notes.push(`index is partial (${snap.partial.indexed}/${snap.partial.total} files)`);
  }

  // Overlay the PR head versions of changed files (in memory only).
  const changes: FileChange[] = prFiles.slice(0, MAX_OVERLAY_FILES).flatMap((f) => [
    ...(f.previousPath ? [{ path: f.previousPath, removed: true }] : []),
    { path: f.path, removed: f.status === "removed" },
  ]);
  const changedPaths = new Set(changes.filter((c) => !c.removed).map((c) => c.path));
  const base = snap;
  snap = (await updateIndex(snap, e.head, changes, e.headSha, INLINE_LIMITS)).snapshot;

  return { ok: true, snap, notes, semantic: e.embedder ? semanticSearch(e, base, snap, changedPaths) : undefined };
}

/**
 * semantic_search: persisted vectors (if the snapshot is fully embedded) for unchanged files, plus an in-memory
 * store embedded on first use for the rest (everything when nothing is persisted; only PR-changed files otherwise).
 */
function semanticSearch(e: DeepEnv, base: IndexSnapshot, snap: IndexSnapshot, changedPaths: Set<string>) {
  const persisted = e.policy === "stored" && e.store && e.vectors && base.embedded ? e.vectors : undefined;
  let mem: MemoryVectorStore | undefined;
  const ensureMem = async () => {
    if (mem) return mem;
    mem = new MemoryVectorStore();
    const chunks = allChunks(snap).filter((c) => !persisted || changedPaths.has(c.path))
      .sort((a, b) => Number(changedPaths.has(b.path)) - Number(changedPaths.has(a.path)));
    await embedChunks(snap, e.embedder!, mem, chunks.map((c) => c.id), e.maxLazyChunks ?? 400);
    return mem;
  };
  return async (query: string, k: number): Promise<SemanticHit[]> => {
    const [qv] = await e.embedder!.embed([query]);
    if (!qv) return [];
    const hits = persisted
      ? (await persisted.query(qv, k * 2).catch(() => [])).filter((h) => !changedPaths.has(h.meta.path))
      : [];
    hits.push(...(await (await ensureMem()).query(qv, k)));
    return hits.sort((a, b) => b.score - a.score).flatMap((h) => {
      const t = hitText(snap, h.id);
      return t ? [{ ...t, score: h.score }] : [];
    }).slice(0, k);
  };
}
