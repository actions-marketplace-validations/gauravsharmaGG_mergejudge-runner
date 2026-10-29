import { SHEPHERD_LABEL, SHEPHERD_MARKER, parseShepherdCommand } from "./shepherd.js";
import { HANDOFF_MARKER, NEEDS_HUMAN_LABEL } from "./shepherdhandoff.js";

export type ActionMode = "triage" | "feedback" | "propose" | "shepherd";

interface Routable {
  action?: string;
  label?: { name?: string };
  issue?: { pull_request?: unknown };
  comment?: { body?: string; user?: { type?: string } };
  sender?: { type?: string };
}

/**
 * `mode: auto`: which mode handles this event. Shepherd gets only what it owns: `/mergejudge shepherd` commands on PRs,
 * `shepherd` and `needs-human` label changes, and workflow_run / check_suite / status. Everything else keeps its old route.
 */
export function routeAutoMode(event: string, p: Routable): ActionMode {
  if (event === "issue_comment") {
    const body = p.comment?.body ?? "";
    const human = p.comment?.user?.type !== "Bot" && p.sender?.type !== "Bot" && !body.includes(SHEPHERD_MARKER) && !body.includes(HANDOFF_MARKER);
    return p.issue?.pull_request && human && parseShepherdCommand(body) ? "shepherd" : "feedback";
  }
  if (event === "workflow_run" || event === "check_suite" || event === "status") return "shepherd";
  if (event === "pull_request" && (p.action === "labeled" || p.action === "unlabeled")) {
    const l = (p.label?.name ?? "").toLowerCase();
    if (l === SHEPHERD_LABEL || l === NEEDS_HUMAN_LABEL) return "shepherd";
  }
  if (event === "schedule" || event === "workflow_dispatch") return "propose";
  return "triage";
}
