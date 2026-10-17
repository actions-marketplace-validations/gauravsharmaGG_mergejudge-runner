// Vendored from the MergeJudge core. Keep in sync.
/** Git/contents write guard: MergeJudge may only write to the learning branch or proposal branches. */

export const PROPOSAL_BRANCH_PREFIX = "mergejudge/proposal-";
/** Head branch used by older versions for the learning proposal PR; still writable so that PR is updated in place. */
export const LEGACY_PROPOSAL_BRANCH = "mergejudge/learning-proposal";
export const FORBIDDEN_BRANCH_PATTERNS = [/^main$/i, /^master$/i, /^release([/-].*)?$/i];

export type WriteKind = "learning" | "proposal";

export interface WriteTarget {
  /** Branch name without refs/heads/ */
  branch: string;
  kind: WriteKind;
}

export class WriteGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteGuardError";
  }
}

/** True if a learning.branch name is unsafe (default branch name or protected pattern). */
export function isForbiddenLearningBranch(name: string, defaultBranch?: string): boolean {
  const n = name.trim();
  if (!n) return true;
  if (defaultBranch && n.toLowerCase() === defaultBranch.toLowerCase()) return true;
  return FORBIDDEN_BRANCH_PATTERNS.some((re) => re.test(n));
}

export function assertSafeLearningBranch(name: string, defaultBranch?: string): void {
  if (isForbiddenLearningBranch(name, defaultBranch)) {
    throw new WriteGuardError(
      `learning.branch "${name}" is forbidden (must not be the default branch or match main/master/release*)`,
    );
  }
}

/** Normalize refs/heads/X or heads/X → X */
export function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, "").replace(/^heads\//, "");
}

/**
 * Allow a write only when the target is the configured learning branch or a
 * `mergejudge/proposal-*` proposal branch. Never the default branch.
 */
export function assertWritableBranch(
  targetRef: string,
  opts: { learningBranch: string; defaultBranch?: string },
): WriteTarget {
  const branch = branchName(targetRef);
  const defaultBranch = opts.defaultBranch ?? "main";
  if (!branch) throw new WriteGuardError("empty branch ref");
  if (branch.toLowerCase() === defaultBranch.toLowerCase()) {
    throw new WriteGuardError(`refusing write to default branch "${branch}"`);
  }
  if (FORBIDDEN_BRANCH_PATTERNS.some((re) => re.test(branch)) && branch !== opts.learningBranch) {
    throw new WriteGuardError(`refusing write to protected-pattern branch "${branch}"`);
  }
  if (branch === opts.learningBranch) {
    assertSafeLearningBranch(opts.learningBranch, defaultBranch);
    return { branch, kind: "learning" };
  }
  if (branch === LEGACY_PROPOSAL_BRANCH) return { branch, kind: "proposal" };
  if (branch.startsWith(PROPOSAL_BRANCH_PREFIX) && branch.length > PROPOSAL_BRANCH_PREFIX.length) {
    return { branch, kind: "proposal" };
  }
  throw new WriteGuardError(
    `refusing write to "${branch}" (only "${opts.learningBranch}" or ${PROPOSAL_BRANCH_PREFIX}* allowed)`,
  );
}

/** Files a proposal branch may carry: the MergeJudge config and the record-only report. Never `.github/**`, never anything else. */
export const PROPOSAL_FILE_PATHS = [".mergejudge.yml", "MERGEJUDGE_LEARNING_PROPOSAL.md"];

export function assertProposalFilePath(path: string): void {
  if (!PROPOSAL_FILE_PATHS.includes(path)) {
    throw new WriteGuardError(`refusing to write "${path}" on a proposal branch (allowed: ${PROPOSAL_FILE_PATHS.join(", ")})`);
  }
}

export interface GitWriter {
  getRef(ref: string): Promise<{ sha: string }>;
  createRef(ref: string, sha: string): Promise<void>;
  deleteRef(ref: string): Promise<void>;
  updateRef(ref: string, sha: string, force: boolean): Promise<void>;
  /** Create a commit (blob/tree/commit) with one file on top of parentSha; moves no ref. Returns the commit SHA. */
  commitFile(opts: {
    parentSha: string; path: string; contentBase64: string; message: string;
  }): Promise<string>;
  /** Like commitFile for several files. */
  commitFiles(opts: {
    parentSha: string; files: { path: string; contentBase64: string }[]; message: string;
  }): Promise<string>;
  createOrUpdateFile(opts: {
    path: string; contentBase64: string; message: string; branch: string; sha?: string | null;
  }): Promise<void>;
}

/**
 * Single chokepoint for git/contents writes. All callers must use this instead of
 * ok.rest.repos.createOrUpdateFileContents / ok.rest.git.createRef / deleteRef.
 */
export function createGuardedWriter(
  raw: GitWriter,
  opts: { learningBranch: string; defaultBranch?: string },
): {
  ensureBranchFrom(defaultBranch: string): Promise<string>;
  readAllowed: true;
  writeFile(path: string, content: string, message: string, branch: string, sha: string | null): Promise<void>;
  createBranch(branch: string, sha: string): Promise<void>;
  deleteBranch(branch: string): Promise<void>;
  /** Like resetBranchToFileCommit for several files (proposal branches only; every path must be allowed). */
  resetBranchToFilesCommit(
    branch: string, baseSha: string, files: { path: string; content: string }[], message: string,
  ): Promise<string>;
  /** Point an allowed branch at a single new commit (one file on top of baseSha), force-updating its ref. */
  resetBranchToFileCommit(
    branch: string, baseSha: string, file: { path: string; content: string; message: string },
  ): Promise<string>;
} {
  assertSafeLearningBranch(opts.learningBranch, opts.defaultBranch);
  const allow = (branch: string) => assertWritableBranch(branch, opts);

  return {
    readAllowed: true,
    async ensureBranchFrom(defaultBranch: string): Promise<string> {
      allow(opts.learningBranch);
      try {
        return (await raw.getRef(`heads/${opts.learningBranch}`)).sha;
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e;
      }
      const base = await raw.getRef(`heads/${defaultBranch}`);
      // createRef target must pass the guard
      allow(opts.learningBranch);
      await raw.createRef(`refs/heads/${opts.learningBranch}`, base.sha);
      return base.sha;
    },
    async writeFile(path, content, message, branch, sha) {
      allow(branch);
      await raw.createOrUpdateFile({
        path, contentBase64: Buffer.from(content).toString("base64"), message, branch, sha,
      });
    },
    async createBranch(branch, sha) {
      allow(branch);
      await raw.createRef(`refs/heads/${branch}`, sha);
    },
    async resetBranchToFileCommit(branch, baseSha, file) {
      allow(branch);
      const sha = await raw.commitFile({
        parentSha: baseSha, path: file.path,
        contentBase64: Buffer.from(file.content).toString("base64"), message: file.message,
      });
      await raw.updateRef(`heads/${branch}`, sha, true);
      return sha;
    },
    async resetBranchToFilesCommit(branch, baseSha, files, message) {
      if (allow(branch).kind !== "proposal") throw new WriteGuardError(`multi-file commits are for proposal branches, not "${branch}"`);
      if (!files.length) throw new WriteGuardError("no files to commit");
      for (const f of files) assertProposalFilePath(f.path);
      const sha = await raw.commitFiles({
        parentSha: baseSha, message,
        files: files.map((f) => ({ path: f.path, contentBase64: Buffer.from(f.content).toString("base64") })),
      });
      await raw.updateRef(`heads/${branch}`, sha, true);
      return sha;
    },
    async deleteBranch(branch) {
      allow(branch);
      await raw.deleteRef(`heads/${branch}`);
    },
  };
}
