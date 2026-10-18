import { allChunks, chunkById, embeddingText, type IndexSnapshot } from "./deepindex.js";

/** Embeddings + vector search for `semantic_search`. Interfaces here; Cloudflare bindings are thin adapters. */

export interface Embedder {
  readonly dims: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface VectorMeta { path: string; start: number; end: number }
export interface VectorItem { id: string; vector: number[]; meta: VectorMeta }
export interface VectorHit { id: string; score: number; meta: VectorMeta }

export interface VectorStore {
  upsert(items: VectorItem[]): Promise<void>;
  query(vector: number[], k: number): Promise<VectorHit[]>;
  deleteIds(ids: string[]): Promise<void>;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * (b[i] ?? 0); na += a[i]! * a[i]!; nb += (b[i] ?? 0) * (b[i] ?? 0); }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** In-process store: used when Vectorize is not bound or `index.policy` is `none`. Nothing leaves memory. */
export class MemoryVectorStore implements VectorStore {
  private items = new Map<string, VectorItem>();
  get size() { return this.items.size; }
  async upsert(items: VectorItem[]) { for (const i of items) this.items.set(i.id, i); }
  async deleteIds(ids: string[]) { for (const id of ids) this.items.delete(id); }
  async query(vector: number[], k: number): Promise<VectorHit[]> {
    return [...this.items.values()]
      .map((i) => ({ id: i.id, score: cosine(vector, i.vector), meta: i.meta }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, k);
  }
}

/** The slice of a Cloudflare Vectorize index binding (`env.VECTORIZE`) used here. */
export interface VectorizeIndexLike {
  upsert(vectors: { id: string; values: number[]; namespace?: string; metadata?: Record<string, string | number> }[]): Promise<unknown>;
  query(vector: number[], opts: { topK: number; namespace?: string; returnMetadata?: "all" | "indexed" | "none" }):
    Promise<{ matches: { id: string; score: number; metadata?: Record<string, unknown> | null }[] }>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

/** Vectorize ids are limited to 64 bytes, so the readable chunk id (path#n) lives in metadata and a hash (of namespace + chunk id) is the id. */
export async function vectorizeId(chunkId: string, namespace = ""): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${namespace}\u0000${chunkId}`));
  return [...new Uint8Array(d).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const VECTORIZE_BATCH = 500;

/** One Vectorize namespace per repo id, so one repo's vectors can never be returned for another. */
export class VectorizeStore implements VectorStore {
  constructor(private index: VectorizeIndexLike, readonly namespace: string) {}
  async upsert(items: VectorItem[]) {
    for (let i = 0; i < items.length; i += VECTORIZE_BATCH) {
      const batch = await Promise.all(items.slice(i, i + VECTORIZE_BATCH).map(async (it) => ({
        id: await vectorizeId(it.id, this.namespace), values: it.vector, namespace: this.namespace,
        metadata: { cid: it.id, path: it.meta.path, start: it.meta.start, end: it.meta.end },
      })));
      await this.index.upsert(batch);
    }
  }
  async query(vector: number[], k: number): Promise<VectorHit[]> {
    const r = await this.index.query(vector, { topK: k, namespace: this.namespace, returnMetadata: "all" });
    return r.matches.flatMap((m) => {
      const md = m.metadata ?? {};
      return typeof md.cid === "string"
        ? [{ id: md.cid, score: m.score, meta: { path: String(md.path ?? ""), start: Number(md.start ?? 0), end: Number(md.end ?? 0) } }]
        : [];
    });
  }
  async deleteIds(ids: string[]) {
    const hashed = await Promise.all(ids.map((id) => vectorizeId(id, this.namespace)));
    for (let i = 0; i < hashed.length; i += VECTORIZE_BATCH) await this.index.deleteByIds(hashed.slice(i, i + VECTORIZE_BATCH));
  }
}

/** The slice of the Workers AI binding used for embeddings. */
export interface EmbedAiBinding { run(model: string, input: Record<string, unknown>): Promise<unknown> }

export const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";
export const EMBED_DIMS = 384; // keep in sync with the Vectorize index (`--dimensions=384`)

export class WorkersAiEmbedder implements Embedder {
  constructor(private ai: EmbedAiBinding, private model = EMBED_MODEL, readonly dims = EMBED_DIMS, private batch = 32) {}
  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batch) {
      const r = (await this.ai.run(this.model, { text: texts.slice(i, i + this.batch) })) as { data?: number[][] };
      if (!Array.isArray(r?.data) || r.data.length !== Math.min(this.batch, texts.length - i)) throw new Error("Workers AI embedding response had the wrong shape");
      out.push(...r.data);
    }
    return out;
  }
}

/** Deterministic offline embedder (hashed identifier/word bag). For tests and evals; no network. */
export class HashEmbedder implements Embedder {
  constructor(readonly dims = 256) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dims).fill(0);
      for (const w of t.split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/).map((x) => x.toLowerCase()).filter((x) => x.length > 2)) {
        let h = 2166136261;
        for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
        v[(h >>> 0) % this.dims]! += 1;
      }
      return v;
    });
  }
}

/** Embed chunks (all, or just `ids`) and put them in the store. Returns how many were stored. */
export async function embedChunks(
  snap: IndexSnapshot, embedder: Embedder, store: VectorStore, ids?: string[], max = Infinity,
): Promise<number> {
  const chunks = (ids ? ids.flatMap((id) => chunkById(snap, id) ?? []) : allChunks(snap)).slice(0, max);
  if (!chunks.length) return 0;
  const vectors = await embedder.embed(chunks.map(embeddingText));
  await store.upsert(chunks.map((c, i) => ({ id: c.id, vector: vectors[i]!, meta: { path: c.path, start: c.start, end: c.end } })));
  return chunks.length;
}
