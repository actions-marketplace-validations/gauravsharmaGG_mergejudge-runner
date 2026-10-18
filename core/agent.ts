/**
 * The agent marker, shared by the review rules (src/), the Worker and the runner so "this PR was made by a
 * coding agent" always means the same thing: the PR label `mergejudge:agent`, or a `MergeJudge-Actor: agent`
 * marker anywhere in the PR body (or a merge commit message, on the outcome side). Coding agents often act through a
 * human's GitHub login, so the login alone cannot tell them apart. The label is visible in the
 * pull_request payload; no extra permission is needed.
 */
export const AGENT_LABEL = "mergejudge:agent";
export const isAgentLabel = (name: string | null | undefined) => (name ?? "").trim().toLowerCase() === AGENT_LABEL;
export const hasAgentLabel = (labels: readonly string[] | null | undefined) => !!labels?.some(isAgentLabel);
const AGENT_TRAILER = /\bMergeJudge-Actor[ \t]*:[ \t]*agent\b/i;
export const hasAgentTrailer = (text: string | null | undefined) => AGENT_TRAILER.test(text ?? "");

/** The PR carries the agent marker: the label, or the trailer in the PR body. */
export const isAgentPr = (pr: { labels?: readonly string[] | null; body?: string | null }) =>
  hasAgentLabel(pr.labels) || hasAgentTrailer(pr.body);
