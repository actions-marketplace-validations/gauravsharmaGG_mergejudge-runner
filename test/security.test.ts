import { describe, expect, it } from "vitest";
import { parseConfig } from "../core/config.js";
import { selectCriteria } from "../core/rubrics.js";
import { buildSystemPrompt } from "../core/triage.js";
import { SECURITY_CRITERIA, SECURITY_RULES, securityRequested, withSecurityMode } from "../src/security.js";

const criteriaFor = (yml: string) => {
  const cfg = withSecurityMode(parseConfig(yml), securityRequested(yml));
  return cfg.rubrics.enabled ? selectCriteria(cfg.rubrics.packs, cfg.rubrics.custom, cfg.rubrics.notes) : [];
};
const ids = (yml: string) => criteriaFor(yml).map((c) => c.id);

describe("securityRequested", () => {
  it("is true only for a boolean true under review", () => {
    expect(securityRequested("review:\n  security: true\n")).toBe(true);
    expect(securityRequested("review:\n  mode: deep\n  security: true\n")).toBe(true);
  });
  it("is false for false, missing, wrong type, wrong place and bad input", () => {
    for (const y of [
      "review:\n  security: false\n", "review:\n  mode: diff\n", "", "   ", "# nothing",
      "review:\n  security: 'true'\n", "review:\n  security: yes\n", "review:\n  security: 1\n", "review:\n  security:\n",
      "security: true\n", "review: [security]\n", "review: true\n", "- review\n", "review: {security: true\n",
    ]) expect(securityRequested(y), JSON.stringify(y)).toBe(false);
    expect(securityRequested(null)).toBe(false);
    expect(securityRequested(undefined)).toBe(false);
  });
});

const AUDIT_IDS = ["sec.audit.injection", "sec.audit.authz", "sec.audit.secrets-crypto", "sec.audit.callbacks", "sec.audit.ai-tools"];

describe("SECURITY_CRITERIA", () => {
  it("has the five audit ids, all high severity and raising to review", () => {
    expect(SECURITY_CRITERIA.map((c) => c.id)).toEqual(AUDIT_IDS);
    for (const c of SECURITY_CRITERIA) {
      expect(c.severity).toBe("high");
      expect(c.raise_to).toBe("review");
      expect(c.scoring).toBe("pass_fail");
    }
  });
  it("puts the shared rules into the first question only", () => {
    expect(SECURITY_CRITERIA[0]!.question.startsWith(SECURITY_RULES)).toBe(true);
    for (const c of SECURITY_CRITERIA.slice(1)) expect(c.question).not.toContain(SECURITY_RULES);
  });
  it("uses the exact mergejudge strings", () => {
    expect(SECURITY_RULES).toBe("Security audit rules for every sec.audit.* criterion: fail ONLY for a real trust-boundary break that this diff introduces or exposes, meaning attacker-controlled data crosses a boundary without the check that boundary needs. Style, hardening wishes, theory and anything already behind a check are pass. Copy the exact diff line into evidence.quote (confirmed). If you suspect a break but cannot quote it because it depends on code outside the diff, still fail with an empty quote and say what to validate (needs validation; kept for this pack only). justification = a short title, a colon, then why an attacker can reach it.");
    expect(SECURITY_CRITERIA.map((c) => c.question)).toEqual([
      SECURITY_RULES + " Injection to sinks: does untrusted input (request, params, headers, webhook or queue payload, file or env content, model output) reach a sink unescaped: SQL or query strings, shell or exec, eval, HTML or templates, file paths, redirects, deserialization?",
      "Authorization: does a new or changed route, handler, job or tool act for a caller without checking who they are and that they may use the resource (missing auth, IDOR, a dropped or moved role check, a tenant or owner id taken from the request)?",
      "Secrets and crypto: does the change log, return, embed or commit a credential, token or key, or use weak or home-made crypto (MD5/SHA-1 for passwords, ECB, static IV or salt, Math.random for tokens, == on secrets, TLS verification off)?",
      "Webhooks, SSRF and callbacks: does an inbound webhook or callback skip signature, token or origin verification, or does the server fetch a URL, host or redirect target an attacker can choose, without an allowlist (internal addresses, metadata endpoints)?",
      "AI and tools, only when the diff touches agents, tools, prompts or model calls (otherwise n/a): can model output or untrusted text gain a capability it should not (shell, file or network access, secrets in prompts, overriding a system prompt) with no check or confirmation?",
    ]);
  });
});

describe("withSecurityMode", () => {
  it("off returns the same config object", () => {
    const cfg = parseConfig("");
    expect(withSecurityMode(cfg, false)).toBe(cfg);
  });
  it("is off by default: a plain or empty config selects only the built-in packs", () => {
    const builtin = ["sec.no-secrets", "sec.no-exfiltration", "sec.no-unsafe-exec", "sec.input-handling", "cor.logic", "cor.errors", "cor.tests"];
    expect(ids("")).toEqual(builtin);
    expect(ids("review:\n  mode: context\n")).toEqual(builtin);
    for (const y of ["review:\n  security: false\n", "review:\n  security: 'true'\n"]) expect(ids(y).some((i) => i.startsWith("sec.audit."))).toBe(false);
  });
  it("on adds the audit pack after the built-in pack criteria and leaves packs alone", () => {
    expect(ids("review:\n  security: true\n")).toEqual(["sec.no-secrets", "sec.no-exfiltration", "sec.no-unsafe-exec", "sec.input-handling", "cor.logic", "cor.errors", "cor.tests", ...AUDIT_IDS]);
    expect(withSecurityMode(parseConfig("review:\n  security: true\n"), true).rubrics.packs).toEqual(parseConfig("").rubrics.packs);
  });
  it("does not add the built-in security pack when the repo did not select it", () => {
    expect(ids("review:\n  security: true\nrubrics:\n  packs: [correctness]\n")).toEqual(["cor.logic", "cor.errors", "cor.tests", ...AUDIT_IDS]);
    expect(ids("review:\n  security: true\nrubrics:\n  packs: []\n")).toEqual(AUDIT_IDS);
  });
  it("forces rubrics.enabled true", () => {
    const cfg = withSecurityMode(parseConfig("review:\n  security: true\nrubrics:\n  enabled: false\n"), true);
    expect(cfg.rubrics.enabled).toBe(true);
    expect(ids("review:\n  security: true\nrubrics:\n  enabled: false\n")).toEqual(expect.arrayContaining(AUDIT_IDS));
  });
  it("puts the audit pack first in custom, ahead of the repo's own criteria, deduped by id", () => {
    const yml = "review:\n  security: true\nrubrics:\n  custom:\n    - id: my.rule\n      question: Is the migration reversible?\n    - id: sec.audit.authz\n      question: Repo copy of the authz check.\n  notes:\n    sec.audit.authz: Admin routes live under /admin.\n";
    const once = withSecurityMode(parseConfig(yml), true);
    expect(once.rubrics.custom.map((c) => c.id)).toEqual([...AUDIT_IDS, "my.rule"]);
    expect(once.rubrics.custom.find((c) => c.id === "sec.audit.authz")!.question).toBe(SECURITY_CRITERIA[1]!.question);
    expect(withSecurityMode(once, true).rubrics.custom.map((c) => c.id)).toEqual([...AUDIT_IDS, "my.rule"]);
    const authz = selectCriteria(once.rubrics.packs, once.rubrics.custom, once.rubrics.notes).find((c) => c.id === "sec.audit.authz");
    expect(authz?.note).toBe("Admin routes live under /admin.");
  });
  it("does not mutate the parsed config", () => {
    const cfg = parseConfig("rubrics:\n  packs: [correctness]\n");
    withSecurityMode(cfg, true);
    expect(cfg.rubrics.packs).toEqual(["correctness"]);
    expect(cfg.rubrics.custom).toEqual([]);
    expect(cfg.rubrics.enabled).toBe(true);
  });
});

describe("prompt", () => {
  it("lists the security criteria and the evidence rule only when security is on", () => {
    const on = buildSystemPrompt({ criteria: criteriaFor("review:\n  security: true\n") });
    const off = buildSystemPrompt({ criteria: criteriaFor("review:\n  mode: diff\n") });
    expect(on).toContain("sec.audit.injection");
    expect(on).toContain("exact text copied from the diff");
    expect(off).not.toContain("sec.audit.");
  });
});
