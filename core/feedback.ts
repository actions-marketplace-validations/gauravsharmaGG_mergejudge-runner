import type { RubricResult } from "./rubrics.js";
import { escapeMd } from "./render.js";

export const FEEDBACK_MARKER = "<!-- mergejudge:feedback -->";
export const LEARN_CMD = /^\/mergejudge\s+learn\b(.*)$/im;

export type FeedbackKind = "correct" | "too_lenient" | "too_strict" | "wrong_reason" | "missed";
export const FEEDBACK_LABELS: { kind: FeedbackKind; label: string }[] = [
  { kind: "correct", label: "Correct" },
  { kind: "too_lenient", label: "Too lenient" },
  { kind: "too_strict", label: "Too strict" },
  { kind: "wrong_reason", label: "Wrong reason" },
  { kind: "missed", label: "Missed something" },
];

/** Render the feedback checkbox block appended to the sticky comment. */
export function renderFeedback(rubric: RubricResult[] = []): string {
  const out: string[] = [FEEDBACK_MARKER, "### Feedback for MergeJudge", ""];
  for (const f of FEEDBACK_LABELS) out.push(`- [ ] ${f.label}`);
  const scored = rubric.filter((r) => r.verdict === "fail" || r.verdict === "unverified" || (r.score !== undefined && r.score <= 2));
  if (scored.length) {
    out.push("", "#### Rubric feedback (tick what you checked: wrong = a false alarm, right = a real problem)", "");
    for (const r of scored) out.push(`- [ ] ${escapeMd(r.id)}: wrong`, `- [ ] ${escapeMd(r.id)}: right`);
  }
  out.push("", "<sub>Tick a box (or comment <code>/mergejudge learn &lt;note&gt;</code>) — feedback is stored on the <code>mergejudge-learning</code> branch, never in this PR.</sub>");
  return out.join("\n");
}

const kindByLabel = Object.fromEntries(FEEDBACK_LABELS.map((f) => [f.label.toLowerCase(), f.kind])) as Record<string, FeedbackKind>;

export interface ParsedFeedback {
  kinds: FeedbackKind[];
  /** criterion id -> "up" | "down" */
  rubricVotes: Record<string, "up" | "down">;
  note?: string;
}

/** Parse checked boxes and optional /mergejudge learn note from a comment body. */
export function parseFeedback(body: string | undefined | null): ParsedFeedback {
  const kinds: FeedbackKind[] = [];
  const rubricVotes: Record<string, "up" | "down"> = {};
  if (!body) return { kinds, rubricVotes };
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*[-*]\s*\[([xX])\]\s+(.+?)\s*$/);
    if (!m) continue;
    const rest = m[2]!.trim();
    const kind = kindByLabel[rest.toLowerCase()];
    if (kind) { kinds.push(kind); continue; }
    // Current format: "<id>: wrong" (ticked = disagree). Ids may carry markdown escapes.
    const plain = rest.replace(/\\(.)/g, "$1");
    const wrong = plain.match(/^`?([a-z0-9][a-z0-9_.-]*)`?\s*:\s*wrong$/i);
    if (wrong) { rubricVotes[wrong[1]!] = "down"; continue; }
    // "<id>: right" = the criterion was correct. A "wrong" tick on the same id wins.
    const right = plain.match(/^`?([a-z0-9][a-z0-9_.-]*)`?\s*:\s*right$/i);
    if (right) { if (rubricVotes[right[1]!] !== "down") rubricVotes[right[1]!] = "up"; continue; }
    // Legacy format: 👍 / 👎 pair per criterion.
    const vote = rest.match(/^(👍|👎)\s*`?([a-z0-9][a-z0-9_.-]*)`?\s*$/i);
    if (vote) rubricVotes[vote[2]!] = vote[1] === "👍" ? "up" : "down";
  }
  const learn = body.match(LEARN_CMD);
  const note = learn?.[1]?.trim() || undefined;
  return { kinds, rubricVotes, ...(note ? { note } : {}) };
}

export function hasFeedback(p: ParsedFeedback): boolean {
  return p.kinds.length > 0 || Object.keys(p.rubricVotes).length > 0 || !!p.note;
}

/** True when the checked set or learn note changed between two bodies. */
export function feedbackChanged(prev: string | undefined | null, next: string | undefined | null): boolean {
  const a = parseFeedback(prev);
  const b = parseFeedback(next);
  if (!hasFeedback(b)) return false;
  return JSON.stringify(a) !== JSON.stringify(b);
}
