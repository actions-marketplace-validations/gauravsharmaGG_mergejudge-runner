/**
 * The runner's on-disk cache for local code review (all under $MERGEJUDGE_HOME, default ~/.mergejudge):
 *   repos/<owner>__<repo>.git            persistent partial bare clone
 *   idx/<owner>__<repo>/<sha>.json       index snapshots (symbols, import graph, code chunks), `latest` = sha of the newest
 *   idx/<owner>__<repo>/.last-used       touched by every job on the repo (LRU)
 *   locks/<owner>__<repo>.lock           cross-process lock (directory), plus an in-process queue
 * The snapshot files hold chunks of source code, so they stay on the runner's disk like the clone itself.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeSnapshot, encodeSnapshot, type IndexSnapshot } from "../core/deepindex.js";

const DAY = 86_400_000, GB = 1024 ** 3;
export interface CachePolicy {
  /** Total size of repos/ + idx/ above which least-recently-used repos are evicted. */
  maxBytes: number;
  /** Snapshots kept per repo (the newest ones). */
  keepSnapshots: number;
  /** A repo untouched for this long is evicted. */
  maxAgeMs: number;
}
export const DEFAULT_CACHE: CachePolicy = { maxBytes: 5 * GB, keepSnapshots: 3, maxAgeMs: 30 * DAY };

export interface CachePaths { home: string; repos: string; idx: string; locks: string }
export function cachePaths(env: Record<string, string | undefined> = process.env, home: string = homedir()): CachePaths {
  const base = env.MERGEJUDGE_HOME && env.MERGEJUDGE_HOME.startsWith("/") ? env.MERGEJUDGE_HOME : join(home, ".mergejudge");
  return { home: base, repos: join(base, "repos"), idx: join(base, "idx"), locks: join(base, "locks") };
}

/** Policy from the environment (MERGEJUDGE_CACHE_MAX_GB / _KEEP_SNAPSHOTS / _MAX_AGE_DAYS) over the defaults; bad values are ignored. */
export function cachePolicyFromEnv(env: Record<string, string | undefined>, base: CachePolicy = DEFAULT_CACHE): CachePolicy {
  const num = (v: string | undefined) => { const n = Number(v); return v && Number.isFinite(n) && n > 0 ? n : null; };
  const gb = num(env.MERGEJUDGE_CACHE_MAX_GB), keep = num(env.MERGEJUDGE_CACHE_KEEP_SNAPSHOTS), days = num(env.MERGEJUDGE_CACHE_MAX_AGE_DAYS);
  return { maxBytes: gb ? Math.floor(gb * GB) : base.maxBytes, keepSnapshots: keep ? Math.max(1, Math.floor(keep)) : base.keepSnapshots, maxAgeMs: days ? days * DAY : base.maxAgeMs };
}

export const repoKey = (owner: string, repo: string): string => `${owner}__${repo}`;
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// ---------------- locking ----------------
const queues = new Map<string, Promise<unknown>>();
const STALE_LOCK_MS = 30 * 60_000;
const sleepMs = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => {
  const t = setTimeout(done, ms); function done() { clearTimeout(t); signal?.removeEventListener("abort", done); r(); }
  signal?.addEventListener("abort", done, { once: true });
});

/** Runs `fn` while holding the repo's lock: first in this process (queue), then across processes (lock directory, stale after 30 min). */
export async function withRepoLock<T>(paths: CachePaths, key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const chain = prev.then(() => mine);
  queues.set(key, chain);
  await prev.catch(() => {});
  try {
    mkdirSync(paths.locks, { recursive: true });
    const lock = join(paths.locks, `${key}.lock`);
    for (;;) {
      if (signal?.aborted) throw new Error("cancelled while waiting for the repo lock");
      try { mkdirSync(lock); break; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try { if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { recursive: true, force: true }); } catch { /* raced */ }
        await sleepMs(200, signal);
      }
    }
    const beat = setInterval(() => { try { utimesSync(lock, new Date(), new Date()); } catch { /* gone */ } }, 60_000);
    beat.unref?.();
    try { return await fn(); } finally { clearInterval(beat); rmSync(lock, { recursive: true, force: true }); }
  } finally {
    release();
    void chain.then(() => { if (queues.get(key) === chain) queues.delete(key); });
  }
}

// ---------------- snapshots ----------------
export class SnapshotStore {
  constructor(readonly dir: string) {}
  private file(sha: string) { return join(this.dir, `${sha}.json`); }
  get(sha: string): IndexSnapshot | null {
    try { return decodeSnapshot(readFileSync(this.file(sha), "utf8")); } catch { return null; }
  }
  latestSha(): string | null {
    try { const s = readFileSync(join(this.dir, "latest"), "utf8").trim(); return /^[0-9a-f]{7,64}$/.test(s) ? s : null; } catch { return null; }
  }
  latest(): IndexSnapshot | null { const s = this.latestSha(); return s ? this.get(s) : null; }
  /** Atomic: snapshot first, then the pointer. */
  put(snap: IndexSnapshot): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = join(this.dir, `.${snap.sha}.${process.pid}.tmp`);
    writeFileSync(tmp, encodeSnapshot(snap));
    renameSync(tmp, this.file(snap.sha));
    const ptmp = join(this.dir, `.latest.${process.pid}.tmp`);
    writeFileSync(ptmp, snap.sha);
    renameSync(ptmp, join(this.dir, "latest"));
  }
  /** Snapshot shas, newest first. */
  list(): { sha: string; mtime: number }[] {
    try {
      return readdirSync(this.dir).filter((f) => /^[0-9a-f]{7,64}\.json$/.test(f))
        .map((f) => ({ sha: f.slice(0, -5), mtime: statSync(join(this.dir, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
    } catch { return []; }
  }
  /** Keeps the newest `keep` snapshots and always `latest`; returns the removed and the kept shas. */
  prune(keep: number): { removed: string[]; kept: string[] } {
    const latest = this.latestSha();
    const all = this.list();
    const kept = new Set(all.slice(0, keep).map((s) => s.sha));
    if (latest) kept.add(latest);
    const removed: string[] = [];
    for (const s of all) if (!kept.has(s.sha)) { rmSync(this.file(s.sha), { force: true }); removed.push(s.sha); }
    return { removed, kept: [...kept] };
  }
}

export function touchRepo(paths: CachePaths, key: string, now = Date.now()): void {
  const dir = join(paths.idx, key);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, ".last-used");
  writeFileSync(f, String(now));
  utimesSync(f, new Date(now), new Date(now));
}

// ---------------- cleanup ----------------
function dirSize(p: string): number {
  let total = 0;
  let st;
  try { st = statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  for (const e of readdirSync(p)) total += dirSize(join(p, e));
  return total;
}
const listKeys = (dir: string, suffix = ""): string[] => {
  try { return readdirSync(dir).filter((f) => f.endsWith(suffix) && !f.startsWith(".")).map((f) => f.slice(0, f.length - suffix.length)); } catch { return []; }
};

export interface CleanupResult { prunedSnapshots: number; evicted: { key: string; reason: "age" | "size" }[]; bytes: number }

/**
 * After a job: (1) per repo keep the newest N snapshots, (2) evict repos untouched for maxAgeMs, (3) while repos/ + idx/ is over maxBytes,
 * evict the least recently used repo. Repos in `inUse` (this process) or with a fresh lock (another process) are never touched.
 */
export function cleanupCache(paths: CachePaths, policy: CachePolicy, inUse: ReadonlySet<string> = new Set(), now = Date.now()): CleanupResult {
  const keys = [...new Set([...listKeys(paths.repos, ".git"), ...listKeys(paths.idx)])];
  const busy = (k: string) => {
    if (inUse.has(k)) return true;
    try { return Date.now() - statSync(join(paths.locks, `${k}.lock`)).mtimeMs < STALE_LOCK_MS; } catch { return false; }
  };
  let pruned = 0;
  for (const k of keys) if (!busy(k)) pruned += new SnapshotStore(join(paths.idx, k)).prune(policy.keepSnapshots).removed.length;
  const lastUsed = (k: string): number => {
    try { return statSync(join(paths.idx, k, ".last-used")).mtimeMs; } catch {
      try { return statSync(join(paths.repos, `${k}.git`)).mtimeMs; } catch { return 0; }
    }
  };
  const evicted: CleanupResult["evicted"] = [];
  const evict = (k: string, reason: "age" | "size") => {
    rmSync(join(paths.repos, `${k}.git`), { recursive: true, force: true });
    rmSync(join(paths.idx, k), { recursive: true, force: true });
    evicted.push({ key: k, reason });
  };
  let live = keys.filter((k) => !(!busy(k) && now - lastUsed(k) > policy.maxAgeMs));
  for (const k of keys) if (!live.includes(k)) evict(k, "age");
  const sizes = new Map(live.map((k) => [k, dirSize(join(paths.repos, `${k}.git`)) + dirSize(join(paths.idx, k))]));
  let total = [...sizes.values()].reduce((a, b) => a + b, 0);
  for (const k of [...live].sort((a, b) => lastUsed(a) - lastUsed(b))) {
    if (total <= policy.maxBytes) break;
    if (busy(k)) continue;
    evict(k, "size");
    total -= sizes.get(k) ?? 0;
    live = live.filter((x) => x !== k);
  }
  return { prunedSnapshots: pruned, evicted, bytes: total };
}
export const cacheExists = (paths: CachePaths): boolean => existsSync(paths.home);
