/** Engine detection shared by setup, login, register, run and status: is each engine installed, signed in, or missing? */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkCli, CODEX_API_KEY_REASON, findOnPath, type CliCheck, type ExecFn } from "./setup.js";

export type EngineState = "ready" | "not-signed-in" | "not-found";

export interface EngineReport {
  engine: "claude-code" | "codex" | "glm";
  state: EngineState;
  /** Why an installed engine is not ready. */
  reason?: string;
  /** Where the binary was found when that is not on PATH (or was given with --claude-bin / --codex-bin: not set then). */
  foundAt?: string;
  /** Binary to probe and to store in the config; null for glm. */
  bin: string | null;
}

export interface DetectDeps {
  env: Record<string, string | undefined>;
  home: string;
  exec: ExecFn;
  fileExists?: (p: string) => boolean;
  claudeBin?: string | null;
  codexBin?: string | null;
  /** Engines not to probe (already configured: run and status only look for ones that are missing from the config). */
  skip?: string[];
}

/** Directories searched when a binary is not on PATH, in order. */
export function commonBinDirs(bin: string, env: Record<string, string | undefined>, home: string): string[] {
  const dirs: string[] = [];
  if (env.npm_config_prefix) dirs.push(join(env.npm_config_prefix, "bin"));
  if (bin === "codex" && env.CODEX_INSTALL_DIR) dirs.push(env.CODEX_INSTALL_DIR);
  dirs.push(join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin");
  return dirs;
}

/** PATH first, then the common install directories. `offPath` is true when only the latter found it. */
export function locateBin(bin: string, env: Record<string, string | undefined>, home: string, exists: (p: string) => boolean = existsSync): { path: string | null; offPath: boolean } {
  const onPath = findOnPath(bin, env.PATH, exists);
  if (onPath) return { path: onPath, offPath: false };
  for (const d of commonBinDirs(bin, env, home)) {
    const p = join(d, bin);
    if (exists(p)) return { path: p, offPath: true };
  }
  return { path: null, offPath: false };
}

function reportOf(engine: "claude-code" | "codex", c: CliCheck, bin: string | null, foundAt: string | undefined): EngineReport {
  if (!c.installed) return { engine, state: "not-found", bin: null };
  const base = { engine, bin, ...(foundAt ? { foundAt } : {}) };
  if (c.signedIn) return { ...base, state: "ready" };
  const reason = engine === "codex" ? (c.apiKeyLogin ? CODEX_API_KEY_REASON : "Codex is not signed in with ChatGPT") : "`claude auth status` does not report a sign-in";
  return { ...base, state: "not-signed-in", reason };
}

/** Probes claude and codex (`--version`, then the login status). Never throws. */
export function detectClis(d: DetectDeps): EngineReport[] {
  const exists = d.fileExists ?? existsSync;
  const one = (engine: "claude-code" | "codex", name: "claude" | "codex", given: string | null | undefined): EngineReport => {
    const loc = given ? { path: given, offPath: false } : locateBin(name, d.env, d.home, exists);
    const c = checkCli(name, loc.path ?? name, d.env, d.exec);
    return reportOf(engine, c, loc.path, loc.offPath ? loc.path ?? undefined : undefined);
  };
  const skip = new Set(d.skip ?? []);
  return [...(skip.has("claude-code") ? [] : [one("claude-code", "claude", d.claudeBin)]), ...(skip.has("codex") ? [] : [one("codex", "codex", d.codexBin)])];
}

export function glmReport(hasKey: boolean): EngineReport {
  return { engine: "glm", state: hasKey ? "ready" : "not-found", bin: null };
}

const tilde = (p: string, home: string) => (home && p.startsWith(home + "/") ? `~${p.slice(home.length)}` : p);

/** One status line per engine. */
export function engineLine(r: EngineReport, home: string): string {
  if (r.engine === "glm") return r.state === "ready" ? "glm: ready (your z.ai API key; z.ai bills you per use)" : "glm: no API key (optional; z.ai bills per use)";
  const where = r.foundAt ? ` (found at ${tilde(r.foundAt, home)}, which is not on PATH)` : "";
  if (r.state === "ready") return `${r.engine}: ready${where}`;
  if (r.state === "not-signed-in") return `${r.engine}: installed, not signed in${where} (${r.reason})`;
  return `${r.engine}: not found`;
}

/** The one-line install or sign-in hint for an engine that is not ready, or null. */
export function engineHint(r: EngineReport): string | null {
  if (r.state === "ready") return null;
  if (r.engine === "glm") return "To add it, pass --glm-key-env NAME (an environment variable holding your z.ai key) or answer y to the GLM question.";
  if (r.engine === "claude-code") {
    return r.state === "not-found"
      ? "Install Claude Code (see https://code.claude.com/docs/en/quickstart), then run `claude` once and sign in with your own subscription."
      : "Run `claude` and sign in with your own subscription (or `claude setup-token`), then run setup again.";
  }
  return r.state === "not-found"
    ? "Install Codex with `npm install -g @openai/codex` (or `brew install --cask codex`, or `curl -fsSL https://chatgpt.com/codex/install.sh | sh`), then run `codex login` and choose \"Sign in with ChatGPT\". After the installer you may need a new terminal."
    : "Run `codex login` and choose \"Sign in with ChatGPT\", then run setup again.";
}

export const NO_ENGINE_MESSAGE = "No engine is ready yet. The runner will be registered with claude-code as the default, but it cannot run reviews until one engine is installed and signed in.";

/** Lines for the engines (all three, or only the ones not ready), each followed by its hint when not ready. */
export function engineLines(reports: EngineReport[], home: string, onlyNotReady = false): string[] {
  const lines: string[] = [];
  for (const r of reports) {
    if (onlyNotReady && r.state === "ready") continue;
    lines.push(engineLine(r, home));
    const h = engineHint(r);
    if (h) lines.push(`  ${h}`);
  }
  return lines;
}

export const readyEngines = (reports: EngineReport[]): string[] => reports.filter((r) => r.state === "ready").map((r) => r.engine);

/** Notes for engines that are ready on this machine but missing from the runner's config. Never changes the config. */
export function unlistedEngineNotes(configured: string[], reports: EngineReport[]): string[] {
  return reports
    .filter((r) => r.state === "ready" && r.engine !== "glm" && !configured.includes(r.engine))
    .map((r) => `${r.engine === "claude-code" ? "claude" : r.engine} is ready but not in this runner's config; run \`mergejudge-runner setup --force\` to add it`);
}
