import type { Octokit, Repo } from "./github.js";
import type { StoryImage } from "./review.js";

const BRANCH = "mergejudge-assets";
const statusOf = (e: unknown): number | undefined => (e as { status?: number } | null)?.status;

/** Public assets only. Unknown visibility fails closed, without attempting an upload. */
export async function branchStoryImage(ok: Octokit, repo: Repo, isPrivate: boolean | undefined,
  log: { info(m: string): void; warning(m: string): void }): Promise<StoryImage | undefined> {
  if (isPrivate === undefined) {
    try { isPrivate = (await ok.rest.repos.get({ ...repo })).data.private; } catch { /* unknown: text only */ }
  }
  if (isPrivate !== false) {
    log.info("PR story images disabled for private or unknown repository visibility; showing the text list.");
    return undefined;
  }
  return async ({ svg, hash, prNumber }) => {
    try {
      if (!/^[a-f0-9]{16}$/.test(hash) || !Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error("invalid asset path");
      const path = `pr-${prNumber}/${hash}.svg`;
      const url = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${BRANCH}/${path}`;
      let parent: string | undefined;
      let baseTree: string | undefined;
      try {
        parent = (await ok.rest.git.getRef({ ...repo, ref: `heads/${BRANCH}` })).data.object.sha;
      } catch (e) { if (statusOf(e) !== 404) throw e; }
      if (parent) baseTree = (await ok.rest.git.getCommit({ ...repo, commit_sha: parent })).data.tree.sha;
      const blob = await ok.rest.git.createBlob({ ...repo, content: svg, encoding: "utf-8" });
      if (parent) {
        const tree = await ok.rest.git.getTree({ ...repo, tree_sha: baseTree!, recursive: "1" });
        if (tree.data.tree.some(e => e.path === path && e.sha === blob.data.sha)) return url;
      }
      const tree = await ok.rest.git.createTree({ ...repo, ...(baseTree ? { base_tree: baseTree } : {}),
        tree: [{ path, mode: "100644", type: "blob", sha: blob.data.sha }] });
      const commit = await ok.rest.git.createCommit({ ...repo, message: `PR story #${prNumber} (${hash})`, tree: tree.data.sha, parents: parent ? [parent] : [] });
      if (parent) await ok.rest.git.updateRef({ ...repo, ref: `heads/${BRANCH}`, sha: commit.data.sha, force: false });
      else await ok.rest.git.createRef({ ...repo, ref: `refs/heads/${BRANCH}`, sha: commit.data.sha });
      return url;
    } catch {
      log.warning("PR story image upload unavailable (requires contents: write); showing the text list.");
      return null;
    }
  };
}
