/**
 * Deep mode for the Action: repo context read from the `actions/checkout` workspace (GITHUB_WORKSPACE).
 * The same retrieval as the runner's deep-local mode (core/deepindex.ts + core/deepretrieve.ts), but the files come from the
 * checked-out working tree instead of a git clone, and no hosted indexer is involved: the index lives in memory for this run only.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Config } from "../core/config.js";
import type { ContextPiece } from "../core/context.js";
import { buildIndex, JOB_LIMITS, type IndexLimits, type IndexSource } from "../core/deepindex.js";
import { retrieveDeepContext } from "../core/deepretrieve.js";
import { excludeFromLlm } from "../core/rules.js";
import type { PrFile } from "../core/types.js";
import { runGit } from "./git.js";

/** The workspace is a fresh checkout on a CI machine: a bit more room than the hosted index, far less than a long-lived clone. */
export const WORKSPACE_LIMITS: IndexLimits = { ...JOB_LIMITS, maxFiles: 5_000, maxTotalBytes: 50_000_000, maxMs: 120_000 };
const MAX_READ_BYTES = 1_000_000;

export class WorkspaceError extends Error {}

/** Tracked files of the checkout. Reads never leave the workspace: symlinks and over-large or binary files return null. */
export class WorkspaceSource implements IndexSource {
  private root: string;
  constructor(dir: string) {
    try { this.root = realpathSync(dir); } catch { throw new WorkspaceError(`workspace ${dir} does not exist`); }
  }

  async listPaths(): Promise<string[]> {
    const r = await runGit(["ls-files", "-z", "--cached"], { cwd: this.root, allowFail: true, maxBytes: 64 * 1024 * 1024 });
    if (r.code !== 0) throw new WorkspaceError("the workspace is not a git checkout (add an actions/checkout step before MergeJudge)");
    return r.stdout.split("\0").filter(Boolean);
  }

  async readFile(path: string): Promise<string | null> {
    const abs = resolve(this.root, path);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) return null;
    try {
      const st = lstatSync(abs);
      if (!st.isFile() || st.size > MAX_READ_BYTES) return null; // lstat: a symlink is not a regular file, so it is never followed
      const real = realpathSync(abs);
      if (!real.startsWith(this.root + sep)) return null;
      const buf = readFileSync(real);
      return buf.includes(0) ? null : buf.toString("utf8");
    } catch { return null; }
  }
}

export interface WorkspaceDeep { pieces: ContextPiece[]; notes: string[] }

/** Index the checkout, then retrieve what the changed files touch (importers, imports, callers, changed strings). Throws WorkspaceError to fall back to context. */
export async function retrieveFromWorkspace(
  dir: string, kept: PrFile[], cfg: Pick<Config, "diff_exclude">, repoName: string, log: (m: string) => void,
  limits: IndexLimits = WORKSPACE_LIMITS,
): Promise<WorkspaceDeep> {
  const src = new WorkspaceSource(dir);
  const head = (await runGit(["rev-parse", "HEAD"], { cwd: dir, allowFail: true })).stdout.trim() || "workspace";
  const built = await buildIndex(src, { repo: repoName, sha: head }, limits).catch((e) => {
    if (e instanceof WorkspaceError) throw e;
    throw new WorkspaceError(`could not list the workspace files: ${(e as Error).message}`);
  });
  if (!built.snapshot) throw new WorkspaceError("could not list the workspace files");
  const skip = (p: string) => excludeFromLlm([{ path: p }], cfg.diff_exclude).skipped.length > 0;
  const r = await retrieveDeepContext(built.snapshot, kept, { skip }, log);
  const notes = [`Deep mode from the Actions checkout (${head.slice(0, 7)}): repo context was retrieved from an in-memory index of the checked-out files and reviewed in one pass (no tool calls).`];
  if (built.snapshot.partial) notes.push(`index is partial (${built.snapshot.partial.indexed}/${built.snapshot.partial.total} files: ${built.snapshot.partial.reason})`);
  return { pieces: r.pieces, notes };
}
