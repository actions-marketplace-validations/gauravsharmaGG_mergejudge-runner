/**
 * Optional "PR story" flow chart (`comment.flow_chart`). Pure: no I/O, no imports from outside core/.
 * A separate advisory call returns a small `story` (steps + edges). Everything the model says is untrusted:
 * `validateStory` keeps only steps that point at changed files, re-assigns every id, and reduces all text to a
 * conservative charset; renderers consume only the validated story. The story is advisory only: it never
 * influences lanes, findings or checks.
 */

export const MAX_STORY_STEPS = 6;
export const MAX_STORY_EDGES = 8;
export const MAX_LABEL_CHARS = 48;
export const MAX_BEFORE_AFTER_CHARS = 50;
/** Raw entries looked at before the caps apply, so a huge reply costs nothing. */
const RAW_STEP_LIMIT = 24;
const RAW_EDGE_LIMIT = 48;

export type StoryChange = "new" | "changed" | "same";

export interface StoryStep {
  id: string;
  title: string;
  sub?: string;
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
  title: string;
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
const DANGEROUS = /\bon\w+\s*=|javascript\s*:|vbscript\s*:|data\s*:|<\s*script|\bwww\.|-->|---|:::|%%|:\/\//gi;

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
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  // Over the cap: cut at a word boundary when one is close, and mark the cut.
  let cut = chars.slice(0, Math.max(1, max - 3)).join("");
  const sp = cut.lastIndexOf(" ");
  if (chars[Math.max(1, max - 3)] !== " " && sp >= max / 2) cut = cut.slice(0, sp);
  return cut.trim() + "...";
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
  for (const [index, s] of raw.steps.slice(0, RAW_STEP_LIMIT).entries()) {
    if (steps.length >= MAX_STORY_STEPS) break;
    if (!isRec(s) || !Array.isArray(s.refs)) continue;
    const title = sanitizeStoryText(s.title, MAX_LABEL_CHARS) || sanitizeStoryText(s.label, MAX_LABEL_CHARS);
    if (!title) continue;
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
    if (!idMap.has(typeof s.id === "string" ? s.id : `s${index + 1}`)) idMap.set(typeof s.id === "string" ? s.id : `s${index + 1}`, id);
    steps.push({ id, title, sub: sanitizeStoryText(s.sub, 60) || sanitizeStoryText(`${refs[0]!.path}${refs[0]!.line ? `:${refs[0]!.line}` : ""}`, 60), refs, change, ...(change === "changed" && before ? { before } : {}), ...(after ? { after } : {}) });
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
  return { title: sanitizeStoryText(raw.title, 40) || "PR story", steps, edges };
}

/* ---------- renderer ---------- */

/** mermaid flowchart source for a validated story. With `animate` off no edge ids and no `@` appear at all. */
export function storyMermaid(story: Story, animate = true): string {
  const out = ["flowchart TD"];
  for (const s of story.steps) {
    const label = [s.title, ...(s.before ? [`before: ${s.before}`] : []), ...(s.after ? [`after: ${s.after}`] : [])].join("<br/>");
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

/** Collapsed chart plus sanitized plain-text fallback for mobile and unhosted SVGs. */
export function renderStorySection(story: Story, animate = true, style: "svg" | "mermaid" = "svg", imageUrl?: string | null, chart = true): string[] {
  const image = imageUrl && /^https:\/\/[^\s<>"']+$/.test(imageUrl) ? imageUrl.replace(/&/g, "&amp;") : null;
  return [
    "<details><summary>What this PR does (AI-drawn, may be incomplete)</summary>", "",
    ...(chart && style === "mermaid" ? ["```mermaid", storyMermaid(story, animate), "```", ""] :
      chart && image ? [`<img src="${image}" alt="PR story: ${sanitizeStoryText(story.steps.map(s => s.title).join(". "), 350).replace(/'/g, "&#39;")}" width="440">`, ""] : []),
    `Steps: ${story.steps.map((s, i) => `${i + 1}. ${s.title}${s.change === "changed" && s.before && s.after ? ` (${s.before} -> ${s.after})` : ""}`).join("; ")}`,
    "", "</details>", "",
  ];
}
