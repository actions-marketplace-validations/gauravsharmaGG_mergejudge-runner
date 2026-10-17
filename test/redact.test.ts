import { describe, expect, it } from "vitest";
import { createLogger, redact, tokenPrefix } from "../src/redact.js";
import { claudeArgs, engineEnv, parseClaudeEnvelope } from "../src/engine.js";
import { defaultConfigPath, validateUrl } from "../src/config.js";
import { parseRetryAfter } from "../src/api.js";

describe("redact", () => {
  it("masks runner tokens, bearer headers, API keys and env-style assignments", () => {
    const tok = `mjr_a_${"x".repeat(43)}`;
    const s = redact(`auth Bearer ${tok} key sk-ant-api03-abcdef ANTHROPIC_API_KEY=sk-123456 MERGEJUDGE_RUNNER_TOKEN=abc ghp_${"a".repeat(30)} ok`);
    expect(s).not.toMatch(/mjr_a_|sk-ant|sk-123456|ghp_|=abc/);
    expect(s).toContain("ok");
  });
  it("masks explicit secrets (>= 6 chars) and ignores trivial ones", () => {
    expect(redact("the password hunter22 here", ["hunter22"])).toBe("the password [redacted] here");
    expect(redact("a b c", ["a"])).toBe("a b c");
  });
  it("logger redacts messages and fields", () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l), () => ["topsecret-value"], () => new Date(0));
    log.warn("failed for topsecret-value", { err: "Bearer abcdefgh12345", n: 3, skip: undefined });
    expect(lines[0]).toBe('1970-01-01T00:00:00.000Z WARN failed for [redacted] err="[redacted]" n=3');
  });
  it("tokenPrefix shows only the start", () => {
    expect(tokenPrefix(`mjr_a_${"z".repeat(43)}`)).toBe("mjr_a_zzzz…");
  });
});

describe("engine helpers", () => {
  it("env is an allowlist copy without credentials", () => {
    const e = engineEnv({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", MERGEJUDGE_X: "1", OPENAI_API_KEY: "o", GITHUB_TOKEN: "g", FOO: "bar", CLAUDE_CODE_OAUTH_TOKEN: "own-login", TMPDIR: "/t" });
    expect(e).toEqual({ PATH: "/bin", HOME: "/h", TMPDIR: "/t", CLAUDE_CODE_OAUTH_TOKEN: "own-login" });
  });
  it("args never contain a prompt and disable tools", () => {
    const a = claudeArgs("sonnet");
    expect(a).toEqual(["-p", "--output-format", "json", "--no-session-persistence", "--disable-slash-commands", "--model", "sonnet", "--tools", ""]);
  });
  it("parses the json envelope (object or event array) and rejects errors", () => {
    expect(parseClaudeEnvelope(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "hi" })).text).toBe("hi");
    expect(parseClaudeEnvelope(JSON.stringify([{ type: "system" }, { type: "result", subtype: "success", result: "yo" }])).text).toBe("yo");
    expect(() => parseClaudeEnvelope("nope")).toThrow(/not JSON/);
    expect(() => parseClaudeEnvelope(JSON.stringify({ type: "result", is_error: true, result: "x" }))).toThrow(/error/);
    expect(() => parseClaudeEnvelope(JSON.stringify({ type: "result", subtype: "success", result: "  " }))).toThrow(/empty/);
  });
});

describe("config + api helpers", () => {
  it("url validation", () => {
    expect(validateUrl("https://app.mergejudge.si/")).toBe("https://app.mergejudge.si");
    expect(validateUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(validateUrl("http://127.0.0.1:1")).toBe("http://127.0.0.1:1");
    expect(() => validateUrl("http://app.mergejudge.si")).toThrow();
    expect(() => validateUrl("ftp://x")).toThrow();
    expect(() => validateUrl("https://u:p@x.si")).toThrow();
  });
  it("default config path honours XDG_CONFIG_HOME", () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "/x" }, "/home/u")).toBe("/x/mergejudge-runner/config.json");
    expect(defaultConfigPath({}, "/home/u")).toBe("/home/u/.config/mergejudge-runner/config.json");
  });
  it("retry-after parsing", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("99999")).toBe(300_000);
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});
