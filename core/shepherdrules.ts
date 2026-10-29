/**
 * Shepherd stop rules. Each rule is enforced in code (core/shepherdfail.ts `decide`, src/shepherd.ts), never by model
 * judgment, and has a stable ID that logs, hand-off comments and tests use.
 *
 * Loop breakers (any one stops Shepherd): L1-L5. Hand off immediately with no attempt counted: H1-H4.
 */
export const RULE = {
  /** Retry budget: at most `shepherd.max_attempts` fix attempts per PR, counted from Shepherd's own commits. */
  L1: "L1",
  /** Same failure twice: a fix left the failure unchanged. */
  L2: "L2",
  /** Ping-pong: a fix brought back an earlier failure (or the review flags lines the fix touched). */
  L3: "L3",
  /** Fixes have to shrink: each attempt must strictly reduce the number of failures. */
  L4: "L4",
  /** Review findings get one pass only: no suggestions on, and no re-review of, Shepherd's own commits. */
  L5: "L5",
  /** The fix needs a protected path. */
  H1: "H1",
  /** The fix is too big (lines or files). */
  H2: "H2",
  /** Not a code problem: flaky test, outage, missing secrets, CI or runner problem. */
  H3: "H3",
  /** Judgment call: logic merge conflict, CANNOT_FIX, a design or product question. */
  H4: "H4",
} as const;
export type RuleId = (typeof RULE)[keyof typeof RULE];

export const RULE_TITLE: Record<RuleId, string> = {
  L1: "Loop breaker L1: retry budget",
  L2: "Loop breaker L2: same failure twice",
  L3: "Loop breaker L3: ping-pong",
  L4: "Loop breaker L4: fixes must shrink the failures",
  L5: "Loop breaker L5: review findings get one pass",
  H1: "Hand-off H1: needs a protected path",
  H2: "Hand-off H2: diff too big",
  H3: "Hand-off H3: not a code problem",
  H4: "Hand-off H4: judgment call",
};

/** "The one decision needed from you" for each rule: a single concrete question. */
export const RULE_QUESTION: Record<RuleId, string> = {
  L1: "Shepherd used all its fix attempts on this PR. Will you fix the remaining failure yourself, or do you want to raise `shepherd.max_attempts` on the base branch and re-enable?",
  L2: "The last fix left the same failure in place. Can you tell what the real cause is, or should this change be reworked?",
  L3: "Fixing one failure brings back another, so the two fixes fight each other. Which of the two behaviours should win?",
  L4: "The last fix did not reduce the number of failures. Should this change be reworked, or is another approach needed?",
  L5: "The review flags lines in Shepherd's own fix commit. Do you accept that commit as it is, or should it be reverted?",
  H1: "This fix needs a protected path that Shepherd never edits. Will you make that change yourself?",
  H2: "The fix is larger than the size limits. Do you want to make it yourself, or raise `shepherd.max_fix_lines` / `shepherd.max_fix_files` on the base branch?",
  H3: "This does not look like a code problem. Will you check the CI setup, secrets or service status and re-run?",
  H4: "This needs a judgment call. Which of the options should this PR take?",
};

/** Status the Shepherd comment shows after a stop. */
export const RULE_STATUS: Record<RuleId, "limit" | "protected" | "stopped"> = {
  L1: "limit", L2: "stopped", L3: "stopped", L4: "stopped", L5: "stopped", H1: "protected", H2: "stopped", H3: "stopped", H4: "stopped",
};
