// Opt-in security review mode for the Action: `review.security: true` in .mergejudge.yml.
// Lives in src/ (not core/) because the vendored core config schema does not know the key and drops it.
import { parse } from "yaml";
import { criterionSchema, type Criterion } from "../core/rubrics.js";
import type { Config } from "../core/config.js";

/** Short on purpose: four extra criteria on top of the built-in `security` pack. Evidence-grounded like every rubric criterion. */
export const SECURITY_CRITERIA: Criterion[] = [
  { id: "secmode.authz", question: "Does the change keep authentication and authorization checks in place (none removed, skipped or loosened, no new unauthenticated route)?", severity: "high", scoring: "pass_fail", raise_to: "review" },
  { id: "secmode.injection", question: "Is user-controlled input kept out of SQL, shell commands, file paths, templates and URLs (parameterised or validated, no string concatenation)?", severity: "high", scoring: "pass_fail", raise_to: "review" },
  { id: "secmode.unsafe-defaults", question: "Does the change avoid weakening safeguards (TLS verification off, wildcard CORS, broader CI/workflow permissions, debug or admin switches on)?", severity: "medium", scoring: "pass_fail", raise_to: "review" },
  { id: "secmode.data-exposure", question: "Does the change avoid logging or returning secrets, tokens or personal data?", severity: "medium", scoring: "pass_fail", raise_to: "review" },
].map((c) => criterionSchema.parse(c));

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

/** Off returns `cfg` unchanged. On turns rubrics on, makes sure the `security` pack is selected and adds SECURITY_CRITERIA (once). */
export function withSecurityMode(cfg: Config, on: boolean): Config {
  if (!on) return cfg;
  const have = new Set(cfg.rubrics.custom.map((c) => c.id));
  return {
    ...cfg,
    rubrics: {
      ...cfg.rubrics,
      enabled: true,
      packs: cfg.rubrics.packs.includes("security") ? cfg.rubrics.packs : [...cfg.rubrics.packs, "security"],
      custom: [...cfg.rubrics.custom, ...SECURITY_CRITERIA.filter((c) => !have.has(c.id))],
    },
  };
}
