import type { Lane } from "./types.js";
import type { FeedbackKind, ParsedFeedback } from "./feedback.js";
import { LEGACY_PROPOSAL_BRANCH, PROPOSAL_BRANCH_PREFIX } from "./writes.js";

export const LEARNING_BRANCH = "mergejudge-learning";
export const LESSONS_PATH = "lessons/lessons.jsonl";
export const PROPOSE_THRESHOLD = 10;

export interface Lesson {
  ts: string;
  pr: number;
  url: string;
  head_sha: string;
  lane: Lane;
  summary: string;
  failed_criteria: string[];
  feedback: FeedbackKind[];
  rubric_votes: Record<string, "up" | "down">;
  note: string;
  outcome: "open" | "merged" | "closed";
  by: string;
  source: "checkbox" | "learn_cmd";
}

export function buildLesson(o: {
  pr: number; url: string; headSha: string; lane: Lane; summary: string;
  failedCriteria: string[]; feedback: ParsedFeedback; outcome: Lesson["outcome"];
  by: string; source: Lesson["source"];
}): Lesson {
  return {
    ts: new Date().toISOString(),
    pr: o.pr,
    url: o.url,
    head_sha: o.headSha,
    lane: o.lane,
    summary: o.summary.slice(0, 400),
    failed_criteria: o.failedCriteria,
    feedback: o.feedback.kinds,
    rubric_votes: o.feedback.rubricVotes,
    note: (o.feedback.note ?? "").slice(0, 500),
    outcome: o.outcome,
    by: o.by,
    source: o.source,
  };
}

export function parseLessons(text: string | null | undefined): Lesson[] {
  if (!text?.trim()) return [];
  const out: Lesson[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Lesson); } catch { /* skip bad lines */ }
  }
  return out;
}

export function appendLesson(existing: string | null | undefined, lesson: Lesson): string {
  const base = (existing ?? "").replace(/\s*$/, "");
  return (base ? base + "\n" : "") + JSON.stringify(lesson) + "\n";
}

export interface CriterionStats {
  id: string;
  fails: number;
  thumbs_up: number;
  thumbs_down: number;
  /** thumbs_up / (up+down), or null if no votes */
  accuracy: number | null;
}

export function criterionStats(lessons: Lesson[]): CriterionStats[] {
  const map = new Map<string, CriterionStats>();
  const touch = (id: string) => {
    let s = map.get(id);
    if (!s) { s = { id, fails: 0, thumbs_up: 0, thumbs_down: 0, accuracy: null }; map.set(id, s); }
    return s;
  };
  for (const l of lessons) {
    for (const id of l.failed_criteria) touch(id).fails++;
    for (const [id, v] of Object.entries(l.rubric_votes)) {
      const s = touch(id);
      if (v === "up") s.thumbs_up++; else s.thumbs_down++;
    }
  }
  for (const s of map.values()) {
    const n = s.thumbs_up + s.thumbs_down;
    s.accuracy = n ? s.thumbs_up / n : null;
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export interface Proposal {
  title: string;
  body: string;
  /** Suggested patch snippets (never applied automatically). */
  suggestions: string[];
}

/** Build a human-reviewable proposal PR from accumulated lessons. Never auto-merges. */
export function buildProposal(lessons: Lesson[], opts: { threshold?: number } = {}): Proposal | null {
  const threshold = opts.threshold ?? PROPOSE_THRESHOLD;
  if (lessons.length < threshold) return null;
  const stats = criterionStats(lessons);
  const tooStrict = lessons.filter((l) => l.feedback.includes("too_strict")).length;
  const tooLenient = lessons.filter((l) => l.feedback.includes("too_lenient")).length;
  const correct = lessons.filter((l) => l.feedback.includes("correct")).length;
  const suggestions: string[] = [];
  const body: string[] = [
    "<!-- mergejudge:learning-proposal -->",
    "## MergeJudge learning proposal",
    "",
    `Based on **${lessons.length}** lesson(s). This PR is a suggestion — **do not auto-merge**. Review and edit before accepting.`,
    "",
    "### Feedback summary",
    "",
    `| Signal | Count |`,
    `|---|---|`,
    `| Correct | ${correct} |`,
    `| Too strict | ${tooStrict} |`,
    `| Too lenient | ${tooLenient} |`,
    `| Wrong reason | ${lessons.filter((l) => l.feedback.includes("wrong_reason")).length} |`,
    `| Missed something | ${lessons.filter((l) => l.feedback.includes("missed")).length} |`,
    "",
    "### Per-criterion accuracy (👍 / (👍+👎))",
    "",
    "| Criterion | Fails flagged | 👍 | 👎 | Accuracy |",
    "|---|---|---|---|---|",
  ];
  for (const s of stats) {
    const acc = s.accuracy === null ? "—" : `${Math.round(s.accuracy * 100)}%`;
    body.push(`| \`${s.id}\` | ${s.fails} | ${s.thumbs_up} | ${s.thumbs_down} | ${acc} |`);
    if (s.thumbs_down >= 3 && (s.accuracy ?? 1) < 0.5) {
      suggestions.push(
        `Consider softening or narrowing \`${s.id}\` (accuracy ${acc}, ${s.thumbs_down} 👎).`,
      );
    }
    if (s.thumbs_up >= 3 && (s.accuracy ?? 0) >= 0.8 && s.fails >= 3) {
      suggestions.push(`\`${s.id}\` looks solid (${acc}); keep as-is or raise severity if too many misses.`);
    }
  }
  if (tooStrict > tooLenient + 2)
    suggestions.push("Overall feedback leans too-strict: consider lowering severity of noisy high criteria, or marking more cases n/a.");
  if (tooLenient > tooStrict + 2)
    suggestions.push("Overall feedback leans too-lenient: consider enabling the `maintainability` pack or adding a custom high-severity criterion.");

  body.push("", "### Suggested next edits", "");
  if (suggestions.length) for (const s of suggestions) body.push(`- ${s}`);
  else body.push("- No automatic suggestion crossed the threshold; review the lessons manually.");
  body.push("", "### Source PRs", "");
  const seen = new Set<number>();
  for (const l of lessons.slice(-30)) {
    if (seen.has(l.pr)) continue;
    seen.add(l.pr);
    body.push(`- [#${l.pr}](${l.url}) — lane \`${l.lane}\`, outcome ${l.outcome}${l.note ? `, note: ${l.note}` : ""}`);
  }
  body.push("", "---", "", "Lessons live on the `mergejudge-learning` branch in `lessons/lessons.jsonl`.");
  return {
    title: `chore(mergejudge): learning proposal from ${lessons.length} lesson(s)`,
    body: body.join("\n"),
    suggestions,
  };
}

/** The proposal PR's head: MergeJudge's own branch for suggested edits. A human must merge it, never the bot. */
export function isProposalBranchHead(headRef: string | undefined): boolean {
  if (!headRef) return false;
  return headRef === LEGACY_PROPOSAL_BRANCH || (headRef.startsWith(PROPOSAL_BRANCH_PREFIX) && headRef.length > PROPOSAL_BRANCH_PREFIX.length);
}

/**
 * PRs whose head is the learning branch must never merge; PRs whose head is a proposal branch are always `block`
 * (rules only, no LLM): they carry config/rubric edits that only a human may accept.
 */
export function isLearningBranchHead(headRef: string | undefined, learningBranch: string): boolean {
  if (isProposalBranchHead(headRef)) return true;
  if (!headRef || !learningBranch) return false;
  return headRef === learningBranch || headRef.endsWith("/" + learningBranch);
}
