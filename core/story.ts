/**
 * Optional "PR story" flow chart (`comment.flow_chart`). Pure: no I/O, no imports from outside core/.
 * The review call may return a small `story` (steps + edges) next to the lanes. Everything the model says is untrusted:
 * `validateStory` keeps only steps that point at changed files, re-assigns every id, and reduces all text to a
 * conservative charset; `renderStory` turns the result into a mermaid flowchart. The story is advisory only: it never
 * influences lanes, findings or checks.
 */

export const MAX_STORY_STEPS = 6;
export const MAX_STORY_EDGES = 8;
export const MAX_LABEL_CHARS = 60;
export const MAX_BEFORE_AFTER_CHARS = 50;
/** Raw entries looked at before the caps apply, so a huge reply costs nothing. */
const RAW_STEP_LIMIT = 24;
const RAW_EDGE_LIMIT = 48;

/** Added to the review system prompt only when `comment.flow_chart` is on. */
export const STORY_PROMPT = `Also add a top-level "story" to the JSON: what the PR does as at most 6 behavior steps in plain words (not imports): {"steps":[{"id":"s1","label":"<=60 chars","refs":[{"path":"<changed file>","line":<new-file line>}],"change":"new|changed|same","before":"<short, changed only>","after":"<short, changed only>"}],"edges":[{"from":"s1","to":"s2","change":"new|changed|same"}]}. Every step needs a ref to a changed file. Omit edges to chain the steps in order. It is advisory only.`;

export type StoryChange = "new" | "changed" | "same";

export interface StoryStep {
  id: string;
  label: string;
  refs: { path: string; line?: number }[];
  change: StoryChange;
  before?: string;
  after?: string;
}

export interface StoryEdge {
  id: string;
  from: string;
  to: string;
  change: StoryChange;
}

export interface Story {
  steps: StoryStep[];
  edges: StoryEdge[];
}

/** A changed file of the PR; `lines` are the new-side lines visible in its diff, or null when no line info exists (path-only check). */
export interface StoryFile {
  path: string;
  lines?: ReadonlySet<number> | null;
}

/* ---------- sanitizer ---------- */

/** Words that mermaid or markdown could act on; removed whole, case-insensitive. */
const DANGEROUS = /javascript\s*:|vbscript\s*:|data\s*:|<\s*script|\b(?:click|href)\b|\bwww\.|-->|---|:::|%%|:\/\//gi;

/**
 * Reduce untrusted text to one safe line: letters and digits of any script, space and `.,:/_+-=*'!?`. Everything else
 * (control chars, quotes, brackets, pipes, `<>`, `#`, `;`, `%`, `@`, `&`, backticks) is dropped, so no mermaid or markdown
 * syntax can be built from it. Runs of punctuation are collapsed and the result is capped at `max` characters.
 */
export function sanitizeStoryText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  const s = raw.slice(0, 400)
    .replace(DANGEROUS, " ")
    .replace(/[^\p{L}\p{N} .,:/_+\-=*'!?]/gu, " ")
    .replace(/([.,:/_+\-=*'!?])\1+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

/* ---------- validator ---------- */

const CHANGES = new Set<string>(["new", "changed", "same"]);
const asChange = (v: unknown): StoryChange | undefined => (typeof v === "string" && CHANGES.has(v) ? (v as StoryChange) : undefined);
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate the model's `story` against the PR's changed files. Returns null (no chart) when the story is missing,
 * malformed, or fewer than two valid steps remain. Ids are assigned here (s1..sN, e1..eN), never taken from the model.
 */
export function validateStory(raw: unknown, files: readonly StoryFile[]): Story | null {
  if (!isRec(raw) || !Array.isArray(raw.steps)) return null;
  const byPath = new Map(files.map((f) => [f.path, f]));

  const steps: StoryStep[] = [];
  const idMap = new Map<string, string>(); // model id -> our id
  for (const s of raw.steps.slice(0, RAW_STEP_LIMIT)) {
    if (steps.length >= MAX_STORY_STEPS) break;
    if (!isRec(s) || !Array.isArray(s.refs)) continue;
    const label = sanitizeStoryText(s.label, MAX_LABEL_CHARS);
    if (!label) continue;
    const refs: StoryStep["refs"] = [];
    for (const r of s.refs.slice(0, 8)) {
      if (!isRec(r) || typeof r.path !== "string") continue;
      const f = byPath.get(r.path);
      if (!f) continue;
      if (r.line === undefined || r.line === null) { refs.push({ path: f.path }); continue; }
      if (typeof r.line !== "number" || !Number.isInteger(r.line) || r.line < 1) continue;
      if (f.lines && !f.lines.has(r.line)) continue;
      refs.push({ path: f.path, line: r.line });
    }
    if (!refs.length) continue;
    const before = sanitizeStoryText(s.before, MAX_BEFORE_AFTER_CHARS);
    const after = sanitizeStoryText(s.after, MAX_BEFORE_AFTER_CHARS);
    const change = asChange(s.change) ?? (before || after ? "changed" : "same");
    const id = `s${steps.length + 1}`;
    if (typeof s.id === "string" && !idMap.has(s.id)) idMap.set(s.id, id);
    steps.push({ id, label, refs, change, ...(change === "changed" && before ? { before } : {}), ...(change === "changed" && after ? { after } : {}) });
  }
  if (steps.length < 2) return null;

  const byId = new Map(steps.map((s) => [s.id, s]));
  // An edge on a new or changed path is itself new or changed; otherwise it is context.
  const derive = (a: StoryStep, b: StoryStep): StoryChange =>
    a.change === "new" || b.change === "new" ? "new" : a.change === "changed" || b.change === "changed" ? "changed" : "same";
  const edges: StoryEdge[] = [];
  const seen = new Set<string>();
  const add = (from: StoryStep, to: StoryStep, change: StoryChange | undefined) => {
    const key = `${from.id}>${to.id}`;
    if (from === to || seen.has(key) || edges.length >= MAX_STORY_EDGES) return;
    seen.add(key);
    edges.push({ id: `e${edges.length + 1}`, from: from.id, to: to.id, change: change ?? derive(from, to) });
  };
  if (Array.isArray(raw.edges)) {
    for (const e of raw.edges.slice(0, RAW_EDGE_LIMIT)) {
      if (!isRec(e) || typeof e.from !== "string" || typeof e.to !== "string") continue;
      const a = byId.get(idMap.get(e.from) ?? ""), b = byId.get(idMap.get(e.to) ?? "");
      if (a && b) add(a, b, asChange(e.change));
    }
  }
  // No edges, or none survived: chain the steps in order.
  if (!edges.length) for (let i = 0; i + 1 < steps.length; i++) add(steps[i]!, steps[i + 1]!, undefined);
  return { steps, edges };
}

/* ---------- renderer ---------- */

/** mermaid flowchart source for a validated story. With `animate` off no edge ids and no `@` appear at all. */
export function storyMermaid(story: Story, animate = true): string {
  const out = ["flowchart TD"];
  for (const s of story.steps) {
    const label = [s.label, ...(s.before ? [`before: ${s.before}`] : []), ...(s.after ? [`after: ${s.after}`] : [])].join("<br/>");
    out.push(`  ${s.id}["${label}"]`);
  }
  const moving = (c: StoryChange) => animate && c !== "same";
  for (const e of story.edges) out.push(moving(e.change) ? `  ${e.from} ${e.id}@--> ${e.to}` : `  ${e.from} --> ${e.to}`);
  for (const e of story.edges) if (moving(e.change)) out.push(`  ${e.id}@{ animate: true }`);
  const ids = (c: StoryChange) => story.steps.filter((s) => s.change === c).map((s) => s.id).join(",");
  if (ids("new")) out.push("  classDef added stroke-width:3px", `  class ${ids("new")} added`);
  if (ids("changed")) out.push("  classDef changed stroke-width:2px", `  class ${ids("changed")} changed`);
  return out.join("\n");
}

/**
 * The collapsed sticky section: the mermaid block plus a one-line plain-text fallback (the GitHub mobile app shows the raw
 * code). Everything in it comes from `sanitizeStoryText`, so it is safe inside markdown without further escaping.
 */
export function renderStorySection(story: Story, animate = true): string[] {
  return [
    "<details><summary>What this PR does (AI-drawn, may be incomplete)</summary>",
    "",
    "```mermaid",
    storyMermaid(story, animate),
    "```",
    "",
    `Steps: ${story.steps.map((s, i) => `${i + 1}. ${s.label}`).join("; ")}`,
    "",
    "</details>",
    "",
  ];
}
