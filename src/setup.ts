/** `mergejudge-runner setup`: CLI checks and auto-start (launchd / systemd user unit). Registration lives in cli.ts. */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { engineEnv } from "./engine.js";

export const LAUNCHD_LABEL = "si.mergejudge.runner";
export const SYSTEMD_UNIT = "mergejudge-runner.service";
export const DEFAULT_URL = "https://app.mergejudge.si";
const CA_BUNDLE = "/etc/ssl/cert.pem";

export interface ExecResult { status: number | null; /** stdout + stderr, when the probe needs to read it. */ output?: string }
export type ExecFn = (bin: string, args: string[], env: Record<string, string | undefined>) => ExecResult;

export const defaultExec: ExecFn = (bin, args, env) => {
  const r = spawnSync(bin, args, { env: env as NodeJS.ProcessEnv, timeout: 20_000, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  return { status: r.error ? null : r.status, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
};

export interface CliCheck { name: "claude" | "codex"; installed: boolean; signedIn: boolean; /** codex only: signed in, but with an API key instead of ChatGPT. */ apiKeyLogin?: boolean }

/** `codex login status` output: only a ChatGPT sign-in counts (WARNING lines and stdout/stderr placement do not matter). */
export function codexLoginKind(r: ExecResult): "chatgpt" | "api-key" | "none" {
  if (r.status !== 0) return "none";
  const lines = (r.output ?? "").split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => /^Logged in using ChatGPT\b/i.test(l))) return "chatgpt";
  return lines.some((l) => /^Logged in using an API key/i.test(l)) ? "api-key" : "none";
}

/**
 * Checks that a provider CLI is installed and signed in (`claude auth status`, `codex login status`; the exit code decides).
 * The probe environment never carries ANTHROPIC_API_KEY / OPENAI_API_KEY / CODEX_API_KEY, so it reports the subscription login.
 */
export function checkCli(name: CliCheck["name"], bin: string, env: Record<string, string | undefined>, exec: ExecFn): CliCheck {
  const probeEnv = engineEnv(env, name === "codex" ? "codex" : "claude-code");
  if (exec(bin, ["--version"], probeEnv).status !== 0) return { name, installed: false, signedIn: false };
  if (name === "claude" && probeEnv.CLAUDE_CODE_OAUTH_TOKEN) return { name, installed: true, signedIn: true };
  const st = exec(bin, name === "claude" ? ["auth", "status"] : ["login", "status"], probeEnv);
  if (name === "codex") { const k = codexLoginKind(st); return { name, installed: true, signedIn: k === "chatgpt", ...(k === "api-key" ? { apiKeyLogin: true } : {}) }; }
  return { name, installed: true, signedIn: st.status === 0 };
}

export const CODEX_API_KEY_REASON = "Codex is signed in with an API key, but the runner only uses a ChatGPT sign-in (your subscription).";
export const CODEX_NOT_CHATGPT_REASON = "Codex is not signed in with ChatGPT (run `codex login` and choose \"Sign in with ChatGPT\")";

export function cliWarnings(checks: CliCheck[]): string[] {
  const w: string[] = [];
  const claude = checks.find((c) => c.name === "claude");
  if (claude && !claude.installed) w.push("Claude Code (`claude`) was not found. Install it (see https://code.claude.com/docs/en/quickstart), then run `claude` once and sign in with your own subscription.");
  else if (claude && !claude.signedIn) w.push("Claude Code is installed but does not look signed in. Run `claude` and sign in with your own subscription (or `claude setup-token`).");
  const codex = checks.find((c) => c.name === "codex");
  if (codex?.installed && codex.apiKeyLogin) w.push(CODEX_API_KEY_REASON + " Codex is not offered; run `codex login`, choose \"Sign in with ChatGPT\", then run setup again.");
  else if (codex?.installed && !codex.signedIn) w.push("Codex CLI is installed but not signed in. Run `codex login` and choose \"Sign in with ChatGPT\", then run setup again to offer it.");
  return w;
}

export function findOnPath(bin: string, pathVar: string | undefined, exists: (p: string) => boolean = existsSync): string | null {
  for (const d of (pathVar ?? "").split(delimiter)) {
    if (!d) continue;
    const p = join(d, bin);
    if (exists(p)) return p;
  }
  return null;
}

export interface UnitInput {
  node: string;
  script: string;
  configPath: string;
  home: string;
  /** PATH the service gets (launchd/systemd start with a minimal one). */
  path: string;
  /** Extra CA bundle (macOS only; undefined = not set). */
  caCerts?: string;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sdQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;

export function servicePath(node: string, claudeBin: string | null, home: string, current?: string, codexBin: string | null = null): string {
  const parts = [dirname(node), ...(claudeBin ? [dirname(claudeBin)] : []), ...(codexBin ? [dirname(codexBin)] : []), join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  for (const d of (current ?? "").split(delimiter)) if (d) parts.push(d);
  return [...new Set(parts)].join(delimiter);
}

export function launchdPlist(u: UnitInput): string {
  const log = join(u.home, "Library", "Logs", "mergejudge-runner.log");
  const env = ([["PATH", u.path]] as [string, string][]).concat(u.caCerts ? [["NODE_EXTRA_CA_CERTS", u.caCerts]] : [])
    .map(([k, v]) => `    <key>${k}</key>\n    <string>${xml(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(u.node)}</string>
    <string>${xml(u.script)}</string>
    <string>run</string>
    <string>--config</string>
    <string>${xml(u.configPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ExitTimeOut</key>
  <integer>45</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(u: UnitInput): string {
  return `[Unit]
Description=MergeJudge runner (runs reviews with your own Claude Code / Codex login)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${sdQuote(u.node)} ${sdQuote(u.script)} run --config ${sdQuote(u.configPath)}
Environment=${sdQuote(`PATH=${u.path}`)}
UnsetEnvironment=ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY
Restart=always
RestartSec=30
TimeoutStopSec=45

[Install]
WantedBy=default.target
`;
}

export const unitPath = (platform: string, home: string): string | null =>
  platform === "darwin" ? join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
  : platform === "linux" ? join(home, ".config", "systemd", "user", SYSTEMD_UNIT) : null;

export interface AutostartDeps {
  platform: string;
  home: string;
  env: Record<string, string | undefined>;
  exec: ExecFn;
  node: string;
  configPath: string;
  claudeBin: string | null;
  codexBin?: string | null;
  uid?: number;
  fileExists?: (p: string) => boolean;
}

export function buildUnit(d: AutostartDeps): { path: string; text: string; script: string } | null {
  const path = unitPath(d.platform, d.home);
  if (!path) return null;
  const exists = d.fileExists ?? existsSync;
  // The service runs a stable copy of the bundle: an npx cache entry can be evicted at any time.
  const script = join(dirname(d.configPath), "runner.mjs");
  const input: UnitInput = {
    node: d.node, script, configPath: d.configPath, home: d.home, path: servicePath(d.node, d.claudeBin, d.home, d.env.PATH, d.codexBin ?? null),
    ...(d.platform === "darwin" && !d.env.NODE_EXTRA_CA_CERTS && exists(CA_BUNDLE) ? { caCerts: CA_BUNDLE } : {}),
  };
  return { path, script, text: d.platform === "darwin" ? launchdPlist(input) : systemdUnit(input) };
}

/** Copies the running bundle next to the config, writes the unit and starts it. Returns notes for the user. */
export function installAutostart(d: AutostartDeps, bundle: string): string[] {
  const unit = buildUnit(d);
  if (!unit) throw new Error(`auto-start is not supported on ${d.platform}`);
  if (!existsSync(bundle) || !/\.[mc]?js$/.test(bundle)) throw new Error(`runner bundle not found at ${bundle}; run from the published package`);
  mkdirSync(dirname(unit.script), { recursive: true, mode: 0o700 });
  copyFileSync(bundle, unit.script);
  chmodSync(unit.script, 0o700);
  mkdirSync(dirname(unit.path), { recursive: true });
  writeFileSync(unit.path, unit.text, { mode: 0o644 });
  const sh = (bin: string, args: string[]) => d.exec(bin, args, d.env);
  const notes: string[] = [];
  if (d.platform === "darwin") {
    mkdirSync(join(d.home, "Library", "Logs"), { recursive: true });
    const domain = `gui/${d.uid ?? process.getuid?.() ?? 501}`;
    sh("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
    const ok = sh("launchctl", ["bootstrap", domain, unit.path]).status === 0;
    notes.push(ok ? `Auto-start installed and running (${unit.path}).` : `Wrote ${unit.path} but launchctl failed; load it with: launchctl bootstrap ${domain} "${unit.path}"`);
    notes.push(`Stop/uninstall: launchctl bootout ${domain}/${LAUNCHD_LABEL} && rm "${unit.path}"`);
  } else {
    sh("systemctl", ["--user", "daemon-reload"]);
    const ok = sh("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]).status === 0;
    notes.push(ok ? `Auto-start installed and running (${unit.path}).` : `Wrote ${unit.path} but systemctl failed; start it with: systemctl --user enable --now ${SYSTEMD_UNIT}`);
    notes.push("To keep it running after you log out: loginctl enable-linger $USER");
    notes.push(`Stop/uninstall: systemctl --user disable --now ${SYSTEMD_UNIT} && rm "${unit.path}"`);
  }
  return notes;
}
