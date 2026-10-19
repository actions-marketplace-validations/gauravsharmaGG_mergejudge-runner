import { describe, expect, it } from "vitest";
import { AUTO_MERGE_NOTE, MERGE_NOTE, mergeNote, renderComment } from "../core/render.js";

const agg = { lane: "review" as const, files: [], labelReasons: [], summary: "s", rubric: [] };
const render = (approval?: { enabled?: boolean; mode?: string } | null) =>
  renderComment({ agg, mode: "rules-only", tokensEstimate: 0, notes: [], approval });

describe("comment footer merge note", () => {
  it("has the exact cleared wording", () => {
    expect(MERGE_NOTE).toBe("MergeJudge doesn't merge PRs itself.");
    expect(AUTO_MERGE_NOTE).toBe("With approval.mode: auto-merge-only, it asks GitHub to auto-merge auto-lane PRs.");
  });

  it("says only the first sentence without auto-merge-only", () => {
    for (const a of [undefined, null, { enabled: false, mode: "auto-merge-only" }, { enabled: true, mode: "none" }, { enabled: true, mode: "bot-approve" }]) {
      const md = render(a);
      expect(md).toContain(" · MergeJudge doesn't merge PRs itself.</sub>");
      expect(md).not.toContain("auto-merge-only");
      expect(md).not.toContain("never merges");
    }
  });

  it("adds the auto-merge sentence when approval is enabled with mode auto-merge-only", () => {
    expect(mergeNote({ enabled: true, mode: "auto-merge-only" })).toBe(`${MERGE_NOTE} ${AUTO_MERGE_NOTE}`);
    expect(render({ enabled: true, mode: "auto-merge-only" }))
      .toContain(" · MergeJudge doesn't merge PRs itself. With approval.mode: auto-merge-only, it asks GitHub to auto-merge auto-lane PRs.</sub>");
  });
});
