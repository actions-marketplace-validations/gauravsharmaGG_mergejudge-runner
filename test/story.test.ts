import { describe, expect, it } from "vitest";
import { parseConfig } from "../core/config.js";
import type { LlmProvider } from "../core/llm/provider.js";
import { MAX_COMMENT_CHARS, renderComment } from "../core/render.js";
import { produceReviewResult } from "../core/review.js";
import {
  MAX_STORY_EDGES, MAX_STORY_STEPS, sanitizeStoryText, storyMermaid, STORY_PROMPT, validateStory, type StoryFile,
} from "../core/story.js";
import { buildSystemPrompt, parseTriageOutput, runTriage, validateAgainstFiles } from "../core/triage.js";
import type { PrFile } from "../core/types.js";

const files: StoryFile[] = [
  { path: "a.ts", lines: new Set([1, 2, 3, 10]) },
  { path: "b.ts", lines: new Set([5]) },
  { path: "nolines.ts", lines: null },
];
const step = (id: string, label: string, extra: object = {}) => ({ id, label, refs: [{ path: "a.ts", line: 1 }], ...extra });

describe("validateStory", () => {
  it("drops steps whose refs are empty, unknown, or on lines outside the diff", () => {
    const s = validateStory({
      steps: [
        step("s1", "ok one"),
        { id: "s2", label: "no refs", refs: [] },
        { id: "s3", label: "unknown path", refs: [{ path: "zzz.ts" }] },
        { id: "s4", label: "bad line", refs: [{ path: "a.ts", line: 99 }] },
        { id: "s5", label: "fractional", refs: [{ path: "a.ts", line: 1.5 }] },
        { id: "s6", label: "path only", refs: [{ path: "b.ts" }] },
        { id: "s7", label: "no line info", refs: [{ path: "nolines.ts", line: 42 }] },
        { id: "s8", label: "one bad one good ref", refs: [{ path: "a.ts", line: 99 }, { path: "a.ts", line: 10 }] },
      ],
    }, files);
    expect(s?.steps.map((x) => x.label)).toEqual(["ok one", "path only", "no line info", "one bad one good ref"]);
    expect(s?.steps[3]?.refs).toEqual([{ path: "a.ts", line: 10 }]);
  });

  it("reassigns ids, chains steps without edges and ignores model ids", () => {
    const s = validateStory({ steps: [step("zz", "first"), step("zz", "second"), step("q", "third")] }, files)!;
    expect(s.steps.map((x) => x.id)).toEqual(["s1", "s2", "s3"]);
    expect(s.edges.map((e) => [e.id, e.from, e.to])).toEqual([["e1", "s1", "s2"], ["e2", "s2", "s3"]]);
  });

  it("drops edges to unknown or dropped steps, self-loops and duplicates", () => {
    const s = validateStory({
      steps: [step("a", "one"), { id: "gone", label: "gone", refs: [] }, step("b", "two"), step("c", "three")],
      edges: [
        { from: "a", to: "b" }, { from: "a", to: "b" }, { from: "b", to: "b" },
        { from: "a", to: "gone" }, { from: "nope", to: "c" }, { from: "b", to: "c", change: "bogus" },
      ],
    }, files)!;
    expect(s.edges.map((e) => [e.id, e.from, e.to])).toEqual([["e1", "s1", "s2"], ["e2", "s2", "s3"]]);
  });

  it("falls back to a chain when no edge survives", () => {
    const s = validateStory({ steps: [step("a", "one"), step("b", "two")], edges: [{ from: "x", to: "y" }] }, files)!;
    expect(s.edges.map((e) => [e.from, e.to])).toEqual([["s1", "s2"]]);
  });

  it("caps steps and edges", () => {
    const steps = Array.from({ length: 20 }, (_, i) => step(`n${i}`, `step ${i}`));
    const edges = steps.flatMap((a, i) => steps.slice(i + 1).map((b) => ({ from: a.id, to: b.id })));
    const s = validateStory({ steps, edges }, files)!;
    expect(s.steps).toHaveLength(MAX_STORY_STEPS);
    expect(s.edges.length).toBeLessThanOrEqual(MAX_STORY_EDGES);
  });

  it("returns null with fewer than two valid steps or garbage input", () => {
    expect(validateStory({ steps: [step("a", "only")] }, files)).toBeNull();
    expect(validateStory({ steps: [step("a", "ok"), { id: "b", label: "x", refs: [{ path: "nope" }] }] }, files)).toBeNull();
    for (const bad of [undefined, null, "story", 7, [], [step("a", "x"), step("b", "y")], { steps: "x" }, { steps: [null, 3, "x"] }])
      expect(validateStory(bad, files)).toBeNull();
  });

  it("keeps before/after only for changed steps and defaults change", () => {
    const s = validateStory({
      steps: [step("a", "x", { change: "new", before: "b", after: "a" }), step("b", "y", { before: "old", after: "new" }), step("c", "z")],
    }, files)!;
    expect(s.steps.map((x) => [x.change, x.before, x.after])).toEqual([["new", undefined, undefined], ["changed", "old", "new"], ["same", undefined, undefined]]);
  });
});

describe("sanitizeStoryText", () => {
  const evil = [
    `"]; click s1 href "javascript:alert(1)"`,
    "<script>alert(1)</script>",
    "%%{init: {'theme':'x'}}%%",
    "a --> b --- c ::: d",
    "`code` and ```fence```",
    "line one\nline two\r\n\tx",
    "&lt;b&gt; &amp; &#x3C;",
    "[link](http://evil.example) www.evil.example @user #1 {a} (b) | c ; d",
    "x\u0000y‮z​",
  ];
  it("emits only the allowlisted charset and none of the mermaid or markdown triggers", () => {
    for (const e of evil) {
      const out = sanitizeStoryText(e, 60);
      expect(out).toMatch(/^[\p{L}\p{N} .,:/_+\-=*'!?]*$/u);
      for (const bad of ["click", "href", "javascript:", "<", ">", "-->", "---", ":::", "%%", "`", "@", "&", "\n", "://", "www."])
        expect(out.toLowerCase()).not.toContain(bad);
    }
  });
  it("keeps normal text, unicode letters and caps the length", () => {
    expect(sanitizeStoryText("Validate user's input, then save: ok!", 60)).toBe("Validate user's input, then save: ok!");
    expect(sanitizeStoryText("Prüfe Eingabe 検証", 60)).toBe("Prüfe Eingabe 検証");
    expect(sanitizeStoryText("a".repeat(100_000), 60)).toHaveLength(60);
    expect(sanitizeStoryText({ x: 1 }, 60)).toBe("");
  });
  it("cannot break out of a quoted mermaid label end to end", () => {
    const s = validateStory({
      steps: [step("a", evil[0]!, { before: evil[1]!, after: evil[2]! }), step("b", evil[3]!)],
    }, files)!;
    const m = storyMermaid(s);
    expect(m).not.toMatch(/click|href|javascript|<script|%%|`/i);
    // a node line is exactly: id["text"] with one pair of quotes
    for (const l of m.split("\n").filter((x) => /^ {2}s\d\[/.test(x))) expect(l).toMatch(/^ {2}s\d\["[^"\]\[]*"\]$/);
  });
});

const story = validateStory({
  steps: [
    step("a", "Parse request"),
    step("b", "Validate input", { change: "new" }),
    step("c", "Reply", { change: "changed", before: "old", after: "new" }),
  ],
  edges: [{ from: "a", to: "b", change: "new" }, { from: "b", to: "c", change: "changed" }, { from: "a", to: "c", change: "same" }],
}, files)!;

describe("storyMermaid", () => {
  it("animates only new and changed edges", () => {
    expect(storyMermaid(story, true)).toBe([
      "flowchart TD",
      `  s1["Parse request"]`,
      `  s2["Validate input"]`,
      `  s3["Reply<br/>before: old<br/>after: new"]`,
      "  s1 e1@--> s2",
      "  s2 e2@--> s3",
      "  s1 --> s3",
      "  e1@{ animate: true }",
      "  e2@{ animate: true }",
      "  classDef added stroke-width:3px",
      "  class s2 added",
      "  classDef changed stroke-width:2px",
      "  class s3 changed",
    ].join("\n"));
  });
  it("has no @ at all with animation off", () => {
    const m = storyMermaid(story, false);
    expect(m).not.toContain("@");
    expect(m).toContain("  s1 --> s2\n  s2 --> s3\n  s1 --> s3");
  });
});

const agg = { lane: "review" as const, files: [], labelReasons: [], summary: "s", rubric: [] };
const open = (extra: object = {}) => renderComment({
  agg: { ...agg, rubric: [{ id: "cor.logic", verdict: "fail", severity: "high", justification: "bad", evidence: { path: "a.ts", line: 1 } }] } as never,
  mode: "m", tokensEstimate: 0, notes: [], story, ...extra,
});

describe("sticky rendering", () => {
  it("puts a collapsed chart with a text fallback right after What to check", () => {
    const md = open();
    const i = md.indexOf("### What to check"), j = md.indexOf("<details><summary>What this PR does (AI-drawn, may be incomplete)</summary>");
    const k = md.indexOf("<details><summary><b>Why this lane?");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(j).toBeGreaterThan(i);
    expect(k).toBeGreaterThan(j);
    expect(md).toContain("```mermaid\nflowchart TD");
    expect(md).toContain("Steps: 1. Parse request; 2. Validate input; 3. Reply");
    expect(md).toContain("e1@{ animate: true }");
  });
  it("renders plain edges when storyAnimate is false", () => {
    const md = open({ storyAnimate: false });
    expect(md).not.toContain("animate");
    expect(md).not.toContain("e1@");
  });
  it("renders nothing without a story", () => {
    expect(open({ story: null })).not.toContain("What this PR does");
    expect(open({ story: undefined })).not.toContain("mermaid");
  });
  it("drops the chart first when over the size cap", () => {
    const mkFindings = (len: number) => Array.from({ length: 100 }, (_, n) => ({ path: `f${n}.ts`, message: "x".repeat(len) }));
    // Grow the findings until the comment is just under the cap without the chart.
    let len = 0;
    while (len < 1_000 && !open({ story: null, fileFindings: mkFindings(len + 1) }).includes("shortened to fit")) len++;
    const fileFindings = mkFindings(len);
    const without = open({ story: null, fileFindings });
    const md = open({ fileFindings });
    expect(without.length).toBeGreaterThan(MAX_COMMENT_CHARS - 150);
    expect(without.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(open({ fileFindings: mkFindings(len - 100) })).toContain("What this PR does");
    expect(md).not.toContain("What this PR does");
    expect(md.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(md).not.toContain("shortened to fit");
  });
});

const pf: PrFile = { path: "a.ts", status: "modified", additions: 3, deletions: 0, patch: "@@ -1,0 +1,3 @@\n+one\n+two\n+three\n" };
const pf2: PrFile = { path: "b.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1,0 +1,1 @@\n+x\n" };
const storyJson = {
  steps: [
    { id: "s1", label: "Read config", refs: [{ path: "a.ts", line: 2 }], change: "new" },
    { id: "s2", label: "Apply it", refs: [{ path: "b.ts", line: 1 }], change: "changed", before: "ignored", after: "used" },
  ],
};
const reply = (extra: object = {}) => JSON.stringify({ summary: "ok", files: [{ path: "a.ts", lane: "review", reason: "logic", findings: [] }], ...extra });
const mkProvider = (seen: string[], answer: string): LlmProvider => ({
  label: "fake", providerId: "openai", complete: async (req) => { seen.push(`${req.system}\n${req.user}`); return answer; },
});
const pr = { number: 7, title: "t", body: "", node_id: "n", head: { sha: "a".repeat(40) }, user: { login: "u", type: "User" } };
const review = (yml: string, provider: LlmProvider) => produceReviewResult({
  pr, cfg: parseConfig(`provider:\n  type: openai\n  model: m\n${yml}`), cfgRef: "main", files: [pf, pf2], provider,
  readRepoFile: async () => null,
  contextSource: { listPaths: async () => [], readFile: async () => null, searchSymbol: async () => [] },
  log: { info: () => {}, warning: () => {} },
});

describe("config and prompt", () => {
  it("defaults to off, with animation on", () => {
    const c = parseConfig("");
    expect(c.comment).toEqual({ flow_chart: false, flow_chart_animate: true });
    expect(parseConfig("comment:\n  flow_chart: true\n").comment).toEqual({ flow_chart: true, flow_chart_animate: true });
    expect(parseConfig("comment:\n  flow_chart: true\n  flow_chart_animate: false\n").comment.flow_chart_animate).toBe(false);
  });

  it("sends no story text when off and STORY_PROMPT when on", async () => {
    const off: string[] = [], on: string[] = [];
    await review("", mkProvider(off, reply({ story: storyJson })));
    await review("comment:\n  flow_chart: true\n", mkProvider(on, reply({ story: storyJson })));
    expect(off.length).toBeGreaterThan(0);
    for (const p of off) { expect(p).not.toContain(STORY_PROMPT); expect(p).not.toContain('"story"'); }
    expect(on.some((p) => p.includes(STORY_PROMPT))).toBe(true);
    expect(buildSystemPrompt({})).not.toContain(STORY_PROMPT);
    expect(buildSystemPrompt({ story: true })).toContain(STORY_PROMPT);
  });

  it("ignores a story the AI returns when the flag is off", async () => {
    const r = await review("", mkProvider([], reply({ story: storyJson })));
    expect(r.kind === "review" && r.body).not.toContain("What this PR does");
    expect(r.kind === "review" && r.body).not.toContain("mermaid");
  });

  it("draws the chart when on, without changing the lane", async () => {
    const off = await review("", mkProvider([], reply()));
    const r = await review("comment:\n  flow_chart: true\n", mkProvider([], reply({ story: storyJson })));
    if (r.kind !== "review" || off.kind !== "review") throw new Error("kind");
    expect(r.body).toContain("What this PR does");
    expect(r.body).toContain("s1 e1@--> s2");
    expect(r.lane).toBe(off.lane);
    expect(r.findings).toEqual(off.findings);
    const plain = await review("comment:\n  flow_chart: true\n  flow_chart_animate: false\n", mkProvider([], reply({ story: storyJson })));
    expect(plain.kind === "review" && plain.body).toContain("s1 --> s2");
  });

  it("rules-only mode draws no chart", async () => {
    const r = await produceReviewResult({
      pr, cfg: parseConfig("provider:\n  type: none\ncomment:\n  flow_chart: true\n"), cfgRef: "main", files: [pf, pf2], provider: null,
      readRepoFile: async () => null,
      contextSource: { listPaths: async () => [], readFile: async () => null, searchSymbol: async () => [] },
      log: { info: () => {}, warning: () => {} },
    });
    expect(r.kind === "review" && r.body).not.toContain("mermaid");
  });
});

describe("story in the reply", () => {
  const cfgOn = parseConfig("provider:\n  type: openai\n  model: m\ncomment:\n  flow_chart: true\n");
  it("survives garbage without failing the review", async () => {
    const garbage: unknown[] = ["a story", ["x"], 5, null, { steps: "x" }, { steps: Array.from({ length: 50_000 }, () => ({ label: "x".repeat(1000), refs: [{ path: "a.ts" }] })) }, { steps: [{ label: {}, refs: 3 }, null] }];
    for (const g of garbage) {
      const res = await runTriage(mkProvider([], reply({ story: g })), { title: "t", body: "", files: [pf] }, cfgOn, { story: true });
      expect(res.llm?.summary).toBe("ok");
      expect(res.llm?.files.get("a.ts")?.lane).toBe("review");
      expect(res.error).toBeUndefined();
    }
  });
  it("parseTriageOutput accepts any story value and validateAgainstFiles only keeps it when wanted", () => {
    const out = parseTriageOutput(reply({ story: storyJson }));
    expect(validateAgainstFiles(out, [pf, pf2]).story).toBeUndefined();
    const on = validateAgainstFiles(out, [pf, pf2], [], undefined, true).story;
    expect(on?.steps.map((s) => s.label)).toEqual(["Read config", "Apply it"]);
    // line 9 is not in a.ts's diff, so that step drops and fewer than two remain
    const bad = parseTriageOutput(reply({ story: { steps: [{ label: "x", refs: [{ path: "a.ts", line: 9 }] }, storyJson.steps[1]] } }));
    expect(validateAgainstFiles(bad, [pf, pf2], [], undefined, true).story).toBeNull();
  });
});
