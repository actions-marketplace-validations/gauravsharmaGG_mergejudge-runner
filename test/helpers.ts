import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate } from "../core/aggregate.js";
import { parseConfig } from "../core/config.js";
import { reviewResultSchema } from "./support/review-result-schema.js";
import type { RunnerJobPayload } from "../core/protocol.js";
import { createLogger, type Logger } from "../src/redact.js";
import type { RunnerConfig } from "../src/config.js";

export const DIFF_SENTINEL = "SECRET_DIFF_SENTINEL_9f3a";
export const POLICY_SENTINEL = "POLICY_SENTINEL_77c1";
export const STDOUT_SENTINEL = "ENGINE_STDOUT_SENTINEL_c0de";
export const tok = (c: string) => `mjr_a_${c.repeat(43)}`;
export const ENROLL = `mjr_e_${"E".repeat(43)}`;

export const tmp = (p = "mjr-test-") => mkdtempSync(join(tmpdir(), p));

// ---------------- fake Worker ----------------
export interface Reply { status: number; body?: unknown; headers?: Record<string, string> }
export interface Rec { method: string; path: string; auth: string | null; body: any }

export class FakeWorker {
  server!: Server;
  url = "";
  reqs: Rec[] = [];
  polls: Reply[] = [];
  /** Default poll answer when the script is empty. */
  defaultPoll: Reply = { status: 204 };
  heartbeats: Reply[] = [];
  results: Reply[] = [];
  nacks: Reply[] = [];
  rotates: Reply[] = [];
  registers: Reply[] = [];
  validAuth = new Set<string>();
  /** Called synchronously on each request (e.g. to snapshot the config file). */
  onRequest?: (r: Rec) => void;
  validations: { ok: boolean; issues?: string[] }[] = [];

  async start() {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString();
      const path = new URL(req.url!, "http://x").pathname.replace("/runner/v1", "") + (req.url!.includes("?") ? "?" + req.url!.split("?")[1] : "");
      const rec: Rec = { method: req.method!, path, auth: (req as IncomingMessage).headers.authorization?.replace("Bearer ", "") ?? null, body: raw ? JSON.parse(raw) : null };
      this.reqs.push(rec);
      this.onRequest?.(rec);
      const r = this.route(rec);
      res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
      res.end(r.status === 204 ? undefined : JSON.stringify(r.body ?? {}));
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this;
  }
  stop() { return new Promise<void>((r) => { this.server.closeAllConnections?.(); this.server.close(() => r()); }); }

  private route(r: Rec): Reply {
    if (r.path === "/register") return this.registers.shift() ?? { status: 201, body: { protocol: "v1", runnerId: "run_abc", installationId: 7, accessToken: tok("A"), expiresAt: "2027-01-01T00:00:00Z" } };
    if (!r.auth || !this.validAuth.has(r.auth)) return { status: 401, body: { error: "unauthorized" } };
    if (r.path.startsWith("/poll")) return this.polls.shift() ?? this.defaultPoll;
    if (r.path === "/heartbeat") return { status: 200, body: { ok: true } };
    if (r.path === "/token/rotate") return this.rotates.shift() ?? { status: 200, body: { accessToken: tok("N"), expiresAt: "2027-06-01T00:00:00Z", previousValidForS: 300 } };
    if (/\/jobs\/[^/]+\/heartbeat$/.test(r.path)) return this.heartbeats.shift() ?? { status: 200, body: { ok: true, cancel: false } };
    if (/\/jobs\/[^/]+\/nack$/.test(r.path)) return this.nacks.shift() ?? { status: 200, body: { ok: true, outcome: "requeued" } };
    if (/\/jobs\/[^/]+\/result$/.test(r.path)) {
      const scripted = this.results.shift();
      const parsed = reviewResultSchema.safeParse(r.body?.result);
      this.validations.push(parsed.success ? { ok: true } : { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      if (scripted) return scripted;
      return parsed.success ? { status: 200, body: { ok: true } } : { status: 422, body: { error: "invalid_result" } };
    }
    return { status: 404, body: { error: "not_found" } };
  }
  of(re: RegExp) { return this.reqs.filter((r) => re.test(r.path)); }
}

// ---------------- job payload ----------------
export function makePayload(over: Partial<RunnerJobPayload> = {}): RunnerJobPayload {
  const cfg = parseConfig("");
  const files = [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: `@@ -1 +1 @@\n-a\n+${DIFF_SENTINEL}` }] as RunnerJobPayload["files"];
  const agg = aggregate(files, [], cfg, null);
  cfg.policy_files = ["POLICY.md"];
  return {
    v: 1, repo: { owner: "acme", repo: "app" },
    pr: { number: 5, title: "Change a", body: "body", author: "alice", labels: [], node_id: "PR_x", head: { sha: "abcdef1234", ref: "feature" }, base: { sha: "base1234567", ref: "main" } },
    mode: "diff", cfg, cfgRef: "base1234567", files, policyFiles: { "POLICY.md": POLICY_SENTINEL }, policy: { text: POLICY_SENTINEL, used: [{ path: "POLICY.md", truncated: false }] },
    rules: { lane: agg.lane, files: agg.files, labelReasons: agg.labelReasons, stripped: [] },
    ...over,
  };
}
export function pollJob(payload: RunnerJobPayload = makePayload(), id = "job1", extra: Record<string, unknown> = {}): Reply {
  return {
    status: 200,
    body: {
      job: { id, repo: "acme/app", pr: payload.pr.number, headSha: payload.pr.head.sha, baseSha: payload.pr.base.sha, mode: payload.mode, attempt: 1, payload, ...extra },
      lease: { id: "lease1", expiresAt: "2099-01-01T00:00:00Z", heartbeatEveryS: 15 },
    },
  };
}

// ---------------- fake claude ----------------
export const TRIAGE_REPLY = JSON.stringify({
  summary: "Changes a",
  files: [{ path: "src/a.ts", lane: "review", reason: "logic", findings: [{ line: 1, message: "check this" }] }],
});

export function makeFakeClaude() {
  const dir = tmp("mjr-fakeclaude-");
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), cp = require("child_process");
const dir = __dirname;
const ctl = JSON.parse(fs.readFileSync(path.join(dir, "mode.json"), "utf8"));
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  fs.appendFileSync(path.join(dir, "record.jsonl"), JSON.stringify({ argv: process.argv.slice(2), env: process.env, stdin, cwd: process.cwd(), pid: process.pid }) + "\\n");
  const envelope = (result, extra = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result, usage: { input_tokens: 10, output_tokens: 5 }, ...extra });
  if (ctl.mode === "ok") process.stdout.write(envelope(ctl.reply));
  else if (ctl.mode === "garbage") process.stdout.write(ctl.text || "this is not json");
  else if (ctl.mode === "badtext") process.stdout.write(envelope(ctl.text || "Sorry, I cannot produce JSON."));
  else if (ctl.mode === "iserror") process.stdout.write(envelope("boom", { is_error: true, subtype: "error_during_execution" }));
  else if (ctl.mode === "exit1") { process.stderr.write("bad"); process.exit(1); }
  else if (ctl.mode === "sleep") {
    const gc = cp.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    fs.writeFileSync(path.join(dir, "pids.json"), JSON.stringify({ child: process.pid, grandchild: gc.pid }));
    setInterval(() => {}, 1000);
  }
});
`);
  chmodSync(bin, 0o755);
  const set = (c: Record<string, unknown>) => writeFileSync(join(dir, "mode.json"), JSON.stringify(c));
  set({ mode: "ok", reply: TRIAGE_REPLY });
  return {
    dir, bin, set,
    records: () => (existsSync(join(dir, "record.jsonl")) ? readFileSync(join(dir, "record.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) as { argv: string[]; env: Record<string, string>; stdin: string; cwd: string; pid: number }[],
    pids: () => JSON.parse(readFileSync(join(dir, "pids.json"), "utf8")) as { child: number; grandchild: number },
  };
}
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export async function waitFor(f: () => boolean, ms = 10_000) {
  const t0 = Date.now();
  while (!f()) { if (Date.now() - t0 > ms) throw new Error("waitFor timed out"); await new Promise((r) => setTimeout(r, 25)); }
}

// ---------------- config + logs ----------------
export function writeCfg(dir: string, url: string, over: Partial<RunnerConfig> = {}): { path: string; cfg: RunnerConfig } {
  const cfgDir = join(dir, "cfg");
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  const cfg: RunnerConfig = { v: 1, url, runnerId: "run_abc", name: "box", engine: "claude-code", token: tok("A"), tokenExpiresAt: "2099-01-01T00:00:00Z", claudeBin: null, registeredAt: "2026-10-14T00:00:00Z", ...over };
  const path = join(cfgDir, "config.json");
  writeFileSync(path, JSON.stringify(cfg), { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, cfg };
}
export function captureLog(secrets: () => string[] = () => []): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: createLogger((l) => lines.push(l), secrets), lines };
}
export const fastSleep = async () => {};

// ---------------- fake codex ----------------
export function makeFakeCodex() {
  const dir = tmp("mjr-fakecodex-");
  const bin = join(dir, "codex");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const dir = __dirname;
const ctl = JSON.parse(fs.readFileSync(path.join(dir, "mode.json"), "utf8"));
const argv = process.argv.slice(2);
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  const val = (flag) => argv[argv.indexOf(flag) + 1];
  const schemaFile = val("--output-schema"), outFile = val("-o");
  const schema = schemaFile && fs.existsSync(schemaFile) ? fs.readFileSync(schemaFile, "utf8") : null;
  fs.appendFileSync(path.join(dir, "record.jsonl"), JSON.stringify({ argv, env: process.env, stdin, cwd: process.cwd(), schema }) + "\\n");
  process.stdout.write("codex progress noise that must be ignored\\n");
  if (ctl.mode === "ok") fs.writeFileSync(outFile, ctl.reply);
  else if (ctl.mode === "nofile") { /* exits 0 without writing the last message */ }
  else if (ctl.mode === "exit1") { process.stderr.write("bad"); process.exit(1); }
});
`);
  chmodSync(bin, 0o755);
  const set = (c: Record<string, unknown>) => writeFileSync(join(dir, "mode.json"), JSON.stringify(c));
  set({ mode: "ok", reply: TRIAGE_REPLY });
  return {
    dir, bin, set,
    records: () => (existsSync(join(dir, "record.jsonl")) ? readFileSync(join(dir, "record.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) as { argv: string[]; env: Record<string, string>; stdin: string; cwd: string; schema: string | null }[],
  };
}
