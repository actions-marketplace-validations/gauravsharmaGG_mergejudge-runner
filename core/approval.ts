import type { Config } from "./config.js";
import type { Lane } from "./types.js";

export interface ApprovalActions {
  enableAutoMerge(method: "squash" | "merge" | "rebase"): Promise<void>;
  approve(): Promise<void>;
  /** Dismiss MergeJudge's own earlier APPROVE review(s). Returns how many were dismissed. */
  dismissOwnApprovals?(reason: string): Promise<number>;
}

export interface ApprovalContext {
  /** True when running with a GitHub App installation token (required for bot approval). */
  appToken: boolean;
  /** The PR changes MergeJudge's own config file: no bot approval and no auto-merge, whatever the lane and settings say. */
  configChange?: boolean;
}

/** May the bot approve in this lane? auto: bot_approve.auto. review/block: bot_approve[lane] AND bot-only (0 humans). */
export function botMayApprove(cfg: Config["approval"], lane: Lane): boolean {
  if (!cfg.bot_approve[lane]) return false;
  if (lane === "auto") return true;
  return cfg.human_approvers[lane] === 0;
}

/**
 * Never merges directly: at most enables native auto-merge or submits an APPROVE review.
 * Dismisses MergeJudge's own approval when the lane no longer allows it (e.g. risk rose on a new push).
 */
export async function applyApproval(
  cfg: Config["approval"],
  lane: Lane,
  actions: ApprovalActions,
  log: (m: string) => void = () => {},
  ctx: ApprovalContext = { appToken: false },
): Promise<string> {
  const say = (m: string) => (log(m), m);
  if (cfg.mode === "none") return say("approval: mode none, nothing to do");

  if (cfg.mode === "bot-approve") {
    const allowed = !ctx.configChange && botMayApprove(cfg, lane);
    if (!allowed) {
      let dismissed = 0;
      if (cfg.enabled && actions.dismissOwnApprovals)
        dismissed = await actions.dismissOwnApprovals(
          ctx.configChange ? "MergeJudge: this PR changes the MergeJudge config file; approval withdrawn." : `MergeJudge: lane is now ${lane}; approval withdrawn.`);
      if (ctx.configChange)
        return say("approval: PR changes the MergeJudge config file; no bot approval" + (dismissed ? `; dismissed ${dismissed} earlier MergeJudge approval(s)` : ""));
      return say(
        (lane === "block"
          ? "approval: lane is block, no bot approval in block lane"
          : `approval: lane is ${lane}, bot may not approve (needs ${cfg.human_approvers[lane]} human approver(s))`) +
          (dismissed ? `; dismissed ${dismissed} earlier MergeJudge approval(s)` : ""),
      );
    }
    if (!cfg.enabled) return say("approval: disabled; would submit an APPROVE review");
    if (!ctx.appToken) return say("approval: bot-approve needs a GitHub App token (app_id/app_private_key); skipped");
    await actions.approve();
    return say(`approval: did submit an APPROVE review (lane ${lane})`);
  }

  // auto-merge-only
  if (ctx.configChange) return say("approval: PR changes the MergeJudge config file; no bot action");
  if (lane === "block") return say("approval: lane is block, no bot action");
  if (lane !== "auto") return say(`approval: lane is ${lane}, no bot action (needs ${cfg.human_approvers[lane]} human approver(s))`);
  if (!cfg.enabled) return say(`approval: disabled; would enable native auto-merge (${cfg.merge_method})`);
  await actions.enableAutoMerge(cfg.merge_method);
  return say(`approval: did enable native auto-merge (${cfg.merge_method})`);
}
