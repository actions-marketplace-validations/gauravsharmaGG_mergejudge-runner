/**
 * AI review depth: `fast` (one pass, the default) or `deep` (a second pass).
 * Separate from `review.mode` (diff | context | deep), which chooses how much surrounding code is attached.
 * Second-pass findings are kept only when `verifyFindingEvidence` matches `quote` to that file's diff.
 * Deterministic base-branch rules stay the floor. auto means low risk, not a guarantee.
 */
import type { Config } from "../core/config.js";
import { ConfigError } from "./config.js";
import { aiModeOf, type ReviewMode } from "../core/aimode.js";

export { REVIEW_MODES, aiModeOf, verifyFindingEvidence, type ReviewMode } from "../core/aimode.js";

/** Copy `mode` onto a config. A missing `ai` block (older job payloads) is filled in. */
export function withAiMode<T extends { ai?: { mode?: ReviewMode | string | null } | null }>(cfg: T, mode: ReviewMode): T {
  if (cfg.ai?.mode === mode) return cfg;
  return { ...cfg, ai: { ...(cfg.ai ?? {}), mode } };
}

export function parseReviewMode(raw: string | undefined | null, label = "review mode"): ReviewMode | undefined {
  if (raw === undefined || raw === null) return undefined;
  const v = raw.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "fast" || v === "deep") return v;
  throw new ConfigError(`${label} must be fast or deep (got ${JSON.stringify(raw.trim().slice(0, 40))})`);
}

export interface ReviewModeSources {
  /** CLI `--mode`. */
  flag?: string | null;
  /** CLI `--deep` (same as `--mode deep`). */
  deepFlag?: boolean;
  /** Action input `review_mode`. GitHub Actions also exposes this as `INPUT_REVIEW_MODE`. */
  reviewMode?: string | null;
  /** Read for `MERGEJUDGE_MODE` and, when the input above is empty, `INPUT_REVIEW_MODE`. */
  env?: Record<string, string | undefined>;
}

/**
 * An explicit override, or undefined to keep `ai.mode` from `.mergejudge.yml` (default fast).
 * Precedence: `--deep` / `--mode`, then `review_mode`, then `MERGEJUDGE_MODE`, then `INPUT_REVIEW_MODE`.
 */
export function explicitReviewMode(s: ReviewModeSources = {}): ReviewMode | undefined {
  const flag = parseReviewMode(s.flag, "--mode");
  if (s.deepFlag && flag === "fast") throw new ConfigError("--deep conflicts with --mode fast");
  if (s.deepFlag) return "deep";
  if (flag) return flag;
  const input = parseReviewMode(s.reviewMode, "review_mode");
  if (input) return input;
  const env = s.env ?? {};
  const fromMerge = parseReviewMode(env.MERGEJUDGE_MODE, "MERGEJUDGE_MODE");
  if (fromMerge) return fromMerge;
  const fromInputEnv = parseReviewMode(env.INPUT_REVIEW_MODE, "INPUT_REVIEW_MODE");
  if (fromInputEnv) return fromInputEnv;
  return undefined;
}

/** The mode a review should run: an explicit override, otherwise the config, otherwise fast. */
export function effectiveReviewMode(explicit: ReviewMode | undefined, cfg: Pick<Config, "ai"> | { ai?: { mode?: string | null } | null } | null | undefined): ReviewMode {
  return explicit ?? aiModeOf(cfg);
}

