import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { commonBinDirs, engineLine, engineLines, glmReport, locateBin, NO_ENGINE_MESSAGE, unlistedEngineNotes, detectClis } from "../src/detect.js";
import { runLoop, type RunOptions } from "../src/run.js";
import type { ExecFn } from "../src/setup.js";
import { VERSION } from "../src/version.js";
import { captureLog, ENROLL, FakeWorker, makeFakeClaude, tmp, tok, writeCfg } from "./helpers.js";

type Cli = "missing" | "ready" | "nologin" | "apikey";
/** Fake probes: a binary exists only when it is given by absolute path (so "not found" really means not located). */
const fakeExec = (st: { claude?: Cli; codex?: Cli }): ExecFn => (bin, args) => {
  const codex = bin.endsWith("codex");
  const s = (codex ? st.codex : st.claude) ?? "missing";
  if (s === "missing" || !bin.startsWith("/")) return { status: null };
  if (args[0] === "--version") return { status: 0 };
  if (!codex) return { status: s === "ready" ? 0 : 1 };
  if (s === "ready") return { status: 0, output: "Logged in using ChatGPT\n" };
  if (s === "apikey") return { status: 0, output: "Logged in using an API key - sk-proj-***abcd\n" };
  return { status: 1, output: "Not logged in\n" };
};
const filesAt = (...paths: string[]) => (p: string) => paths.includes(p);
const BOTH = filesAt("/usr/bin/claude", "/usr/bin/codex");

describe("version", () => {
  it("src/version.ts matches package.json", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});

describe("locateBin / common directories", () => {
  const home = "/home/u";
  it("PATH wins and is not flagged off-PATH", () => {
    expect(locateBin("codex", { PATH: "/a:/b" }, home, filesAt("/b/codex", "/home/u/.local/bin/codex"))).toEqual({ path: "/b/codex", offPath: false });
  });
  it("searches npm prefix bin, CODEX_INSTALL_DIR (codex only), ~/.local/bin, /opt/homebrew/bin, /usr/local/bin in that order", () => {
    const env = { PATH: "/a", npm_config_prefix: "/npm", CODEX_INSTALL_DIR: "/ci" };
    expect(commonBinDirs("codex", env, home)).toEqual(["/npm/bin", "/ci", "/home/u/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]);
    expect(commonBinDirs("claude", env, home)).toEqual(["/npm/bin", "/home/u/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]);
    for (const [dir, env2] of [["/npm/bin", env], ["/home/u/.local/bin", {}], ["/opt/homebrew/bin", {}], ["/usr/local/bin", {}]] as const) {
      expect(locateBin("codex", { PATH: "/a", ...env2 }, home, filesAt(`${dir}/codex`))).toEqual({ path: `${dir}/codex`, offPath: true });
    }
    expect(locateBin("codex", { PATH: "/a" }, home, () => false)).toEqual({ path: null, offPath: false });
  });
  it("an explicit --codex-bin is used as given and never flagged", () => {
    const r = detectClis({ env: { PATH: "" }, home, exec: fakeExec({ codex: "ready" }), fileExists: () => false, codexBin: "/opt/x/codex" });
    expect(r.find((e) => e.engine === "codex")).toMatchObject({ state: "ready", bin: "/opt/x/codex" });
    expect(r.find((e) => e.engine === "codex")!.foundAt).toBeUndefined();
  });
});

describe("engine lines", () => {
  it("one line per state, with hints only for engines that are not ready", () => {
    const reports = detectClis({ env: { PATH: "/usr/bin" }, home: "/h", exec: fakeExec({ claude: "ready", codex: "apikey" }), fileExists: BOTH });
    const lines = engineLines([...reports, glmReport(false)], "/h");
    expect(lines[0]).toBe("claude-code: ready");
    expect(lines[1]).toContain("codex: installed, not signed in (Codex is signed in with an API key, but the runner only uses a ChatGPT sign-in");
    expect(lines[2]).toBe("  Run `codex login` and choose \"Sign in with ChatGPT\", then run setup again.");
    expect(lines[3]).toBe("glm: no API key (optional; z.ai bills per use)");
    expect(engineLine(glmReport(true), "/h")).toBe("glm: ready (your z.ai API key; z.ai bills you per use)");
    expect(lines.join("\n")).not.toContain("sk-proj");
  });
  it("not-found hints carry the official install and sign-in steps", () => {
    const lines = engineLines(detectClis({ env: { PATH: "/usr/bin" }, home: "/h", exec: fakeExec({}), fileExists: () => false }), "/h");
    expect(lines).toEqual([
      "claude-code: not found",
      "  Install Claude Code (see https://code.claude.com/docs/en/quickstart), then run `claude` once and sign in with your own subscription.",
      "codex: not found",
      "  Install Codex with `npm install -g @openai/codex` (or `brew install --cask codex`, or `curl -fsSL https://chatgpt.com/codex/install.sh | sh`), then run `codex login` and choose \"Sign in with ChatGPT\". After the installer you may need a new terminal.",
    ]);
  });
  it("claude installed but not signed in", () => {
    const lines = engineLines(detectClis({ env: { PATH: "/usr/bin" }, home: "/h", exec: fakeExec({ claude: "nologin" }), fileExists: BOTH }), "/h", true);
    expect(lines[0]).toBe("claude-code: installed, not signed in (`claude auth status` does not report a sign-in)");
    expect(lines[1]).toBe("  Run `claude` and sign in with your own subscription (or `claude setup-token`), then run setup again.");
  });
  it("notes name ready engines missing from the config, and only those", () => {
    const reports = detectClis({ env: { PATH: "/usr/bin" }, home: "/h", exec: fakeExec({ claude: "ready", codex: "ready" }), fileExists: BOTH });
    expect(unlistedEngineNotes(["claude-code"], reports)).toEqual(["codex is ready but not in this runner's config; run `mergejudge-runner setup --force` to add it"]);
    expect(unlistedEngineNotes(["claude-code", "codex"], reports)).toEqual([]);
  });
});

let w: FakeWorker;
let home: string;
beforeEach(async () => { w = await new FakeWorker().start(); w.validAuth.add(tok("A")); home = tmp("mjr-home-"); });
afterEach(async () => { await w.stop(); });
const cfgPath = () => join(home, ".config", "mergejudge-runner", "config.json");
const registered = () => w.reqs.find((q) => q.path === "/register")!.body;
const caps = () => registered().capabilities.map((c: { engine: string }) => c.engine);

async function cmd(argv: string[], st: { claude?: Cli; codex?: Cli }, deps: object = {}, files: (p: string) => boolean = BOTH) {
  const out: string[] = [], err: string[] = [];
  const code = await main([...argv, "--config", cfgPath()], {
    env: { MERGEJUDGE_URL: w.url, PATH: "/usr/bin" }, home, nodePath: "/usr/bin/node", exec: fakeExec(st), fileExists: files,
    out: (l) => out.push(l), err: (l) => err.push(l), sleep: async () => {}, ...deps,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const setup = (st: { claude?: Cli; codex?: Cli }, extra: string[] = [], deps: object = {}, files?: (p: string) => boolean) =>
  cmd(["setup", ENROLL, "--no-autostart", "--no-glm", ...extra], st, deps, files);

describe("setup: every engine is shown", () => {
  it("prints one line per engine even when codex is not installed, with a hint", async () => {
    const r = await setup({ claude: "ready" }, [], {}, filesAt("/usr/bin/claude"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("claude-code: ready");
    expect(r.out).toContain("codex: not found");
    expect(r.out).toContain("npm install -g @openai/codex");
    expect(r.out).toContain("glm: no API key (optional; z.ai bills per use)");
    expect(r.out).not.toContain("No engine is ready yet");
  });
  it("nothing ready: says so, keeps claude-code as the not-yet-usable default, registration still works", async () => {
    const r = await setup({}, [], {}, () => false);
    expect(r.code).toBe(0);
    expect(r.out).toContain(NO_ENGINE_MESSAGE);
    expect(r.out).toContain("claude-code: not found");
    expect(r.out).toContain("codex: not found");
    expect(loadConfig(cfgPath()).engine).toBe("claude-code");
  });
  it("a binary found in a common directory is used, said so, and stored in the config", async () => {
    const r = await setup({ claude: "ready", codex: "ready" }, [], {}, filesAt("/usr/bin/claude", join(home, ".local", "bin", "codex")));
    expect(r.out).toContain("codex: ready (found at ~/.local/bin/codex, which is not on PATH)");
    expect(r.out).not.toContain("claude-code: ready (found");
    expect(caps()).toEqual(["claude-code", "codex"]);
    expect(loadConfig(cfgPath()).codexBin).toBe(join(home, ".local", "bin", "codex"));
    expect(loadConfig(cfgPath()).claudeBin).toBeNull();
  });
  it("--print-unit on an existing config shows the engine lines too", async () => {
    await setup({ claude: "ready" });
    const r = await cmd(["setup", "--print-unit"], { claude: "ready" }, { platform: "linux" });
    expect(r.out).toContain("claude-code: ready");
    expect(r.out).toContain("codex: not found");
    expect(r.out).toContain("glm: no API key");
  });
});

describe("setup: choosing the default when several are ready", () => {
  const pick = async (answer: string, extra: string[] = []) => {
    const asked: string[] = [];
    const r = await setup({ claude: "ready", codex: "ready" }, extra, { prompt: async (q: string) => { asked.push(q); return /Default engine/.test(q) ? answer : ""; } });
    return { r, asked, cfg: loadConfig(cfgPath()) };
  };
  it("2 makes codex the default and keeps claude-code enabled after it", async () => {
    const { r, asked, cfg } = await pick("2");
    expect(r.out).toContain("More than one engine is ready. Which should be the default? The others stay enabled.");
    expect(r.out).toContain("  1) claude-code");
    expect(r.out).toContain("  2) codex");
    expect(asked).toContain("Default engine (1-2, Enter = 1): ");
    expect(cfg.engine).toBe("codex");
    expect(Object.keys(cfg.engines!)).toEqual(["codex", "claude-code"]);
    expect(caps()).toEqual(["codex", "claude-code"]);
  });
  it("Enter picks the first; an invalid answer says so and also uses the first", async () => {
    expect((await pick("")).cfg.engine).toBe("claude-code");
    const bad = await pick("banana");
    expect(bad.r.out).toContain("Not a valid number; using claude-code.");
    expect(bad.cfg.engine).toBe("claude-code");
  });
  it("is not asked with --engine", async () => {
    const withFlag = await pick("2", ["--engine", "claude-code"]);
    expect(withFlag.asked.some((q) => /Default engine/.test(q))).toBe(false);
    expect(withFlag.cfg.engine).toBe("claude-code");
  });
  it("is not asked with only one engine ready", async () => {
    const asked: string[] = [];
    await setup({ claude: "ready", codex: "nologin" }, [], { prompt: async (q: string) => { asked.push(q); return ""; } });
    expect(asked.some((q) => /Default engine/.test(q))).toBe(false);
  });
});

describe("login and register detect engines", () => {
  const deviceOk = () => w.devicePolls.push({ status: 200, body: { state: "registered", protocol: "v1", runnerId: "run_dev", installationId: 7, accessToken: tok("A"), expiresAt: "2027-01-01T00:00:00Z" } });
  it("register: only codex ready -> codex is the default instead of claude-code", async () => {
    const r = await cmd(["register", "--code", ENROLL, "--url", w.url], { codex: "ready" }, {}, filesAt("/usr/bin/codex"));
    expect(r.code).toBe(0);
    expect(caps()).toEqual(["codex"]);
    expect(loadConfig(cfgPath()).engine).toBe("codex");
    expect(r.out).toContain("Next: make sure `codex` is signed in with ChatGPT");
  });
  it("register: both ready -> both enabled, claude-code first; the request carries both", async () => {
    await cmd(["register", "--code", ENROLL, "--url", w.url], { claude: "ready", codex: "ready" });
    expect(caps()).toEqual(["claude-code", "codex"]);
  });
  it("register: --engine still overrides detection", async () => {
    const r = await cmd(["register", "--code", ENROLL, "--url", w.url, "--engine", "claude-code"], { claude: "ready", codex: "ready" });
    expect(r.code).toBe(0);
    expect(caps()).toEqual(["claude-code"]);
    expect(r.out).not.toContain("No engine is ready yet");
  });
  it("register: nothing ready -> message with hints, claude-code fallback, still registers", async () => {
    const r = await cmd(["register", "--code", ENROLL, "--url", w.url], {}, {}, () => false);
    expect(r.code).toBe(0);
    expect(r.out).toContain(NO_ENGINE_MESSAGE);
    expect(r.out).toContain("codex: not found");
    expect(caps()).toEqual(["claude-code"]);
  });
  it("register: a codex found off PATH is stored as codexBin", async () => {
    await cmd(["register", "--code", ENROLL, "--url", w.url], { codex: "ready" }, {}, filesAt("/usr/local/bin/codex"));
    expect(loadConfig(cfgPath())).toMatchObject({ engine: "codex", codexBin: "/usr/local/bin/codex" });
  });
  it("login: detects too (codex only ready)", async () => {
    deviceOk();
    const r = await cmd(["login"], { codex: "ready" }, {}, filesAt("/usr/bin/codex"));
    expect(r.code).toBe(0);
    expect(loadConfig(cfgPath()).engine).toBe("codex");
    expect(w.of(/device\/poll/)[0]!.body.engines).toEqual(["codex"]);
  });
  it("login: nothing ready prints the message, falls back to claude-code", async () => {
    deviceOk();
    const r = await cmd(["login"], {}, {}, () => false);
    expect(r.out).toContain(NO_ENGINE_MESSAGE);
    expect(loadConfig(cfgPath()).engine).toBe("claude-code");
  });
});

describe("status and run note ready engines missing from the config", () => {
  const NOTE = "codex is ready but not in this runner's config; run `mergejudge-runner setup --force` to add it";
  it("status prints a note and leaves the config alone", async () => {
    await setup({ claude: "ready" }, [], {}, filesAt("/usr/bin/claude"));
    const before = readFileSync(cfgPath(), "utf8");
    const r = await cmd(["status"], { claude: "ready", codex: "ready" });
    expect(r.out).toContain(`note:       ${NOTE}`);
    expect(readFileSync(cfgPath(), "utf8")).toBe(before);
  });
  it("status prints no note when every ready engine is configured, nor after setup itself", async () => {
    const s = await setup({ claude: "ready", codex: "ready" });
    expect(s.out).not.toContain("is ready but not in this runner's config");
    expect((await cmd(["status"], { claude: "ready", codex: "ready" })).out).not.toContain("is ready but not in");
  });
  it("status finds codex in a common directory", async () => {
    await setup({ claude: "ready" }, [], {}, filesAt("/usr/bin/claude"));
    const r = await cmd(["status"], { claude: "ready", codex: "ready" }, {}, filesAt("/usr/bin/claude", "/opt/homebrew/bin/codex"));
    expect(r.out).toContain(NOTE);
  });
  it("run logs the note at startup and does not touch the config", async () => {
    const fc = makeFakeClaude();
    const dir = tmp();
    const { path, cfg } = writeCfg(dir, w.url, { engine: "claude-code", engines: { "claude-code": {} } });
    const before = readFileSync(path, "utf8");
    const cap = captureLog();
    const ac = new AbortController();
    const e = { PATH: `${fc.dir}:/usr/bin`, HOME: dir };
    const o: RunOptions = {
      cfg, configPath: path, log: cap.log, signal: ac.signal, once: true, waitS: 1, heartbeatMs: 100, backoff: { baseMs: 1, maxMs: 5 },
      env: e, claude: { bin: fc.bin, env: e }, exec: fakeExec({ codex: "ready" }), home: "/home/u", fileExists: filesAt("/home/u/.local/bin/codex"),
    };
    expect(await runLoop(o)).toBe(0);
    expect(cap.lines.join("\n")).toContain(NOTE);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
