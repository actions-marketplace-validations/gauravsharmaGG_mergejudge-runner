import { describe, expect, it } from "vitest";
import { parseConfig } from "../core/config.js";
import {
  addEntry, isProtectedPath, isShepherdOn, newShepherdState, nextAttempt, parseShepherdCommand, parseShepherdState,
  protectedHits, renderShepherdComment, startAttempt, upsertShepherdComment, SHEPHERD_LABEL,
} from "../core/shepherd.js";
import { findingText, inlineBody, parseMarker, planInline } from "../core/inline.js";
import { buildSystemPrompt, SYSTEM_PROMPT, parseTriageOutput, validateAgainstFiles } from "../core/triage.js";

const cfg = parseConfig("");
const patch = "@@ -1,2 +1,3 @@\n keep\n+const token = readSecret();\n+return token;";
const files = (path = "a.ts") => [{ path, status: "modified", additions: 2, deletions: 0, patch }] as never;
const run = (findings: object[], path = "a.ts", sugg?: (p: string) => boolean) =>
  validateAgainstFiles(parseTriageOutput(JSON.stringify({ summary: "s", files: [{ path, lane: "review", findings }] })), files(path), [], sugg);
const allow = (p: string) => !isProtectedPath(p, cfg);

describe("shepherd command and label", () => {
  it("parses on/off, case-insensitively with leading whitespace", () => {
    expect(parseShepherdCommand("/mergejudge shepherd")).toBe("on");
    expect(parseShepherdCommand("  /MergeJudge Shepherd ON")).toBe("on");
    expect(parseShepherdCommand("thanks\n/mergejudge shepherd off\n")).toBe("off");
  });
  it("ignores quotes, fenced code and other text", () => {
    expect(parseShepherdCommand("> /mergejudge shepherd")).toBeNull();
    expect(parseShepherdCommand("```\n/mergejudge shepherd\n```")).toBeNull();
    expect(parseShepherdCommand("~~~\n/mergejudge shepherd\n~~~\n")).toBeNull();
    expect(parseShepherdCommand("please /mergejudge shepherd")).toBeNull();
    expect(parseShepherdCommand("/mergejudge shepherds")).toBeNull();
    expect(parseShepherdCommand(null)).toBeNull();
  });
  it("last command wins; a command after a closed fence counts", () => {
    expect(parseShepherdCommand("/mergejudge shepherd\n```\nx\n```\n/mergejudge shepherd off")).toBe("off");
  });
  it("detects the label", () => {
    expect(SHEPHERD_LABEL).toBe("shepherd");
    expect(isShepherdOn([{ name: "bug" }, { name: "Shepherd" }])).toBe(true);
    expect(isShepherdOn(["shepherd"])).toBe(true);
    expect(isShepherdOn([{ name: "bug" }])).toBe(false);
    expect(isShepherdOn(undefined)).toBe(false);
  });
});

describe("shepherd config", () => {
  it("old configs get defaults", () => {
    expect(cfg.shepherd).toEqual({ enabled: true, max_attempts: 3, max_fix_lines: 50, max_fix_files: 3, protected_paths: [], suggestions: true });
    expect(parseConfig("lanes:\n  auto: [docs/**]\n").shepherd.max_attempts).toBe(3);
  });
  it("reads and validates the block", () => {
    const c = parseConfig("shepherd:\n  max_attempts: 5\n  suggestions: false\n  protected_paths: [infra/**]\n");
    expect(c.shepherd).toEqual({ enabled: true, max_attempts: 5, max_fix_lines: 50, max_fix_files: 3, protected_paths: ["infra/**"], suggestions: false });
    expect(() => parseConfig("shepherd:\n  max_attempts: 11\n")).toThrow();
    expect(() => parseConfig("shepherd:\n  max_attempts: 0\n")).toThrow();
  });
});

describe("protected paths", () => {
  it.each([".github/workflows/x.yml", ".mergejudge.yml", "sub/.mergejudge.yaml", "wrangler.toml", "src/auth/login.ts", "deploy.sh", "scripts/deploy/run.sh", "scripts/rollback.sh", "config/.env.local", "certs/a.pem", "src/secrets.ts"])(
    "%s is protected", (p) => expect(isProtectedPath(p, cfg)).toBe(true));
  it.each(["src/index.ts", "README.md", "test/a.test.ts"])("%s is not", (p) => expect(isProtectedPath(p, cfg)).toBe(false));
  it("extra globs add to the defaults", () => {
    const c = parseConfig("shepherd:\n  protected_paths: [infra/**]\n");
    expect(protectedHits(["infra/a.tf", "src/a.ts", ".github/x.yml"], c)).toEqual(["infra/a.tf", ".github/x.yml"]);
  });
});

describe("shepherd state comment", () => {
  const entry = { at: "2026-01-01T00:00:00Z", kind: "ci" as const, what: "tests failed", changed: "fixed typo", result: "green", commit: "abcdef1234567", run: "https://github.com/o/r/actions/runs/1" };
  it("round-trips through the marker, including a hostile message", () => {
    let s = newShepherdState(3);
    s = addEntry(s, { ...entry, what: "evil --> <script>alert(1)</script> -->" });
    const body = renderShepherdComment(s, "https://github.com/o/r");
    expect((body.match(/-->/g) ?? []).length).toBe(1);
    expect(parseShepherdState(body)).toEqual(s);
    expect(parseShepherdState(body)!.entries[0]!.what).toContain("-->");
  });
  it("renders title, status, attempts, links and footer", () => {
    const s = addEntry({ ...newShepherdState(3), attempts: 1 }, entry);
    const body = renderShepherdComment(s, "https://github.com/o/r");
    expect(body).toContain("🐑 MergeJudge Shepherd — Watch and auto-fix");
    expect(body).toContain("MergeJudge watches this PR and keeps fixing it until checks and review pass.");
    expect(body).toContain("1/3");
    expect(body).toContain("https://github.com/o/r/commit/abcdef1234567");
    expect(body).toContain("https://github.com/o/r/actions/runs/1");
    expect(body).toContain("Shepherd never merges. A human still merges.");
    expect(body).toContain("/mergejudge shepherd off");
  });
  it("redacts secrets and neutralises pipes and mentions", () => {
    const s = addEntry(newShepherdState(), { ...entry, what: `token ${"ghp"}_${"abcdefghijklmnopqrstuvwxyz0123456789"} | @bob` });
    const body = renderShepherdComment(s, "https://github.com/o/r");
    expect(body).not.toContain("ghp_abcdef");
    expect(body).not.toMatch(/@bob/);
    expect(body.split("\n").find((l) => l.startsWith("| 2026"))!.match(/(?<!\\)\|/g)).toHaveLength(7);
  });
  it("drops bad commit/run values and caps entries", () => {
    let s = newShepherdState();
    s = addEntry(s, { ...entry, commit: "not a sha", run: "javascript:alert(1)" });
    expect(s.entries[0]).not.toHaveProperty("commit");
    expect(s.entries[0]).not.toHaveProperty("run");
    for (let i = 0; i < 30; i++) s = addEntry(s, { ...entry, what: `n${i}` });
    expect(s.entries).toHaveLength(20);
    expect(s.entries.at(-1)!.what).toBe("n29");
  });
  it("rejects forged or malformed state", () => {
    expect(parseShepherdState("no marker")).toBeNull();
    expect(parseShepherdState("<!-- mergejudge:shepherd %7Bbad -->")).toBeNull();
    expect(parseShepherdState(`<!-- mergejudge:shepherd ${encodeURIComponent(JSON.stringify({ v: 1, on: true, attempts: 0, maxAttempts: 99, status: "watching", entries: [] }))} -->`)).toBeNull();
  });
  it("enforces the retry limit", () => {
    let s = newShepherdState(2);
    expect(nextAttempt(s).allowed).toBe(true);
    s = startAttempt(startAttempt(s));
    expect(s).toMatchObject({ attempts: 2, status: "fixing" });
    expect(nextAttempt(s)).toMatchObject({ allowed: false });
    expect(startAttempt(s).status).toBe("limit");
    expect(nextAttempt({ ...s, on: false, status: "off" }).allowed).toBe(false);
    expect(nextAttempt({ ...newShepherdState(), status: "protected" }).allowed).toBe(false);
  });
  it("upserts one bot comment found by marker", async () => {
    const calls: string[] = [];
    const listed = [
      { id: 1, body: "x <!-- mergejudge:shepherd abc -->", user: { type: "User" } },
      { id: 2, body: renderShepherdComment(newShepherdState(), "u"), user: { type: "Bot" } },
    ];
    const ok = {
      paginate: async () => listed,
      rest: { issues: { listComments: {}, updateComment: async (a: { comment_id: number }) => { calls.push(`u${a.comment_id}`); }, createComment: async () => { calls.push("c"); } } },
    } as never;
    const s = await upsertShepherdComment(ok, { owner: "o", repo: "r" }, 1, (prev) => ({ ...prev!, attempts: 1 }));
    expect(s.attempts).toBe(1);
    expect(calls).toEqual(["u2"]);
    listed.pop();
    await upsertShepherdComment(ok, { owner: "o", repo: "r" }, 1, (prev) => { expect(prev).toBeNull(); return newShepherdState(); });
    expect(calls).toEqual(["u2", "c"]);
  });
});

describe("suggested changes (tier 1)", () => {
  const f = { path: "a.ts", line: 2, quote: "const token = readSecret();", message: "secret read" };
  it("default prompt has no suggestion wording; on adds it", () => {
    expect(buildSystemPrompt()).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt({})).not.toMatch(/suggest/i);
    expect(buildSystemPrompt({ suggestions: allow })).toMatch(/suggestion/);
  });
  it("keeps a valid suggestion, only when enabled", () => {
    const q = { line: 2, quote: f.quote, message: "m", suggestion: "const token = readSecret(ctx);" };
    expect(run([q], "a.ts", allow).findings[0]!.suggestion).toBe("const token = readSecret(ctx);");
    expect(run([q]).findings[0]).not.toHaveProperty("suggestion");
  });
  it("drops the suggestion (keeps the finding) when invalid", () => {
    const base = { line: 2, quote: f.quote, message: "m" };
    const bad = [
      { ...base, suggestion: "const token = readSecret();" }, // unchanged
      { ...base, suggestion: "```\nx\n```" },
      { ...base, suggestion: "x".repeat(2000) },
      { ...base, suggestion: "  " },
      { line: 2, quote: "not in the diff at all", message: "m", suggestion: "y" }, // unverified
    ];
    for (const b of bad) {
      const r = run([b], "a.ts", allow);
      expect(r.findings).toHaveLength(1);
      expect(r.findings[0]).not.toHaveProperty("suggestion");
    }
  });
  it("drops the suggestion on a protected path", () => {
    const r = run([{ ...f, suggestion: "const t = 1;" }], ".github/workflows/x.yml", allow);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).not.toHaveProperty("suggestion");
  });
  it("inlineBody appends the block; without it the body is unchanged", () => {
    const plain = inlineBody(f);
    const withS = inlineBody({ ...f, suggestion: "a\nb" });
    expect(withS).toBe(`${plain}\n\n\`\`\`suggestion\na\nb\n\`\`\``);
    expect(plain).not.toContain("suggestion");
    expect(parseMarker(withS)).toEqual(parseMarker(plain));
  });
  it("findingText strips the suggestion block", () => {
    const plain = inlineBody(f, { sha: "abc" });
    expect(findingText(inlineBody({ ...f, suggestion: "x = 1" }, { sha: "abc" }))).toBe(findingText(plain));
  });
  it("planInline still dedupes and updates when the suggestion changes", () => {
    const first = planInline([{ ...f, suggestion: "a" }], []);
    expect(first.create).toHaveLength(1);
    const ex = [{ id: 9, body: first.create[0]!.body, isBot: true }];
    expect(planInline([{ ...f, suggestion: "a" }], ex).update).toHaveLength(0);
    expect(planInline([{ ...f, suggestion: "b" }], ex).update).toHaveLength(1);
    const resolved = planInline([], ex).update[0]!.body;
    expect(resolved).not.toContain("```suggestion");
    expect(parseMarker(resolved)!.orig).toBe("secret read");
  });
});
