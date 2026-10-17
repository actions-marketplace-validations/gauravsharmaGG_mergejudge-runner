/**
 * Log hygiene. The runner logs ids, repo/PR numbers, durations and sizes only; this is the safety net for anything
 * that slips through (error messages, URLs, thrown library text): token shapes and known secrets are masked.
 */
const PATTERNS: RegExp[] = [
  /mjr_[ea]_[A-Za-z0-9_-]{6,}/g, // MergeJudge runner / enrollment tokens
  /sk-ant-[A-Za-z0-9_-]{6,}/g, // Anthropic keys and OAuth tokens
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(ANTHROPIC_[A-Z_]+|MERGEJUDGE_[A-Z_]*(?:TOKEN|KEY|SECRET)[A-Z_]*|CLAUDE_CODE_OAUTH_TOKEN)=\S+/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, // OpenAI-style keys
  /\b[0-9a-f]{32}\.[A-Za-z0-9]{8,}\b/g, // z.ai API keys (<32 hex>.<secret>)
  /\b(ZAI_[A-Z_]*|OPENAI_[A-Z_]*|CODEX_[A-Z_]*(?:KEY|TOKEN)[A-Z_]*)=\S+/g,
];

export const REDACTED = "[redacted]";

/** Masks token-shaped strings plus every literal in `secrets` (ignored when shorter than 6 chars). */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join(REDACTED);
  for (const re of PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/** What `status` shows of a token: the first characters only. */
export const tokenPrefix = (t: string): string => (t ? `${t.slice(0, 10)}…` : "(none)");

export type LogFields = Record<string, string | number | boolean | null | undefined>;
export interface Logger {
  info(msg: string, f?: LogFields): void;
  warn(msg: string, f?: LogFields): void;
  error(msg: string, f?: LogFields): void;
}

export function createLogger(write: (line: string) => void, secrets: () => readonly string[] = () => [], now: () => Date = () => new Date()): Logger {
  const emit = (level: string, msg: string, f?: LogFields) => {
    const kv = f ? Object.entries(f).filter(([, v]) => v !== undefined).map(([k, v]) => ` ${k}=${typeof v === "string" && /[\s"]/.test(v) ? JSON.stringify(v) : String(v)}`).join("") : "";
    write(redact(`${now().toISOString()} ${level} ${msg}${kv}`, secrets()));
  };
  return { info: (m, f) => emit("INFO", m, f), warn: (m, f) => emit("WARN", m, f), error: (m, f) => emit("ERROR", m, f) };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
