// Vendored from the MergeJudge core. Keep in sync.
import type { Config } from "./config.js";
import { trustedAuthor, type PrAuthor } from "./trusted.js";
import type { FileVerdict, Lane } from "./types.js";

export interface CodeAutoEvidence {
  /** What the AI returned for this file; undefined when it skipped the file, errored, or there was no AI (rules-only). */
  ai: { lane: Lane; reason: string } | undefined;
  /** Paths the AI reported findings on (an "auto" with findings contradicts itself). */
  findingPaths: ReadonlySet<string>;
  /** All rubric results of the review; empty when there was no AI or it returned none. */
  rubric: readonly { verdict?: unknown }[];
  /** PR author from GitHub, and whether the PR carries the agent marker: the lanes.trusted_authors gate. */
  author?: PrAuthor | null;
  agentMarked?: boolean;
}

/**
 * The one place an AI verdict can bring a file down from "review" (only for rule-side lanes.code_auto candidates).
 * Shared by aggregate() (Action, Worker, runner) and the Worker's server floor for runner results.
 * Conservative: any doubt means "review".
 */
export function codeAutoDecision(v: Pick<FileVerdict, "path" | "autoCandidate">, ev: CodeAutoEvidence, cfg: Config): { ok: true; reason: string } | { ok: false; why: string } {
  if (!v.autoCandidate || !cfg.lanes.code_auto?.enabled) return { ok: false, why: "not a code_auto candidate" };
  const trust = trustedAuthor(cfg, { author: ev.author ?? undefined, agentMarked: ev.agentMarked });
  if (!trust.trusted) return { ok: false, why: trust.why };
  if (!ev.ai) return { ok: false, why: "the AI did not return a verdict for this file" };
  if (ev.ai.lane !== "auto") return { ok: false, why: `the AI said ${ev.ai.lane}` };
  const reason = ev.ai.reason.trim();
  if (!reason) return { ok: false, why: "the AI said auto without a reason" };
  if (ev.findingPaths.has(v.path)) return { ok: false, why: "the AI reported findings on this file" };
  const rubricRequired = cfg.rubrics.enabled && (cfg.rubrics.packs.length > 0 || cfg.rubrics.custom.length > 0);
  if (rubricRequired && !ev.rubric.length) return { ok: false, why: "the rubric was not scored" };
  // Any failed or unverified criterion blocks every candidate in the PR (cannot tell which file it is about).
  if (ev.rubric.some((r) => r.verdict === "fail" || r.verdict === "unverified")) return { ok: false, why: "a rubric criterion failed or could not be verified" };
  return { ok: true, reason };
}
