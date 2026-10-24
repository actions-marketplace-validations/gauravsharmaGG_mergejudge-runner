// Opt-in security review mode for the Action: `review.security: true` in .mergejudge.yml.
// Lives in src/ (not core/) because the vendored core config schema does not know the key and drops it.
import { parse } from "yaml";
import { criterionSchema, type Criterion } from "../core/rubrics.js";
import type { Config } from "../core/config.js";

/** Prepended to the first criterion's question only; it governs every sec.audit.* criterion. */
export const SECURITY_RULES = "Security audit rules for every sec.audit.* criterion: fail ONLY for a real trust-boundary break that this diff introduces or exposes, meaning attacker-controlled data crosses a boundary without the check that boundary needs. Style, hardening wishes, theory and anything already behind a check are pass. Copy the exact diff line into evidence.quote (confirmed). If you suspect a break but cannot quote it because it depends on code outside the diff, still fail with an empty quote and say what to validate (needs validation; kept for this pack only). justification = a short title, a colon, then why an attacker can reach it.";

const audit = (id: string, question: string): Criterion =>
  criterionSchema.parse({ id: `sec.audit.${id}`, question, severity: "high", scoring: "pass_fail", raise_to: "review" });

/** Five high-severity criteria, each raising to review on a failure. */
export const SECURITY_CRITERIA: Criterion[] = [
  audit("injection", SECURITY_RULES + " Injection to sinks: does untrusted input (request, params, headers, webhook or queue payload, file or env content, model output) reach a sink unescaped: SQL or query strings, shell or exec, eval, HTML or templates, file paths, redirects, deserialization?"),
  audit("authz",
    "Authorization: does a new or changed route, handler, job or tool act for a caller without checking who they are and that they may use the resource (missing auth, IDOR, a dropped or moved role check, a tenant or owner id taken from the request)?"),
  audit("secrets-crypto",
    "Secrets and crypto: does the change log, return, embed or commit a credential, token or key, or use weak or home-made crypto (MD5/SHA-1 for passwords, ECB, static IV or salt, Math.random for tokens, == on secrets, TLS verification off)?"),
  audit("callbacks",
    "Webhooks, SSRF and callbacks: does an inbound webhook or callback skip signature, token or origin verification, or does the server fetch a URL, host or redirect target an attacker can choose, without an allowlist (internal addresses, metadata endpoints)?"),
  audit("ai-tools",
    "AI and tools, only when the diff touches agents, tools, prompts or model calls (otherwise n/a): can model output or untrusted text gain a capability it should not (shell, file or network access, secrets in prompts, overriding a system prompt) with no check or confirmation?"),
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
