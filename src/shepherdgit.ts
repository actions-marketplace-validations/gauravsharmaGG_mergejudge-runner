/** Git mechanics for Shepherd. Arguments go to git as an argv array (no shell); the push credential is built in memory and never logged. */
import { runGit } from "./git.js";

export interface Identity { name: string; email: string }

export const DEFAULT_IDENTITY: Identity = { name: "mergejudge-shepherd[bot]", email: "mergejudge-shepherd[bot]@users.noreply.github.com" };

const g = async (cwd: string, args: string[], input?: string) => (await runGit(args, { cwd, input })).stdout.trim();
const idArgs = (id: Identity) => ["-c", `user.name=${id.name}`, "-c", `user.email=${id.email}`, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];

export const headSha = (cwd: string) => g(cwd, ["rev-parse", "HEAD"]);
/** The commit a ref points to (full sha), or undefined when it does not resolve. */
export const refSha = async (cwd: string, ref: string): Promise<string | undefined> => (await runGit(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd, allowFail: true })).stdout.trim() || undefined;

/** Fetch and check out the PR head branch; false when the branch tip is no longer `expectSha` (it moved). Nothing is changed in that case beyond the checkout. */
export async function checkoutHead(cwd: string, headRef: string, expectSha: string): Promise<boolean> {
  await runGit(["fetch", "--no-tags", "origin", `+refs/heads/${headRef}:refs/remotes/origin/${headRef}`], { cwd });
  await runGit(["checkout", "-q", "-B", headRef, `refs/remotes/origin/${headRef}`], { cwd });
  return (await headSha(cwd)) === expectSha;
}

/** Throw away every local change (tracked and untracked) and any merge in progress. */
export async function resetClean(cwd: string): Promise<void> {
  await runGit(["merge", "--abort"], { cwd, allowFail: true });
  await runGit(["reset", "-q", "--hard", "HEAD"], { cwd });
  await runGit(["clean", "-qfd"], { cwd });
}

export interface Staged { files: string[]; lines: number }

/** Stage everything and measure it: changed paths and added + removed lines (a binary file counts as 1000 lines). */
export async function stageAll(cwd: string, paths?: string[]): Promise<Staged> {
  await runGit(["add", "-A", ...(paths ? ["--", ...paths] : [])], { cwd });
  const out = await g(cwd, ["diff", "--cached", "--numstat", "-z", "HEAD", ...(paths ? ["--", ...paths] : [])]);
  const files: string[] = [];
  let lines = 0;
  // -z numstat: "<add>\t<del>\t<path>\0" (renames: "<add>\t<del>\t\0<old>\0<new>\0")
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]!);
    if (!m) continue;
    let path = m[3]!;
    if (path === "") { path = parts[i + 2] ?? ""; i += 2; }
    files.push(path);
    lines += m[1] === "-" ? 1000 : Number(m[1]) + Number(m[2]);
  }
  return { files, lines };
}

/** Commit what is staged (or finish a merge in progress) and return the new sha. Hooks are off. */
export async function commitStaged(cwd: string, message: string, id: Identity): Promise<string> {
  await runGit([...idArgs(id), "commit", "-q", "--no-verify", "-F", "-"], { cwd, input: message });
  return headSha(cwd);
}

export type PushResult = "pushed" | "rejected";

/**
 * Push HEAD to the PR branch. Never forced: a non-fast-forward is "rejected" (the branch moved). The credential is a
 * one-off extraheader that replaces any header actions/checkout stored; it appears only in this process's argv.
 */
export async function pushHead(cwd: string, headRef: string, o: { token: string; serverUrl?: string; onSecret?: (s: string) => void }): Promise<PushResult> {
  const server = (o.serverUrl ?? "https://github.com").replace(/\/$/, "");
  const b64 = Buffer.from(`x-access-token:${o.token}`).toString("base64");
  o.onSecret?.(b64);
  const key = `http.${server}/.extraheader`;
  const r = await runGit(["-c", `${key}=`, "-c", `${key}=AUTHORIZATION: basic ${b64}`, "push", "origin", `HEAD:refs/heads/${headRef}`], { cwd, allowFail: true });
  if (r.code === 0) return "pushed";
  if (/non-fast-forward|fetch first|\[rejected\]|failed to push some refs|stale info/i.test(r.stderr)) return "rejected";
  throw new Error(`git push failed (${r.code})`);
}

export type MergeStart =
  | { state: "uptodate" }
  | { state: "clean" }
  | { state: "conflict"; conflicted: string[] };

/** Begin merging the base branch into HEAD without committing. Never a rebase. diff3 markers let the classifier honour removed lines. */
export async function startMerge(cwd: string, baseRef: string, id: Identity = DEFAULT_IDENTITY): Promise<MergeStart> {
  await runGit(["fetch", "--no-tags", "origin", `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`], { cwd });
  const r = await runGit([...idArgs(id), "-c", "merge.conflictStyle=diff3", "merge", "--no-ff", "--no-commit", `refs/remotes/origin/${baseRef}`], { cwd, allowFail: true });
  if (r.code === 0) return /Already up to date/i.test(r.stdout) ? { state: "uptodate" } : { state: "clean" };
  const conflicted = (await g(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
  if (!conflicted.length) {
    await runGit(["merge", "--abort"], { cwd, allowFail: true });
    throw new Error(`git merge failed (${r.code})`);
  }
  return { state: "conflict", conflicted };
}

/** Every path the merge in progress brings into the PR branch: staged index against the PR head. Renames are split, so both sides show. */
export async function incomingPaths(cwd: string, headSha: string): Promise<string[]> {
  return (await g(cwd, ["diff", "--cached", "--name-only", "--no-renames", "-z", headSha])).split("\0").filter(Boolean);
}

export const mergeBase = (cwd: string, baseRef: string) => g(cwd, ["merge-base", "HEAD", `refs/remotes/origin/${baseRef}`]);

/** Paths the PR changed relative to the merge base. */
export async function changedByPr(cwd: string, base: string): Promise<Set<string>> {
  return new Set((await g(cwd, ["diff", "--name-only", "-z", base, "HEAD"])).split("\0").filter(Boolean));
}

/** A file's content from an index stage during a merge: 2 = ours (PR head), 3 = theirs (base). */
export async function stageContent(cwd: string, stage: 2 | 3, path: string): Promise<string> {
  return (await runGit(["show", `:${stage}:${path}`], { cwd, allowFail: true })).stdout;
}

export const takeTheirs = (cwd: string, path: string) => runGit(["checkout", "--theirs", "--", path], { cwd }).then(() => undefined);
