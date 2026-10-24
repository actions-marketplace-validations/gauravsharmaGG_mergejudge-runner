// Opt-in security review mode for the Action: `review.security: true` in .mergejudge.yml.
// Lives in src/ (not core/) because the vendored core config schema does not know the key and drops it.
import { parse } from "yaml";
import { criterionSchema, type Criterion } from "../core/rubrics.js";
import type { Config } from "../core/config.js";

/** Appended to every security question: the shared evidence rule. */
export const SECURITY_RULES =
  "Fail only when a changed line clearly introduces the problem and you can quote it; otherwise answer pass, or n/a when the change does not touch this area.";

const audit = (id: string, question: string): Criterion =>
  criterionSchema.parse({ id: `sec.audit.${id}`, question: `${question} ${SECURITY_RULES}`, severity: "high", scoring: "pass_fail", raise_to: "review" });

/** Short on purpose: five high-severity criteria, each raising to review on an evidenced failure. */
export const SECURITY_CRITERIA: Criterion[] = [
  audit("injection", "Does untrusted input (request data, URL params, files, env, model output) reach a sink (SQL, shell, eval, file path, template, HTML, deserializer) without validation, escaping or parameterisation?"),
  audit("authz", "Does the change add or alter an entry point (route, handler, job, webhook) without an authentication and authorization check, or loosen or bypass an existing one (missing ownership or tenant check)?"),
  audit("secrets-crypto", "Does the change hard-code or log a secret, token or key, send one to an untrusted place, or use weak or home-made crypto (MD5/SHA1 for secrets, ECB, static IVs, Math.random for tokens, disabled TLS verification)?"),
  audit("callbacks", "Does the change fetch or redirect to a caller-supplied URL (webhooks, callbacks, proxies, redirects) without an allowlist, or accept an inbound callback without verifying its signature (SSRF, open redirect, forged webhook)?"),
  audit("ai-tools", "Where the change adds or edits agents, tools or prompts: can untrusted text steer a tool call, or can a tool run shell, file, network or database actions without an allowlist, limits or confirmation (prompt injection, excessive agency)?"),
];

/** True only when the raw YAML has a real boolean `review.security: true`. Strings ("true", "yes"), numbers and bad YAML do not count. */
export function securityRequested(rawYml: string | null | undefined): boolean {
  if (!rawYml || !rawYml.trim()) return false;
  let doc: unknown;
  try { doc = parse(rawYml); } catch { return false; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  const review = (doc as Record<string, unknown>).review;
  if (!review || typeof review !== "object" || Array.isArray(review)) return false;
  return (review as Record<string, unknown>).security === true;
}

/** Off returns `cfg` unchanged. On forces rubrics on and puts SECURITY_CRITERIA ahead of the repo's own custom criteria (deduped by id). Packs are left as configured. */
export function withSecurityMode(cfg: Config, on: boolean): Config {
  if (!on) return cfg;
  const seen = new Set<string>();
  const custom = [...SECURITY_CRITERIA, ...cfg.rubrics.custom].filter((c) => !seen.has(c.id) && !!seen.add(c.id));
  return { ...cfg, rubrics: { ...cfg.rubrics, enabled: true, custom } };
}
