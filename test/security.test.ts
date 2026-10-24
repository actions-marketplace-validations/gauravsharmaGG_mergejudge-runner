import { describe, expect, it } from "vitest";
import { parseConfig } from "../core/config.js";
import { selectCriteria } from "../core/rubrics.js";
import { buildSystemPrompt } from "../core/triage.js";
import { SECURITY_CRITERIA, securityRequested, withSecurityMode } from "../src/security.js";

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

describe("withSecurityMode", () => {
  it("off returns the same config object", () => {
    const cfg = parseConfig("");
    expect(withSecurityMode(cfg, false)).toBe(cfg);
  });
  it("is off by default: no secmode criteria from a plain or empty config", () => {
    expect(ids("")).not.toContain("secmode.injection");
    expect(ids("review:\n  mode: context\n")).toEqual(["sec.no-secrets", "sec.no-exfiltration", "sec.no-unsafe-exec", "sec.input-handling", "cor.logic", "cor.errors", "cor.tests"]);
    expect(ids("review:\n  security: false\n").some((i) => i.startsWith("secmode."))).toBe(false);
    expect(ids("review:\n  security: 'true'\n").some((i) => i.startsWith("secmode."))).toBe(false);
  });
  it("on adds the short pack after the existing criteria", () => {
    const got = ids("review:\n  security: true\n");
    expect(got.filter((i) => i.startsWith("secmode."))).toEqual(SECURITY_CRITERIA.map((c) => c.id));
    expect(got).toContain("sec.no-secrets");
    expect(SECURITY_CRITERIA.length).toBeLessThanOrEqual(5);
  });
  it("on re-enables rubrics and the security pack when the repo turned them off", () => {
    const off = "review:\n  security: true\nrubrics:\n  enabled: false\n";
    expect(ids(off)).toEqual(expect.arrayContaining(["sec.no-secrets", "secmode.authz"]));
    const noSec = "review:\n  security: true\nrubrics:\n  packs: [correctness]\n";
    expect(ids(noSec)).toEqual(expect.arrayContaining(["sec.no-secrets", "cor.logic", "secmode.authz"]));
  });
  it("is idempotent and keeps the repo's own criteria and notes", () => {
    const yml = "review:\n  security: true\nrubrics:\n  custom:\n    - id: my.rule\n      question: Is the migration reversible?\n  notes:\n    secmode.authz: Admin routes live under /admin.\n";
    const once = withSecurityMode(parseConfig(yml), true);
    const twice = withSecurityMode(once, true);
    expect(twice.rubrics.custom.map((c) => c.id)).toEqual(["my.rule", ...SECURITY_CRITERIA.map((c) => c.id)]);
    const authz = selectCriteria(once.rubrics.packs, once.rubrics.custom, once.rubrics.notes).find((c) => c.id === "secmode.authz");
    expect(authz?.note).toBe("Admin routes live under /admin.");
  });
  it("does not mutate the parsed config", () => {
    const cfg = parseConfig("rubrics:\n  packs: [correctness]\n");
    withSecurityMode(cfg, true);
    expect(cfg.rubrics.packs).toEqual(["correctness"]);
    expect(cfg.rubrics.custom).toEqual([]);
  });
});

describe("prompt", () => {
  it("lists the security criteria and the evidence rule only when security is on", () => {
    const on = buildSystemPrompt({ criteria: criteriaFor("review:\n  security: true\n") });
    const off = buildSystemPrompt({ criteria: criteriaFor("review:\n  mode: diff\n") });
    expect(on).toContain("secmode.injection");
    expect(on).toContain("exact text copied from the diff");
    expect(off).not.toContain("secmode.");
  });
});
