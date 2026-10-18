import type { Config } from "./config.js";

/**
 * Output-token limit per call. `budget.max_output_tokens` wins when the repo sets it; otherwise the default depends on the
 * model: reasoning-capable models spend output tokens on hidden reasoning before the JSON, so a small cap cuts the JSON
 * off (observed: glm-5.x stopping at exactly 2500 tokens). Keep the table small; unknown models get the lower default.
 */
export const DEFAULT_OUTPUT_TOKENS = 2500;
export const REASONING_OUTPUT_TOKENS = 8000;

/** Model ids (any gateway prefix such as `openrouter/openai/` or `@cf/zai-org/`) treated as reasoning-capable. */
export const REASONING_MODEL =
  /(?:^|[/:@])(?:glm-?(?:5|4\.[5-9])|gpt-5|o[1-9](?:-|$)|deepseek-(?:r1|reasoner)|qwq|[^/]*thinking)/i;

export const isReasoningModel = (model: string | undefined): boolean => !!model && REASONING_MODEL.test(model);

/** Smallest reply that can still hold a useful JSON object. */
const MIN_OUTPUT = 256;
/** Prompt room kept free when an explicit limit is clamped to the per-PR budget. */
const MIN_INPUT = 1000;

/**
 * Effective output limit: explicit config, else the per-model default, clamped so output never leaves the prompt
 * less than MIN_INPUT of room inside `budget.max_tokens_per_pr` (a defaulted limit is also capped at half of it).
 */
export function resolveOutputLimit(cfg: Config): number {
  const total = cfg.budget.max_tokens_per_pr;
  const explicit = cfg.budget.max_output_tokens;
  if (explicit !== undefined) return Math.max(MIN_OUTPUT, Math.min(explicit, total - MIN_INPUT));
  const want = isReasoningModel(cfg.provider.model) ? REASONING_OUTPUT_TOKENS : DEFAULT_OUTPUT_TOKENS;
  return Math.max(MIN_OUTPUT, Math.min(want, Math.floor(total / 2)));
}

/** Limit for the single retry after a cut-off or unparseable reply: 2x, never past the `room` the budget leaves. */
export function retryOutputLimit(limit: number, room: number): number {
  return Math.max(limit, Math.min(limit * 2, room));
}

/** Added to the retry prompt so the reply fits in the extra room. */
export const COMPACT_JSON_INSTRUCTION = "Respond with compact JSON only, no reasoning text, keep findings short.";
