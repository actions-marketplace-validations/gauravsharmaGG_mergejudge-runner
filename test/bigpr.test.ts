import { describe, expect, it, vi } from "vitest";
import { isReasoningModel, perPrCap, resolveOutputLimit, storyOutputLimit } from "../core/budget.js";
import { parseConfig } from "../core/config.js";
import { createProvider } from "../core/llm/index.js";
import { LlmError } from "../core/llm/http.js";
import type { LlmProvider, LlmRequest, LlmResult, LlmUsage } from "../core/llm/provider.js";
import { WorkersAiProvider } from "../core/llm/workersai.js";
import { produceReviewResult, trimmedNote } from "../core/review.js";
import { buildStoryDiff, generateStory, STORY_SYSTEM_PROMPT, storyFailureLine } from "../core/storycall.js";
import { buildSystemPrompt, buildUserPrompt, cutPatch, estimateTokens, numberPatch, runTriage, sanitizeUntrusted, SYSTEM_PROMPT, TRUNCATION_RULES, waterFill, DELIM } from "../core/triage.js";
import type { PrFile } from "../core/types.js";

const cfgOf = (extra = "", model = "fake") => parseConfig(`provider:\n  type: openai\n  model: "${model}"\ncomment:\n  flow_chart: true\n${extra}`);
const noStory = (c: ReturnType<typeof cfgOf>) => { c.comment.flow_chart = false; return c; };
const tight = () => parseConfig("provider:\n  type: openai\n  model: fake\nbudget:\n  max_tokens_per_pr: 16000\n");

/** A patch of `n` added lines starting at line 1, one hunk. */
const patchOf = (n: number, tag = "x"): string => `@@ -0,0 +1,${n} @@\n` + Array.from({ length: n }, (_, i) => `+const ${tag}${i} = ${i};`).join("\n");

/** 66 files: 36 themed modules, a big file whose helper sits below any cut, 22 tests, a rename, a delete, docs, a lockfile. */
function bigPr(): PrFile[] {
  const themes = ["cart", "pricing", "shipping", "inventory", "payments", "orders", "notify", "util", "config"];
  const files: PrFile[] = [];
  for (const t of themes) for (let i = 0; i < 4; i++) files.push({ path: `src/${t}/mod${i}.js`, status: "added", additions: 40, deletions: 0, patch: patchOf(40, `${t}${i}_`) });
  // one big file whose helper sits below the cut
  files.push({ path: "src/cart/totals.js", status: "modified", additions: 700, deletions: 2, patch: patchOf(700, "tot") + "\n+function proportional(a, b) { return a / b; }" });
  for (let i = 0; i < 22; i++) files.push({ path: `test/t${i}.test.js`, status: "added", additions: 30, deletions: 0, patch: patchOf(30, `t${i}_`) });
  files.push({ path: "src/lib/math.js", previousPath: "src/math.js", status: "renamed", additions: 0, deletions: 0 });
  files.push({ path: "src/old.js", status: "removed", additions: 0, deletions: 12, patch: "@@ -1,12 +0,0 @@\n" + Array.from({ length: 12 }, (_, i) => `-old${i}`).join("\n") });
  for (let i = 0; i < 4; i++) files.push({ path: `docs/d${i}.md`, status: "added", additions: 20, deletions: 0, patch: patchOf(20, `d${i}_`) });
  files.push({ path: "package-lock.json", status: "modified", additions: 900, deletions: 100, patch: patchOf(900, "lock") });
  return files;
}

const reviewReply = (paths: string[]) => JSON.stringify({ summary: "big", files: paths.map((path) => ({ path, lane: "review", reason: "logic", findings: [] })) });
const storyReply = (paths: string[]) => JSON.stringify({ steps: [0, 1].map((i) => ({ title: `Step number ${i}`, change: "changed", refs: [{ path: paths[i]!, line: null }] })) });

interface Fake { provider: LlmProvider; calls: LlmRequest[] }
/** `story` and `review` answer the call by its purpose; `usage` reports provider-side token counts per call. */
function fake(o: { review: (n: number, req: LlmRequest) => Partial<LlmResult> | Error; story?: (req: LlmRequest) => Partial<LlmResult> | Error; usage?: (req: LlmRequest) => LlmUsage | null }): Fake {
  const calls: LlmRequest[] = [];
  let reviews = 0;
  const completeEx = async (req: LlmRequest): Promise<LlmResult> => {
    calls.push(req);
    const r = req.purpose === "story" ? o.story?.(req) ?? new Error("no story") : o.review(++reviews, req);
    if (r instanceof Error) throw r;
    return { text: "", truncated: false, usage: o.usage?.(req) ?? null, ...r };
  };
  return { calls, provider: { label: "fake", providerId: "openai", complete: async (r) => (await completeEx(r)).text, completeEx } };
}

const input = (files: PrFile[], cfg = cfgOf()) => ({
  pr: { number: 1, node_id: "n", head: { sha: "abcdef0" }, title: "Big", body: "" }, cfg, cfgRef: "main", files, log: { info: () => {}, warning: () => {} },
  readRepoFile: async () => null,
  contextSource: { listPaths: async () => [], readFile: async () => null, searchSymbol: async () => [] },
});
const notChecked = (body: string) => body.split("### Not checked")[1]?.split("---")[0] ?? "";

describe("(b) reasoning model ids", () => {
  it.each([
    "@cf/deepseek-ai/deepseek-v4.1-flash-1017", "deepseek-v4-pro", "openrouter/deepseek/deepseek-v4-flash", "deepseek-v10",
    "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", "deepseek-reasoner", "glm-5.1",
  ])("%s is reasoning-capable", (m) => {
    expect(isReasoningModel(m)).toBe(true);
    expect(resolveOutputLimit(cfgOf("", m))).toBe(8000);
  });
  it.each([
    "deepseek-chat", "deepseek-coder", "deepseek-coder-v2-instruct", "@cf/deepseek-ai/deepseek-v3.1", "deepseek-v3.1-terminus", "deepseek-v2.5",
    "@cf/meta/llama-4-scout-17b-16e-instruct", "gpt-4o", undefined,
  ])("%s is not", (m) => {
    expect(isReasoningModel(m)).toBe(false);
  });
});

describe("(c) story output cap and visible failures", () => {
  const f = [{ path: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }, { path: "b.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+y" }];
  const ok = (req: LlmRequest) => ({ text: storyReply(["a.ts", "b.ts"]), usage: null, ...(req ? {} : {}) });
  const log = { warning: vi.fn() };

  it("gives reasoning models a larger cap, never more than the budget has left", async () => {
    expect(storyOutputLimit("@cf/deepseek-ai/deepseek-v4.1-flash-1017")).toBe(4000);
    expect(storyOutputLimit("@cf/meta/llama-4-scout-17b-16e-instruct")).toBe(1200);
    const seen: number[] = [];
    const p = fake({ review: () => ({ text: "" }), story: (req) => { seen.push(req.maxOutputTokens); return ok(req); } }).provider;
    await generateStory(p, { files: f as PrFile[], findings: [], log, model: "deepseek-v4-flash" });
    await generateStory(p, { files: f as PrFile[], findings: [], log, model: "llama" });
    await generateStory(p, { files: f as PrFile[], findings: [], log, model: "deepseek-v4-flash", budgetLeft: 2400 });
    expect(seen[0]).toBe(4000); expect(seen[1]).toBe(1200);
    expect(seen[2]).toBeLessThan(4000); expect(seen[2]).toBeGreaterThanOrEqual(600);
  });

  it("returns a reason for each failure, and the comment says so", async () => {
    const cases: [string, (req: LlmRequest) => Partial<LlmResult> | Error, string][] = [
      ["truncated", () => ({ text: "{", truncated: true }), "PR story: not drawn (reply cut off at the output limit)"],
      ["timeout", () => new LlmError("timeout", { provider: "openai" }), "PR story: not drawn (timed out)"],
      ["invalid", () => ({ text: "not json" }), "PR story: not drawn (invalid reply)"],
      ["error", () => new LlmError("http_5xx", { provider: "openai" }), "PR story: not drawn (provider error)"],
    ];
    for (const [reason, story, line] of cases) {
      const g = await generateStory(fake({ review: () => ({}), story }).provider, { files: f as PrFile[], findings: [], log });
      expect(g).toMatchObject({ story: null, reason });
      expect(storyFailureLine(reason as never)).toBe(line);
      const p = fake({ review: () => ({ text: reviewReply(["a.ts", "b.ts"]) }), story });
      const r = await produceReviewResult({ ...input(f as PrFile[]), provider: p.provider });
      expect(notChecked(r.body)).toContain(line.replace(/[()]/g, "\\$&"));
    }
  });

  it("skips the story when the per-PR budget is used up, and says so", async () => {
    const p = fake({ review: () => ({ text: reviewReply(["a.ts", "b.ts"]) }), story: ok, usage: () => ({ input: 27500, output: 100, cacheRead: 0, cacheWrite: 0 }) });
    const r = await produceReviewResult({ ...input(f as PrFile[]), provider: p.provider });
    expect(p.calls.filter((c) => c.purpose === "story")).toHaveLength(0);
    expect(notChecked(r.body)).toContain("PR story: not drawn \\(skipped: per-PR token budget used up\\)");
  });
});

describe("(d) story diff coverage", () => {
  it("lists every file with a header and keeps the cap", () => {
    const files = bigPr();
    const { diff, trimmed, total } = buildStoryDiff(files, 24000);
    expect(total).toBe(files.length);
    for (const f of files) expect(diff).toContain(`### ${f.path} (`);
    expect(diff).toContain("### src/lib/math.js (renamed from src/math.js, +0/-0)");
    expect(diff).toContain("### src/old.js (removed, +0/-12)");
    expect(diff.length).toBeLessThanOrEqual(24000);
    expect(trimmed).toBeGreaterThan(0);
  });
  it("gives code more patch text than tests, and lockfiles least", () => {
    const { diff } = buildStoryDiff(bigPr(), 24000);
    const shown = (path: string) => (diff.match(new RegExp(`^L\\d+ \\+const ${path}`, "gm")) ?? []).length;
    expect(shown("tot")).toBeGreaterThan(shown("t3_"));
    expect(shown("lock")).toBeLessThan(shown("tot"));
    expect(diff).toMatch(/\[\.\.\. \d+ of \d+ diff lines not shown \.\.\.\]/);
  });
  it("leaves the story diff whole when it fits", () => {
    const small = [{ path: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }] as PrFile[];
    const b = buildStoryDiff(small, 24000);
    expect(b.trimmed).toBe(0);
    expect(b.diff).toBe("### a.ts (modified, +1/-0)\n@@ -1 +1 @@\nL1 +x");
  });
  it("is trimmed on a 68-file PR: the prompt says so, covers every file, and the comment shows one short line", async () => {
    const files = bigPr();
    const paths = files.map((f) => f.path);
    const p = fake({ review: () => ({ text: reviewReply(paths) }), story: () => ({ text: storyReply(["src/lib/math.js", "src/cart/mod0.js"]) }) });
    const r = await produceReviewResult({ ...input(files, cfgOf("budget:\n  max_tokens_per_pr: 100000\n")), provider: p.provider });
    const story = p.calls.find((c) => c.purpose === "story")!;
    for (const path of paths.filter((x) => x !== "package-lock.json")) expect(story.user).toContain(`### ${path} (`); // the lockfile is excluded from AI input by diff_exclude
    expect(story.user).toMatch(/^Diff trimmed: \d+ of 65 files shown in part or header only\./);
    expect(story.system).toContain("do not guess about code that is not shown");
    expect(story.system).toBe(STORY_SYSTEM_PROMPT);
    expect(r.story).not.toBeNull(); // header-only file referenced by path
    expect(notChecked(r.body)).toMatch(/PR story: drawn from a trimmed diff \\\(\d+ of 65 files partly or not shown\\\)/);
  });
});

describe("(e) review patch truncation", () => {
  const cfg = parseConfig("provider:\n  type: openai\n  model: fake\n");
  const fit: PrFile[] = [
    { path: "a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d" },
    { path: "b.md", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+hi" },
    { path: "bin.png", status: "added", additions: 0, deletions: 0 },
  ];

  it("keeps the prompts byte-identical for a PR that fits", () => {
    const b = buildUserPrompt({ title: "T", body: "B", files: fit }, cfg);
    const expected = `<${DELIM}>\nTitle: T\nDescription:\nB\n\nChanged files:\n` +
      fit.map((f) => `### ${f.path} (${f.status}, +${f.additions}/-${f.deletions})` + (f.patch ? "\n" + sanitizeUntrusted(numberPatch(f.patch)) : "")).join("\n\n") +
      `\n</${DELIM}>`;
    expect(b.prompt).toBe(expected);
    expect(b.trimmed).toEqual([]);
    expect(b.prompt).not.toContain("truncated");
    expect(buildSystemPrompt({})).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).not.toContain("truncated");
  });

  it("is also identical when one patch is bigger than the old even share but the PR fits", () => {
    const files: PrFile[] = [
      { path: "big.ts", status: "modified", additions: 3000, deletions: 0, patch: patchOf(3000) },
      { path: "tiny.ts", status: "modified", additions: 1, deletions: 0, patch: patchOf(1) },
    ];
    const b = buildUserPrompt({ title: "T", body: "", files }, cfg);
    expect(b.trimmed).toEqual([]);
    expect(b.prompt).toContain(sanitizeUntrusted(numberPatch(files[0]!.patch!)));
  });

  it("water-fills: small patches stay whole, big ones are cut with a marker, the total budget holds", () => {
    expect(waterFill([10, 1000, 1000], 1010)).toEqual([10, 500, 500]);
    expect(waterFill([5, 5], 100)).toEqual([5, 5]);
    expect(waterFill([100], 0)).toEqual([0]);
    const files = bigPr();
    const b = buildUserPrompt({ title: "T", body: "", files }, tight());
    expect(b.trimmed).toContain("src/cart/totals.js");
    expect(b.trimmed).toContain("package-lock.json");
    expect(b.trimmed).not.toContain("docs/d0.md"); // 20-line patch is below the fair share
    expect(b.prompt).toMatch(/### src\/cart\/totals\.js[^\n]*\n[\s\S]*?\[\.\.\. truncated by MergeJudge: \d+ of \d+ diff lines not shown; code outside the shown hunks exists and was not reviewed \.\.\.\]/);
    expect(b.prompt.endsWith(TRUNCATION_RULES)).toBe(true);
    expect(TRUNCATION_RULES).toContain("Do not report a symbol as undefined or missing, or a function as unused, based on a truncated patch");
    // same total budget semantics: the prompt (and the reply limit) stays inside max_tokens_per_pr
    expect(estimateTokens(b.prompt) + estimateTokens(SYSTEM_PROMPT) + resolveOutputLimit(tight())).toBeLessThanOrEqual(16000);
  });

  it("cuts at a hunk boundary when that wastes little", () => {
    const text = "@@ -1 +1,3 @@\nL1 +a\nL2 +b\nL3 +c\n@@ -9 +9,3 @@\nL9 +d\nL10 +e\nL11 +f";
    expect(cutPatch(text, 40)).toBe("@@ -1 +1,3 @@\nL1 +a\nL2 +b\nL3 +c");
    expect(cutPatch(text, text.length)).toBe(text);
  });

  it("returns the trimmed paths from runTriage and shows them in Not checked, capped at 5 names", async () => {
    const files = bigPr();
    const p = fake({ review: () => ({ text: reviewReply(files.map((f) => f.path)) }) });
    const res = await runTriage(p.provider, { title: "T", body: "", files }, tight());
    expect(res.trimmedFiles?.length).toBeGreaterThan(5);
    expect(p.calls[0]!.user).toContain("truncated by MergeJudge");
    const r = await produceReviewResult({ ...input(files, noStory(tight())), provider: fake({ review: () => ({ text: reviewReply(files.map((f) => f.path)) }) }).provider });
    expect(r.trimmedFiles?.length).toBeGreaterThan(5);
    expect(notChecked(r.body)).toMatch(/Diff trimmed to fit the token budget: \d+ files .*, \\\+\d+ more/);
    expect(trimmedNote(["a", "b"])).toBe("Diff trimmed to fit the token budget: 2 files (a, b)");
    expect(trimmedNote(["a"])).toBe("Diff trimmed to fit the token budget: 1 file (a)");
  });

  it("a PR that fits has no trimmed field and no trimmed line", async () => {
    const p = fake({ review: () => ({ text: reviewReply(["a.ts"]) }), story: () => ({ text: storyReply(["a.ts", "b.md"]) }) });
    const r = await produceReviewResult({ ...input(fit.slice(0, 2)), provider: p.provider });
    expect(r.trimmedFiles).toBeUndefined();
    expect(r.body).not.toContain("Diff trimmed");
    expect(p.calls[0]!.user).not.toContain("truncated");
  });
});

describe("(f) cumulative per-PR token cap", () => {
  const files: PrFile[] = [
    { path: "a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d" },
    { path: "b.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n a\n+x" },
  ];
  const big = (): LlmUsage => ({ input: 26000, output: 1500, cacheRead: 0, cacheWrite: 0 });

  it("skips the retry once actual usage used up the budget, and reports it", async () => {
    const p = fake({ review: () => ({ text: "not json" }), usage: big });
    const r = await produceReviewResult({ ...input(files), provider: p.provider });
    expect(p.calls).toHaveLength(1); // no retry, no story
    expect(notChecked(r.body)).toContain("AI retry skipped: per-PR token budget \\(28000\\) used up");
    expect(r.usage.tokens).toBe(27500);
    expect(r.body).toContain("~27500 tokens");
  });

  it("still retries when the budget has room, and counts both calls in the footer", async () => {
    const small: LlmUsage = { input: 2000, output: 300, cacheRead: 0, cacheWrite: 0 };
    const p = fake({ review: (n) => ({ text: n === 1 ? "not json" : reviewReply(["a.ts", "b.ts"]) }), usage: () => small });
    const r = await produceReviewResult({ ...input(files, noStory(cfgOf())), provider: p.provider });
    expect(p.calls).toHaveLength(2);
    expect(r.usage.tokens).toBe(4600);
    expect(r.body).not.toContain("retry skipped");
  });

  it("falls back to the estimate when the provider reports no usage", async () => {
    const p = fake({ review: () => ({ text: reviewReply(["a.ts", "b.ts"]) }), story: () => ({ text: storyReply(["a.ts", "b.ts"]) }) });
    const r = await produceReviewResult({ ...input(files), provider: p.provider });
    expect(r.usage.tokens).toBeGreaterThan(0);
    expect(p.calls.map((c) => c.purpose ?? "review")).toEqual(["review", "story"]);
  });

  it("skips the story when the review used the budget (even though the review itself was fine)", async () => {
    const p = fake({ review: () => ({ text: reviewReply(["a.ts", "b.ts"]) }), story: () => ({ text: storyReply(["a.ts", "b.ts"]) }), usage: big });
    const r = await produceReviewResult({ ...input(files), provider: p.provider });
    expect(p.calls.map((c) => c.purpose ?? "review")).toEqual(["review"]);
    expect(r.story).toBeNull();
    expect(notChecked(r.body)).toContain("skipped: per-PR token budget used up");
  });

  it("skips the second pass (ai.mode deep) when the budget is used up", async () => {
    const p = fake({ review: () => ({ text: reviewReply(["a.ts", "b.ts"]) }), usage: big });
    const r = await produceReviewResult({ ...input(files, noStory(cfgOf("ai:\n  mode: deep\n"))), provider: p.provider });
    expect(p.calls).toHaveLength(1);
    expect(notChecked(r.body)).toContain("AI second pass skipped: per-PR token budget \\(28000\\) used up");
  });

  it("perPrCap: deep tool loops use the larger of the two caps", () => {
    const cfg = cfgOf();
    expect(perPrCap(cfg)).toBe(28000);
    expect(perPrCap(cfg, true)).toBe(60000);
  });
});

describe("big PR: reasoning model, default budget", () => {
  it("marks truncated files, lists them and the story status, and never exceeds the cap with a skipped retry", async () => {
    const files = bigPr();
    const paths = files.map((f) => f.path);
    const p = fake({
      review: () => ({ text: "{\"summary\":", truncated: true }),
      story: () => ({ text: storyReply(paths) }),
      usage: () => ({ input: 23500, output: 5000, cacheRead: 0, cacheWrite: 0 }),
    });
    const r = await produceReviewResult({ ...input(files, cfgOf("", "@cf/deepseek-ai/deepseek-v4.1-flash-1017")), provider: p.provider });
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.maxOutputTokens).toBe(resolveOutputLimit(cfgOf("", "@cf/deepseek-ai/deepseek-v4.1-flash-1017")));
    const nc = notChecked(r.body);
    expect(nc).toContain("AI retry skipped");
    expect(nc).toContain("Diff trimmed to fit the token budget");
    expect(r.body).toContain("AI review unavailable");
  });
});

describe("Workers AI request extras", () => {
  it("merges extras into ai.run input; messages and max_tokens always win", async () => {
    const run = vi.fn(async () => ({ response: "{}", usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const p = new WorkersAiProvider({ run }, "@cf/m", undefined, {}, { reasoning_effort: "none", max_tokens: 1, messages: [] });
    await p.completeEx({ system: "s", user: "u", maxOutputTokens: 50 });
    expect(run).toHaveBeenCalledWith("@cf/m", { reasoning_effort: "none", max_tokens: 50, messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] });
    const q = createProvider({ type: "workers-ai", model: "@cf/m", timeout_ms: 1000, max_retries: 0, max_timeout_retries: 0, budget_ms: 2000, max_delay_ms: 0 } as never, {}, { ai: { run }, aiRequestExtras: { reasoning_effort: "none" } }).provider!;
    await q.complete({ system: "s", user: "u", maxOutputTokens: 5 });
    expect(run).toHaveBeenLastCalledWith("@cf/m", expect.objectContaining({ reasoning_effort: "none", max_tokens: 5 }));
  });
});
