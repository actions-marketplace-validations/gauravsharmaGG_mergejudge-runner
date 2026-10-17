// Vendored from the MergeJudge core. Keep in sync.
/**
 * Runner engines and models: what a runner declares, what a repo asks for, and whether they match.
 * Pure (zod only), so the Worker and the runner package share one implementation.
 * Billing: `subscription` = the owner's own CLI login (claude-code, codex); `api-key` = metered key (glm via z.ai).
 */
import { z } from "zod";
import { SECRET_PATTERNS } from "./rules.js";

export type Billing = "subscription" | "api-key";
export const KNOWN_ENGINES = ["claude-code", "codex", "glm"] as const;
export type EngineName = (typeof KNOWN_ENGINES)[number];
export const ENGINE_BILLING: Record<EngineName, Billing> = { "claude-code": "subscription", codex: "subscription", glm: "api-key" };

/** Engine names are short identifiers; model names go to a CLI as one argv element, so they are restricted to a safe charset (no leading dash). */
export const ENGINE_RE = /^[a-z0-9][a-z0-9:_-]{0,39}$/;
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;
/** In a runner's `models` list: any model is accepted for this engine. */
export const ANY_MODEL = "*";

export const engineCapSchema = z.object({
  engine: z.string().regex(ENGINE_RE),
  billing: z.enum(["subscription", "api-key"]),
  models: z.array(z.string().regex(/^(\*|[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99})$/)).max(32).default([]),
  defaultModel: z.string().regex(MODEL_RE).nullable().default(null),
});
export type EngineCap = z.infer<typeof engineCapSchema>;
export const capabilitiesSchema = z.array(engineCapSchema).max(8);

export interface Want { engine?: string | null; model?: string | null }

/** Runners that predate 0.2.0 (no capabilities): claude-code with its default model. Other declared names are kept as API-key engines. */
export function legacyCaps(engines: string[]): EngineCap[] {
  const names = engines.filter((e) => ENGINE_RE.test(e));
  if (!names.length) names.push("claude-code");
  return names.map((engine) => ({ engine, billing: ENGINE_BILLING[engine as EngineName] ?? "api-key", models: [], defaultModel: null }));
}

/** Parses the stored column; falls back to the legacy shape when it is missing or unreadable. */
export function capsFromRow(capabilities: string | null | undefined, enginesJson: string | null | undefined): EngineCap[] {
  if (capabilities) {
    try {
      const p = capabilitiesSchema.safeParse(JSON.parse(capabilities));
      if (p.success && p.data.length) return p.data;
    } catch { /* fall through */ }
  }
  let names: string[] = [];
  try { const v = JSON.parse(enginesJson ?? "[]"); if (Array.isArray(v)) names = v.map(String); } catch { /* none */ }
  return legacyCaps(names);
}

export type Resolved = { ok: true; engine: string; model: string | null; billing: Billing } | { ok: false; reason: string };

/**
 * Picks the engine and model a runner would use for a job that wants `want`. Empty want = the runner's own default
 * (first capability, its default model). A repo's explicit choice wins when the runner declares it; otherwise ok:false
 * with a human reason (the runner nacks with it, or the Worker skips the runner at lease time).
 */
export function resolveEngine(caps: EngineCap[], want: Want = {}): Resolved {
  if (!caps.length) return { ok: false, reason: "runner declares no engines" };
  const engine = want.engine || caps[0]!.engine;
  const cap = caps.find((c) => c.engine === engine);
  if (!cap) return { ok: false, reason: `runner does not offer engine "${engine}" (offers: ${caps.map((c) => c.engine).join(", ")})` };
  const model = want.model || null;
  if (!model) return { ok: true, engine, model: cap.defaultModel, billing: cap.billing };
  if (cap.models.includes(ANY_MODEL) || cap.models.includes(model) || cap.defaultModel === model) return { ok: true, engine, model, billing: cap.billing };
  const offered = [...new Set([...(cap.defaultModel ? [cap.defaultModel] : []), ...cap.models])];
  return { ok: false, reason: `runner does not offer model "${model}" for ${engine} (offers: ${offered.length ? offered.join(", ") : "its default only"})` };
}

/** Footer label: `runner:codex · model: gpt-5`, with `(API key)` after the engine for metered engines. */
export function engineLabel(engine: string, model: string | null, billing: Billing): string {
  return `runner:${engine}${billing === "api-key" ? " (API key)" : ""} · model: ${model ?? "default"}`;
}

/** Reason prefix of a runner's local full-diff secret scan (runner 0.4.2+). The Worker keeps such a block even on files it stripped. */
export const RUNNER_SECRET_PREFIX = "secret found in full local diff (runner): ";
/** Only this exact shape is accepted back from a runner: the prefix plus known pattern names (derived from SECRET_PATTERNS), never free text. */
const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAMES_RE = SECRET_PATTERNS.map((p) => escRe(p.name)).join("|");
export const RUNNER_SECRET_REASON_RE = new RegExp(`^${escRe(RUNNER_SECRET_PREFIX)}(?:${NAMES_RE})(?:, (?:${NAMES_RE}))*$`);
