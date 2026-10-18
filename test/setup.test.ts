import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { engineEnv } from "../src/engine.js";
import { buildUnit, checkCli, cliWarnings, type ExecFn } from "../src/setup.js";
import { ENROLL, FakeWorker, tmp, tok } from "./helpers.js";

let w: FakeWorker;
let home: string;
let bundle: string;
beforeEach(async () => {
  w = await new FakeWorker().start();
  w.validAuth.add(tok("A"));
  home = tmp("mjr-home-");
  bundle = join(home, "cli.js");
  writeFileSync(bundle, "// bundle\n");
});
afterEach(async () => { await w.stop(); });

const okExec = (calls: string[][] = []): ExecFn => (bin, args) => { calls.push([bin, ...args]); return { status: 0 }; };
const base = (extra: object = {}) => ({
  env: { MERGEJUDGE_URL: w.url, PATH: "/usr/bin" } as Record<string, string>, home, bundlePath: bundle, nodePath: "/usr/bin/node", exec: okExec(), fileExists: () => false, ...extra,
});
const cfgPath = () => join(home, ".config", "mergejudge-runner", "config.json");
const run = async (args: string[], deps: object = {}) => {
  const out: string[] = [], err: string[] = [];
  const code = await main(["setup", ...args, "--config", cfgPath()], { ...base(), out: (l) => out.push(l), err: (l) => err.push(l), ...deps });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

describe("setup", () => {
  it("registers via MERGEJUDGE_URL, writes 0600 config in a 0700 dir and never prints the token", async () => {
    const r = await run([ENROLL, "--no-autostart"]);
    expect(r.code).toBe(0);
    expect(w.reqs.find((q) => q.path === "/register")?.auth).toBe(ENROLL);
    expect(statSync(cfgPath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".config", "mergejudge-runner")).mode & 0o777).toBe(0o700);
    expect(r.out + r.err).not.toContain(tok("A"));
    expect(r.out + r.err).not.toContain(tok("A").slice(0, 10));
    expect(r.out + r.err).not.toContain(ENROLL);
    expect(r.out).toContain("Registered runner run_abc");
    expect(r.out).toContain("heartbeat:  ok");
  });

  it("signs in with GitHub when no code is given (details in login.test.ts)", async () => {
    w.devicePolls.push({ status: 200, body: { state: "registered", protocol: "v1", runnerId: "run_dev", installationId: 7, accessToken: tok("A"), expiresAt: "2027-01-01T00:00:00Z" } });
    const r = await run(["--no-autostart"], { sleep: async () => {} });
    expect(r.code).toBe(0);
    expect(r.out).toContain("ABCD-1234");
    expect(existsSync(cfgPath())).toBe(true);
  });

  it("fails cleanly on a bad code and does not write a config", async () => {
    w.registers.push({ status: 401, body: { error: "unauthorized" } });
    const r = await run([ENROLL, "--no-autostart"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/invalid, expired/);
    expect(existsSync(cfgPath())).toBe(false);
  });

  it("warns (non-fatal) when claude is missing or not signed in", async () => {
    const missing = await run([ENROLL, "--no-autostart"], { exec: () => ({ status: null }) });
    expect(missing.code).toBe(0);
    expect(missing.out).toMatch(/warning: Claude Code .* not found/);
    const home2 = tmp("mjr-home-");
    const noLogin = await main(["setup", ENROLL, "--no-autostart", "--config", join(home2, "c", "config.json")], {
      ...base({ home: home2 }), out: () => {}, err: () => {},
      exec: (_b, a) => ({ status: a[0] === "auth" ? 1 : 0 }),
    });
    expect(noLogin).toBe(0);
  });

  it("installs a systemd user unit on linux with --yes", async () => {
    const calls: string[][] = [];
    const r = await run([ENROLL, "--yes"], { platform: "linux", exec: okExec(calls) });
    expect(r.code).toBe(0);
    const unit = readFileSync(join(home, ".config", "systemd", "user", "mergejudge-runner.service"), "utf8");
    expect(unit).toContain("run --config");
    expect(unit).toContain("UnsetEnvironment=ANTHROPIC_API_KEY");
    expect(unit).not.toContain(tok("A"));
    expect(readFileSync(join(home, ".config", "mergejudge-runner", "runner.mjs"), "utf8")).toBe("// bundle\n");
    expect(calls).toContainEqual(["systemctl", "--user", "enable", "--now", "mergejudge-runner.service"]);
  });

  it("installs a launchd plist on macOS, adding NODE_EXTRA_CA_CERTS only when the bundle exists and the var is unset", async () => {
    const calls: string[][] = [];
    const r = await run([ENROLL, "--yes"], { platform: "darwin", exec: okExec(calls), fileExists: (p: string) => p === "/etc/ssl/cert.pem" });
    expect(r.code).toBe(0);
    const plist = readFileSync(join(home, "Library", "LaunchAgents", "si.mergejudge.runner.plist"), "utf8");
    expect(plist).toContain("<key>NODE_EXTRA_CA_CERTS</key>");
    expect(plist).toContain("<string>/etc/ssl/cert.pem</string>");
    expect(plist).not.toContain("ANTHROPIC");
    expect(calls.some((c) => c[0] === "launchctl" && c[1] === "bootstrap")).toBe(true);

    const d = { platform: "darwin", home, exec: okExec(), node: "/usr/bin/node", configPath: cfgPath(), claudeBin: null, fileExists: () => true };
    expect(buildUnit({ ...d, env: { NODE_EXTRA_CA_CERTS: "/x.pem" } })!.text).not.toContain("NODE_EXTRA_CA_CERTS");
    expect(buildUnit({ ...d, env: {}, fileExists: () => false })!.text).not.toContain("NODE_EXTRA_CA_CERTS");
  });

  it("--print-unit prints the unit and writes nothing", async () => {
    const r = await run([ENROLL, "--print-unit"], { platform: "linux" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("[Service]");
    expect(existsSync(join(home, ".config", "systemd"))).toBe(false);
  });

  it("asks before installing and honours a 'no'", async () => {
    const r = await run([ENROLL], { platform: "linux", prompt: async () => "n" });
    expect(r.code).toBe(0);
    expect(existsSync(join(home, ".config", "systemd"))).toBe(false);
    expect(r.out).toContain("Skipping auto-start");
  });

  it("refuses to replace an existing registration without --force", async () => {
    mkdirSync(join(home, ".config", "mergejudge-runner"), { recursive: true });
    writeFileSync(cfgPath(), "{}", { mode: 0o600 });
    expect((await run([ENROLL, "--no-autostart"])).code).toBe(2);
  });
});

describe("engine env / cli checks", () => {
  it("never passes ANTHROPIC_API_KEY to the engine", () => {
    const e = engineEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-x", CLAUDE_CODE_OAUTH_TOKEN: "oauth" });
    expect(e.ANTHROPIC_API_KEY).toBeUndefined();
    expect(e.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth");
  });
  it("probes the CLI without ANTHROPIC_API_KEY", () => {
    const seen: Record<string, string | undefined>[] = [];
    const c = checkCli("claude", "claude", { PATH: "/bin", ANTHROPIC_API_KEY: "sk" }, (_b, _a, env) => { seen.push(env); return { status: 0 }; });
    expect(c).toEqual({ name: "claude", installed: true, signedIn: true });
    expect(seen.every((e) => e.ANTHROPIC_API_KEY === undefined)).toBe(true);
    expect(cliWarnings([c])).toEqual([]);
  });
});

describe("--help", () => {
  const help = async (argv: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  for (const flag of ["--help", "-h"]) {
    it(`top-level ${flag} prints usage and exits 0`, async () => {
      const r = await help([flag]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Usage:");
    });
    for (const cmd of ["register", "setup", "run", "status"]) {
      it(`${cmd} ${flag} prints usage and exits 0 without side effects`, async () => {
        const r = await help([cmd, flag]);
        expect(r.code).toBe(0);
        expect(r.err).toBe("");
        expect(r.out).toContain(`mergejudge-runner ${cmd}`);
      });
    }
  }
});
