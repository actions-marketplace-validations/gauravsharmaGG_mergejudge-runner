// Vendored from the MergeJudge core. Keep in sync.
import { explainLane, type Aggregate } from "./aggregate.js";
import { renderFeedback } from "./feedback.js";
import type { Lane } from "./types.js";

export const MARKER = "<!-- mergejudge:summary -->";
export const EMOJI: Record<Lane, string> = { auto: "🟢", review: "🟡", block: "🔴" };

/** Make untrusted text safe inside a single markdown line / table cell. */
export function escapeMd(s: string): string {
  return s
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replace(/[\\`*_{}\[\]()<>#+!|~]/g, "\\$&")
    .replace(/&/g, "&amp;")
    .replace(/@/g, "@\u200b")
    .trim();
}

export interface RenderInput {
  agg: Aggregate;
  mode: string; // "rules-only" or model name
  tokensEstimate: number;
  notes: string[];
  /** File-level LLM findings (no valid diff line). */
  fileFindings?: { path: string; message: string }[];
  policyFiles?: { path: string; truncated: boolean }[];
  breakdown?: { system: number; policy: number; rubric: number; diff: number; context?: number; tools?: number; tool_calls?: number; output: number; total: number };
}

export function renderLaneExplanation(agg: Aggregate): string {
  const explanation = explainLane(agg);
  return [
    `Why this lane? ${escapeMd(explanation.summary)}`,
    "", "<details><summary>Why this lane? Details</summary>", "",
    ...explanation.reasons.map((r) => `- ${r.path ? escapeMd(r.path) + ": " : ""}${escapeMd(r.messages.join("; "))}${r.source ? ` (source: ${escapeMd(r.source)})` : ""}`),
    "", "</details>",
  ].join("\n");
}

export function renderComment(r: RenderInput): string {
  const { agg } = r;
  const flagged = agg.files.filter((f) => f.lane !== "auto");
  const safe = agg.files.filter((f) => f.lane === "auto");
  const out: string[] = [MARKER, "## ⚖️ MergeJudge", ""];
  out.push(renderLaneExplanation(agg), "", escapeMd(agg.summary), "");
  out.push(`**Overall lane:** ${EMOJI[agg.lane]} \`${agg.lane}\``, "");
  if (agg.labelReasons.length) out.push(...agg.labelReasons.map((l) => `- 🏷️ ${l}`), "");

  if (flagged.length) {
    out.push("### Files needing human review", "", "| File | Lane | Source | Reason |", "|---|---|---|---|");
    for (const f of flagged)
      out.push(`| ${escapeMd(f.path)} | ${EMOJI[f.lane]} ${f.lane} | ${f.source ?? "rule"} | ${escapeMd(f.reasons.join("; ")) || "-"} |`);
    out.push("");
  }
  if (safe.length) {
    out.push(`<details><summary>Safe files (${safe.length})</summary>`, "");
    for (const f of safe) out.push(`- ${escapeMd(f.path)}${f.codeAuto ? " (code, auto via code_auto opt-in)" : ""}`);
    out.push("", "</details>", "");
  }
  if (safe.length && flagged.length) {
    out.push(
      "### Split suggestion",
      "",
      "This PR mixes auto-mergeable and review/block changes. These files could go in a separate auto-mergeable PR:",
      "",
      ...safe.map((f) => `- ${escapeMd(f.path)}`),
      "",
    );
  }
  if (agg.rubric?.length) {
    const icon = { pass: "✅", fail: "❌", "n/a": "➖", unverified: "❔" } as const;
    const fails = agg.rubric.filter((x) => x.verdict === "fail" || x.verdict === "unverified");
    const passes = agg.rubric.filter((x) => x.verdict === "pass").length;
    const na = agg.rubric.filter((x) => x.verdict === "n/a").length;
    out.push(`### Rubric: ${passes} pass · ${fails.length} fail/unverified · ${na} n/a`, "");
    for (const x of fails) {
      const where = x.evidence ? ` (${escapeMd(x.evidence.path)}${x.evidence.line ? ":" + x.evidence.line : ""})` : "";
      const sc = x.score !== undefined ? ` ${x.score}/5` : "";
      out.push(`- ${icon[x.verdict]} \`${escapeMd(x.id)}\` ${x.severity}${sc}${where}: ${escapeMd(x.justification)}${x.raiseTo ? ` → raised to ${x.raiseTo}` : ""}`);
    }
    if (fails.length) out.push("");
    out.push(`<details><summary>All criteria</summary>`, "");
    for (const x of agg.rubric)
      out.push(`- ${icon[x.verdict]} \`${escapeMd(x.id)}\`${x.score !== undefined ? ` ${x.score}/5` : ""}: ${escapeMd(x.justification) || "-"}`);
    out.push("", "</details>", "");
  }
  if (r.fileFindings?.length) {
    out.push("### Other LLM findings", "");
    for (const f of r.fileFindings) out.push(`- ${escapeMd(f.path)}: ${escapeMd(f.message)}`);
    out.push("");
  }
  for (const n of r.notes) out.push(`> ⚠️ ${escapeMd(n)}`, "");
  out.push("---", "", renderFeedback(agg.rubric ?? []), "");
  out.push(
    `<sub>Mode: ${escapeMd(r.mode)} · ~${r.tokensEstimate} tokens (estimate)` +
      (r.policyFiles?.length
        ? ` · Policy: ${r.policyFiles.map((p) => escapeMd(p.path) + (p.truncated ? " (truncated)" : "")).join(", ")}`
        : "") +
      (r.breakdown
        ? ` · tokens system ${r.breakdown.system}/policy ${r.breakdown.policy}/rubric ${r.breakdown.rubric}/diff ${r.breakdown.diff}${r.breakdown.context ? `/context ${r.breakdown.context}` : ""}${r.breakdown.tools ? `/tools ${r.breakdown.tools} (${r.breakdown.tool_calls ?? 0} calls)` : ""}/out ${r.breakdown.output}`
        : "") +
      ` · MergeJudge never merges PRs itself</sub>`,
  );
  return out.join("\n");
}

export const CHECK_NAME = "mergejudge/lane";
export const CHECK_CONCLUSION: Record<Lane, "success" | "neutral" | "failure"> = {
  auto: "success",
  review: "neutral",
  block: "failure",
};

export function checkSummary(agg: Aggregate): { title: string; summary: string } {
  const n = (l: Lane) => agg.files.filter((f) => f.lane === l).length;
  return {
    title: `Lane: ${agg.lane}`,
    summary: `${renderLaneExplanation(agg)}\n\n${EMOJI[agg.lane]} Overall lane **${agg.lane}** — ${n("auto")} auto, ${n("review")} review, ${n("block")} block file(s).`,
  };
}
