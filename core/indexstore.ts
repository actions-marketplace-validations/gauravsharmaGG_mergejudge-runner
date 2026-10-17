// Vendored from the MergeJudge core. Keep in sync.
import { decodeSnapshot, encodeSnapshot, latestKey, snapshotKey, type IndexSnapshot } from "./deepindex.js";

/** The slice of a Cloudflare R2 bucket binding (`env.INDEX_BUCKET`) used here. */
export interface R2BucketLike {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(opts: { prefix?: string; cursor?: string; limit?: number }):
    Promise<{ objects: { key: string; uploaded?: Date }[]; truncated: boolean; cursor?: string }>;
}

const SHA = /^[0-9a-f]{7,64}$/i;
export const KEEP_SNAPSHOTS = 3;

/** Index snapshots in R2: `idx/<installationId>/<repoId>/<sha>.json` plus a `latest` pointer. Tenant-scoped by key prefix. */
export class R2IndexStore {
  constructor(private bucket: R2BucketLike, private keep = KEEP_SNAPSHOTS) {}

  async latest(installationId: number, repoId: number): Promise<IndexSnapshot | null> {
    const ptr = await this.bucket.get(latestKey(installationId, repoId));
    if (!ptr) return null;
    let sha: unknown;
    try { sha = (JSON.parse(await ptr.text()) as { sha?: unknown }).sha; } catch { return null; }
    if (typeof sha !== "string" || !SHA.test(sha)) return null;
    const obj = await this.bucket.get(snapshotKey(installationId, repoId, sha));
    if (!obj) return null;
    try { return decodeSnapshot(await obj.text()); } catch { return null; }
  }

  /** Write the snapshot, then move `latest`, then drop all but the newest `keep` snapshots. */
  async put(installationId: number, repoId: number, snap: IndexSnapshot): Promise<void> {
    if (!SHA.test(snap.sha)) throw new Error("invalid snapshot sha");
    await this.bucket.put(snapshotKey(installationId, repoId, snap.sha), encodeSnapshot(snap));
    await this.bucket.put(latestKey(installationId, repoId), JSON.stringify({ sha: snap.sha }));
    const prefix = `idx/${installationId}/${repoId}/`;
    const objs = (await this.listAll(prefix)).filter((o) => o.key.endsWith(".json") && o.key !== snapshotKey(installationId, repoId, snap.sha));
    const old = objs.sort((a, b) => (b.uploaded?.getTime() ?? 0) - (a.uploaded?.getTime() ?? 0)).slice(Math.max(0, this.keep - 1));
    if (old.length) await this.bucket.delete(old.map((o) => o.key));
  }

  deleteRepo(installationId: number, repoId: number): Promise<number> {
    return this.deletePrefix(`idx/${installationId}/${repoId}/`);
  }
  deleteInstallation(installationId: number): Promise<number> {
    return this.deletePrefix(`idx/${installationId}/`);
  }

  private async listAll(prefix: string) {
    const out: { key: string; uploaded?: Date }[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.bucket.list({ prefix, cursor, limit: 1000 });
      out.push(...r.objects);
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
    return out;
  }
  private async deletePrefix(prefix: string): Promise<number> {
    const keys = (await this.listAll(prefix)).map((o) => o.key);
    for (let i = 0; i < keys.length; i += 500) await this.bucket.delete(keys.slice(i, i + 500));
    return keys.length;
  }
}
