import { describe, expect, it, vi } from "vitest";
import { branchStoryImage } from "../core/storyhost.js";
import type { Octokit } from "../core/github.js";
const repo = { owner: "owner", repo: "repo" };
const asset = { svg: "<svg/>", hash: "1234567890abcdef", prNumber: 7 };
function fake(exists = false, same = false) {
  const git = {
    getRef: vi.fn(async () => { if (!exists) throw { status: 404 }; return { data: { object: { sha: "parent" } } }; }),
    getCommit: vi.fn(async () => ({ data: { tree: { sha: "base" } } })),
    getTree: vi.fn(async () => ({ data: { tree: same ? [{ path: "pr-7/1234567890abcdef.svg", sha: "blob" }] : [] } })),
    createBlob: vi.fn(async () => ({ data: { sha: "blob" } })),
    createTree: vi.fn(async () => ({ data: { sha: "tree" } })),
    createCommit: vi.fn(async () => ({ data: { sha: "commit" } })),
    updateRef: vi.fn(async () => ({})), createRef: vi.fn(async () => ({})),
  };
  const repos = { get: vi.fn(async () => ({ data: { private: false } })) };
  const log = { info: vi.fn(), warning: vi.fn() };
  return { git, repos, log, ok: { rest: { git, repos } } as unknown as Octokit };
}
describe("public story branch", () => {
  it("creates an orphan commit when the branch is missing", async () => {
    const f = fake(); const hook = await branchStoryImage(f.ok, repo, false, f.log);
    expect(await hook!(asset)).toBe("https://raw.githubusercontent.com/owner/repo/mergejudge-assets/pr-7/1234567890abcdef.svg");
    expect(f.git.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parents: [], tree: "tree" }));
    expect(f.git.createTree).toHaveBeenCalledWith(expect.not.objectContaining({ base_tree: expect.anything() }));
    expect(f.git.createRef).toHaveBeenCalled(); expect(f.git.updateRef).not.toHaveBeenCalled();
  });
  it("appends a commit with the existing parent and base tree", async () => {
    const f = fake(true); await (await branchStoryImage(f.ok, repo, false, f.log))!(asset);
    expect(f.git.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parents: ["parent"] }));
    expect(f.git.createTree).toHaveBeenCalledWith(expect.objectContaining({ base_tree: "base" }));
    expect(f.git.updateRef).toHaveBeenCalledWith(expect.objectContaining({ force: false }));
  });
  it("skips a commit for the same path and blob", async () => {
    const f = fake(true, true); expect(await (await branchStoryImage(f.ok, repo, false, f.log))!(asset)).toMatch(/^https:/);
    expect(f.git.createCommit).not.toHaveBeenCalled();
  });
  it("never uploads to private or unknown repositories", async () => {
    const f = fake(); expect(await branchStoryImage(f.ok, repo, true, f.log)).toBeUndefined();
    expect(f.repos.get).not.toHaveBeenCalled();
    f.repos.get.mockRejectedValueOnce(new Error("unknown"));
    expect(await branchStoryImage(f.ok, repo, undefined, f.log)).toBeUndefined();
    expect(f.git.createBlob).not.toHaveBeenCalled(); expect(f.log.info).toHaveBeenCalled();
  });
  it("resolves unknown visibility through repos.get", async () => {
    const f = fake(); expect(await branchStoryImage(f.ok, repo, undefined, f.log)).toBeTypeOf("function");
    expect(f.repos.get).toHaveBeenCalled();
  });
  it.each([403, 404, 500])("returns null on upload error %s", async status => {
    const f = fake(true); f.git.createBlob.mockRejectedValueOnce({ status });
    expect(await (await branchStoryImage(f.ok, repo, false, f.log))!(asset)).toBeNull(); expect(f.log.warning).toHaveBeenCalled();
  });
});
