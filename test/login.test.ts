import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { DEVICE_SESSION, FakeWorker, tmp, tok, type Reply } from "./helpers.js";

let w: FakeWorker;
let home: string;
beforeEach(async () => { w = await new FakeWorker().start(); home = tmp("mjr-home-"); });
afterEach(async () => { await w.stop(); });

const cfgPath = () => join(home, ".config", "mergejudge-runner", "config.json");
const registered: Reply = { status: 200, body: { state: "registered", protocol: "v1", runnerId: "run_dev", installationId: 7, accessToken: tok("A"), expiresAt: "2027-01-01T00:00:00Z" } };
const pending: Reply = { status: 200, body: { state: "pending", interval: 5 } };

async function login(args: string[] = [], deps: object = {}, cmd: "login" | "setup" = "login") {
  const out: string[] = [], err: string[] = [], sleeps: number[] = [];
  const code = await main([cmd, ...args, "--config", cfgPath()], {
    env: { MERGEJUDGE_URL: w.url, PATH: "/usr/bin" }, home, out: (l) => out.push(l), err: (l) => err.push(l),
    sleep: async (ms) => { sleeps.push(ms); }, exec: () => ({ status: 0 }), fileExists: () => false, ...deps,
  });
  const all = [...out, ...err].join("\n");
  // The session handle and the access token must never reach the terminal.
  expect(all).not.toContain(DEVICE_SESSION);
  expect(all).not.toContain(tok("A"));
  return { code, out: out.join("\n"), err: err.join("\n"), sleeps };
}

describe("login", () => {
  it("happy path: shows the code, polls, writes a 0600 config", async () => {
    w.devicePolls.push(registered);
    const r = await login(["--name", "my-mac"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("https://github.com/login/device");
    expect(r.out).toContain("ABCD-1234");
    expect(r.out).toContain("Registered runner run_dev (my-mac)");
    expect(r.sleeps).toEqual([5000]);
    const start = w.of(/device\/start/)[0]!;
    expect(start.body).toEqual({});
    expect(start.auth).toBeNull();
    const poll = w.of(/device\/poll/)[0]!;
    expect(poll.body).toMatchObject({ session: DEVICE_SESSION, name: "my-mac", engines: ["claude-code"], modes: ["diff", "context", "deep"], concurrency: 1, features: ["local-code"] });
    expect(poll.body.capabilities[0]).toMatchObject({ engine: "claude-code" });
    expect(poll.body).not.toHaveProperty("installation_id");
    expect(statSync(cfgPath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".config", "mergejudge-runner")).mode & 0o777).toBe(0o700);
    const saved = JSON.parse(readFileSync(cfgPath(), "utf8"));
    expect(saved).toMatchObject({ runnerId: "run_dev", installationId: 7, token: tok("A"), url: w.url, name: "my-mac" });
    expect(JSON.stringify(saved)).not.toContain(DEVICE_SESSION);
  });

  it("pending, then slow_down (new interval), then success", async () => {
    w.devicePolls.push(pending, { status: 200, body: { state: "slow_down", interval: 10 } }, pending, registered);
    const r = await login();
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([5000, 5000, 10000, 5000]);
    expect(w.of(/device\/poll/)).toHaveLength(4);
  });

  it("passes --installation along", async () => {
    w.devicePolls.push(registered);
    expect((await login(["--installation", "42"])).code).toBe(0);
    expect(w.of(/device\/poll/)[0]!.body.installation_id).toBe(42);
  });

  it("choose_installation, interactive: asks, then polls again with installation_id and no sleep", async () => {
    w.devicePolls.push({ status: 200, body: { state: "choose_installation", installations: [{ id: 11, account: "alpha" }, { id: 22, account: "beta" }] } }, registered);
    const answers = ["x", "2"];
    const r = await login([], { prompt: async () => answers.shift()! });
    expect(r.code).toBe(0);
    expect(r.out).toContain("1) alpha (11)");
    expect(r.out).toContain("Not a valid number.");
    const polls = w.of(/device\/poll/);
    expect(polls).toHaveLength(2);
    expect(polls[1]!.body.installation_id).toBe(22);
    expect(polls[1]!.body.session).toBe(DEVICE_SESSION);
    expect(r.sleeps).toEqual([5000, 0]);
  });

  it("choose_installation, non-interactive: lists them and exits non-zero without a config", async () => {
    w.devicePolls.push({ status: 200, body: { state: "choose_installation", installations: [{ id: 11, account: "alpha" }, { id: 22, account: "beta" }] } });
    const r = await login();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("11  alpha");
    expect(r.out).toContain("22  beta");
    expect(r.err).toContain("--installation");
    expect(existsSync(cfgPath())).toBe(false);
  });

  it("no_installation: prints the install URL and fails", async () => {
    w.devicePolls.push({ status: 200, body: { state: "no_installation", install_url: "https://github.com/apps/example/installations/new" } });
    const r = await login();
    expect(r.code).toBe(1);
    expect(r.out).toContain("https://github.com/apps/example/installations/new");
    expect(existsSync(cfgPath())).toBe(false);
  });

  it("expired and denied fail cleanly", async () => {
    w.devicePolls.push({ status: 200, body: { state: "expired" } });
    const a = await login();
    expect(a.code).toBe(1);
    expect(a.err).toMatch(/expired/);
    w.devicePolls.push({ status: 200, body: { state: "denied" } });
    const b = await login();
    expect(b.code).toBe(1);
    expect(b.err).toMatch(/cancelled/);
    expect(existsSync(cfgPath())).toBe(false);
  });

  it("waits and retries after 429 with Retry-After (start and poll)", async () => {
    w.deviceStarts.push({ status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "7" } });
    w.devicePolls.push({ status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "3" } }, registered);
    const r = await login();
    expect(r.code).toBe(0);
    expect(r.sleeps).toEqual([7000, 5000, 3000]);
    expect(w.of(/device\/start/)).toHaveLength(2);
    expect(w.of(/device\/poll/)).toHaveLength(2);
  });

  it("gives up after repeated 429", async () => {
    for (let i = 0; i < 8; i++) w.deviceStarts.push({ status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "1" } });
    const r = await login();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/rate limited/);
  });

  it("maps 403 / 404 / 503 to readable errors", async () => {
    w.devicePolls.push({ status: 403, body: { error: "not_admin" } });
    expect((await login()).err).toMatch(/owner or admin/);
    w.devicePolls.push({ status: 404, body: { error: "unknown_session" } });
    expect((await login()).err).toMatch(/no longer valid/);
    w.deviceStarts.push({ status: 503, body: { error: "device_flow_unavailable" } });
    const r = await login();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/setup <code>/);
    expect(existsSync(cfgPath())).toBe(false);
  });

  it("refuses to replace an existing registration without --force, before contacting the server", async () => {
    w.devicePolls.push(registered);
    expect((await login()).code).toBe(0);
    w.reqs.length = 0;
    const r = await login();
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--force/);
    expect(w.reqs).toHaveLength(0);
  });
});

describe("setup without a code", () => {
  it("runs the sign-in, then the usual steps", async () => {
    w.validAuth.add(tok("A"));
    w.devicePolls.push(registered);
    const r = await login(["--no-autostart", "--no-glm"], {}, "setup");
    expect(r.code).toBe(0);
    expect(r.out).toContain("ABCD-1234");
    expect(r.out).toContain("Registered runner run_dev");
    expect(r.out).toContain("heartbeat:  ok");
    expect(w.of(/\/register/)).toHaveLength(0);
  });

  it("setup <code> still uses the enrollment code", async () => {
    w.validAuth.add(tok("A"));
    const r = await login([`mjr_e_${"E".repeat(43)}`, "--no-autostart"], {}, "setup");
    expect(r.code).toBe(0);
    expect(w.of(/device\//)).toHaveLength(0);
    expect(w.of(/\/register/)).toHaveLength(1);
  });
});
