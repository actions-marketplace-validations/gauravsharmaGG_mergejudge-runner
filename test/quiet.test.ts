import { describe, expect, it } from "vitest";
import { validateAgainstFiles, parseTriageOutput } from "../core/triage.js";
import { planInline } from "../core/inline.js";
import { renderComment, CHECK_NAME } from "../core/render.js";
import { quoteInPatch } from "../core/rubrics.js";

const patch = "@@ -1,2 +1,3 @@\n keep\n+const token = readSecret();\n+return token;";
const files = [{ path: "a.ts", status: "modified", additions: 2, deletions: 0, patch }] as never;
const run = (findings: object[]) =>
  validateAgainstFiles(parseTriageOutput(JSON.stringify({ summary: "s", files: [{ path: "a.ts", lane: "review", findings }] })), files);

describe("quiet evidence gate", () => {
  it("quoteInPatch normalises whitespace, +/-, L prefix, and needs 4+ chars", () => {
    expect(quoteInPatch("+const   token = readSecret();", patch)).toBe(true);
    expect(quoteInPatch("L2 +const token = readSecret();", patch)).toBe(true);
    expect(quoteInPatch("abc", patch)).toBe(false);
    expect(quoteInPatch("not in diff", patch)).toBe(false);
  });

  it("keeps the line for a verified quote, so it is inline-eligible", () => {
    const llm = run([{ line: 2, quote: "const token = readSecret();", message: "secret read" }]);
    expect(llm.findings[0]).toMatchObject({ line: 2, quote: "const token = readSecret();" });
    expect(planInline(llm.findings, []).create).toHaveLength(1);
  });

  it("strips the line for missing, empty or wrong quotes", () => {
    const llm = run([
      { line: 2, message: "no quote" },
      { line: 2, quote: "  ", message: "empty quote" },
      { line: 3, quote: "something else entirely", message: "wrong quote" },
    ]);
    expect(llm.findings).toHaveLength(3);
    expect(llm.findings.every((f) => f.line === undefined)).toBe(true);
    expect(planInline(llm.findings, []).create).toHaveLength(0);
  });

  it("lists unverified findings under needs human with a count, plus the lane coach", () => {
    const llm = run([{ line: 2, message: "no <quote>" }, { line: 3, message: "also none" }]);
    const agg = { lane: "review", summary: "x", files: [], labelReasons: [], reasons: [] } as never;
    const md = renderComment({ agg, mode: "m", tokensEstimate: 0, notes: [], fileFindings: llm.findings });
    expect(md).toContain("Needs human (2)");
    expect(md).toContain("2 findings need human validation (no verified diff quote)");
    expect(md).toContain("no \\<quote\\>");
    expect(md).toContain("`review` is advisory");
    expect(md).toContain("`neutral`");
    expect(md).toContain(`require the check \`${CHECK_NAME}\``);
  });
});
