import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateStory } from "../core/story.js";
import { renderStorySvg, wrap } from "../core/storysvg.js";
import { storySvgHash } from "../core/storycall.js";

const story = validateStory({ title: "PR story", steps: [
  { title: "Validate the input array", change: "changed", before: "any input", after: "only arrays", refs: [{ path: "a.ts", line: 1 }] },
  { title: "Add new input tests", change: "new", refs: [{ path: "a.ts", line: 2 }] },
  { title: "Return the final result", change: "same", refs: [{ path: "a.ts" }] },
] }, [{ path: "a.ts", lines: new Set([1, 2]) }])!;

// Strict enough for this generated subset: quoted attributes, balanced tags, XML entities.
function checkXml(svg: string) {
  const stack: string[] = [];
  for (const m of svg.matchAll(/<([^>]+)>/g)) {
    const tag = m[1]!;
    if (tag.startsWith("/")) expect(stack.pop()).toBe(tag.slice(1));
    else {
      expect(tag).toMatch(/^[a-zA-Z][\w-]*(?:\s+[\w:-]+="[^"<>]*")*\s*\/?$/);
      if (!tag.endsWith("/")) stack.push(tag.split(/\s/)[0]!);
    }
  }
  expect(stack).toEqual([]);
  expect(svg).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#39;)/);
}

describe("subway SVG", () => {
  it("is deterministic, self-contained XML with theme, pulse and lane switch", async () => {
    const svg = renderStorySvg(story);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain("@media (prefers-color-scheme:dark)");
    expect(svg).toContain("prefers-reduced-motion"); expect(svg).toContain("@keyframes");
    expect(svg).toContain(".pulseG{display:none}"); expect(svg).toContain("C34");
    expect(svg).not.toMatch(/<script|\son\w+\s*=|href/i);
    expect(svg.replace('http://www.w3.org/2000/svg', '')).not.toContain("http");
    expect(renderStorySvg(story)).toBe(svg); checkXml(svg);
    expect(await storySvgHash(svg)).toBe(createHash("sha256").update(svg).digest("hex").slice(0, 16));
    expect(await storySvgHash("abc")).toBe("ba7816bf8f01cfea");
  });
  it("static mode emits no animations and keeps text and stations visible", () => {
    const svg = renderStorySvg(story, { animate: false });
    expect(svg).not.toMatch(/animation:|animation-delay:|@keyframes|class="pulseG"/);
    expect(svg).toContain("Validate the input array"); expect(svg).toContain('class="f-bg k-ch"');
    checkXml(svg);
  });
  it("validates the XSS fixture, escapes all text and removes controls", () => {
    const raw = JSON.parse(readFileSync(new URL("./fixtures/story-xss.json", import.meta.url), "utf8"));
    // The mockup fixture predates mandatory refs: add real diff refs before validation.
    raw.steps.forEach((s: Record<string, unknown>) => { s.refs = [{ path: "a.ts", line: 1 }]; });
    const validated = validateStory(raw, [{ path: "a.ts", lines: new Set([1]) }])!;
    const svg = renderStorySvg(validated);
    expect(svg).not.toMatch(/<script|<img|onerror|\]\]>|-->|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
    checkXml(svg);
  });
  it("wraps at two lines with ellipsis and hard-breaks long tokens", () => {
    const words = wrap("many words in a very long title that will not fit", 70, 15, 2, true);
    expect(words).toHaveLength(2); expect(words[1]).toMatch(/…$/);
    const token = wrap("W".repeat(48), 70, 15, 2, true);
    expect(token).toHaveLength(2); expect(token[0]!.length).toBeLessThan(48); expect(token[1]).toMatch(/…$/);
    const narrow = renderStorySvg({ ...story, steps: story.steps.map(s => ({ ...s, title: "W".repeat(48) })) }, { width: 280 });
    expect(narrow).toContain("…"); checkXml(narrow);
  });
  it("keeps a long title clear of the step count on the header row", () => {
    const head = (svg: string) => svg.match(/<text x="20" y="31" class="h">([^<]*)<\/text>/)![1]!;
    const short = renderStorySvg({ ...story, title: "Stricter input checks" }, { width: 440 });
    expect(head(short)).toBe("STRICTER INPUT CHECKS");
    expect(short).toContain(">3 steps · 1 changed · 1 new<");
    const long = renderStorySvg({ ...story, title: "Make total and sum stricter about every kind of input in the module" }, { width: 440 });
    expect(head(long).endsWith("\u2026")).toBe(true);
    expect(long).not.toContain("3 steps");
  });
  it("draws brackets, semicolons and quotes as escaped text", () => {
    const s = validateStory({ title: 'Check "sum"; [x]', steps: [
      { title: "Test checks [1, 2, NaN, Infinity, 3] gives 4", change: "new", refs: [{ path: "a.ts", line: 1 }] },
      { title: `say "hi"; it's (ok) {y}`, change: "same", refs: [{ path: "a.ts", line: 2 }] },
    ] }, [{ path: "a.ts", lines: new Set([1, 2]) }])!;
    const svg = renderStorySvg(s, { width: 440 });
    expect(svg).toContain(">Test checks [1, 2, NaN, Infinity, 3] gives 4<");
    expect(svg).toContain(">say &quot;hi&quot;; it&#39;s (ok) {y}<");
    expect(svg).toContain('aria-label="Check &quot;sum&quot;; [x]"');
    expect(svg.replace(/<style>[\s\S]*?<\/style>/, "").match(/<text[^>]*>[^<]*"/)).toBeNull();
  });
});
