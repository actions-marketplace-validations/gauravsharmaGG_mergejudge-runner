import { describe, expect, it } from "vitest";
import { MERGE_NOTE, renderComment } from "../core/render.js";

const agg = { lane: "review" as const, files: [], labelReasons: [], summary: "s", rubric: [] };

describe("comment footer", () => {
  it("states the merge behaviour, including approval.mode auto-merge-only", () => {
    expect(MERGE_NOTE).toBe(
      "MergeJudge doesn't merge PRs itself (unless you turned on approval.mode: auto-merge-only, which asks GitHub to auto-merge auto-lane PRs)",
    );
    const md = renderComment({ agg, mode: "rules-only", tokensEstimate: 0, notes: [] });
    expect(md).toContain(` · ${MERGE_NOTE}</sub>`);
    expect(md).not.toContain("never merges");
  });
});
