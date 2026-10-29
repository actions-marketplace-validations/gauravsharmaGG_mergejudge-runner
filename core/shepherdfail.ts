import { createHash } from "node:crypto";
import { RULE, RULE_QUESTION, effectiveCap, type RuleId } from "./shepherdrules.js";

// ---------------- error fingerprint ----------------

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const TS_PREFIX = /^\s*(?:\d{4}-\d\d-\d\dT[\d:.]+Z\s*)?(?:\[?\d\d:\d\d:\d\d(?:\.\d+)?\]?\s*)?/;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

/** Normalise one failure line so the same failure reads the same across runs: no ANSI, timestamps, line:col, durations, hashes, paths or numbers. */
export function normalizeError(line: string): string {
  return stripAnsi(line)
    .replace(TS_PREFIX, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/(?<![\w.])(?:[A-Za-z]:)?(?:[\\/][\w.@+~-]+){2,}[\\/]?/g, "<path>")
    .replace(/(?<=[\w>)]):\d+(?::\d+)?/g, "")
    .replace(/\(\d+,\d+\)/g, "")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds|min|m)\b/gi, "<t>")
    .replace(/\b(?:0x)?[0-9a-f]{7,64}\b/gi, "<hex>")
    .replace(/\b\d+(?:\.\d+)*\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

const FAILURE_PATTERNS: RegExp[] = [
  /^\s*(?:FAIL|FAILED)\b/,
  /^FAILED\s/,
  /--- FAIL/,
  /[✗✕×]\s/,
  /^\s*✕/,
  /\bAssertionError\b/,
  /\berror TS\d+/,
  /^\s*\d+:\d+\s+error\s/,
  /\b(?:[A-Za-z]*Error|Exception):\s/,
  /^\s*E\s{3}\S/,
  /\berror\b\s*[:\[]/i,
];
const NOISE = /^##\[(?:error|group|endgroup|warning)\]\s*(?:Process completed with exit code \d+\.?)?\s*$|^Process completed with exit code|^npm (?:ERR!|error) (?:A complete log|code ELIFECYCLE|errno|path|command failed)/i;

const cleanLine = (l: string) => stripAnsi(l).replace(TS_PREFIX, "").trimEnd();

const BARE_HEADER = /^\s*(?:FAIL|FAILED)\s+\S+\s*$/;

/**
 * The first line that looks like a failing test or lint message, else the last non-empty lines. A bare `FAIL <file>` header
 * says only which file failed, so the next specific failure line is appended to tell two failures in one file apart.
 */
export function firstFailureLine(log: string): string {
  const lines = log.split(/\r?\n/).map(cleanLine);
  const hits = lines.filter((l) => l.trim() && !NOISE.test(l.trim()) && FAILURE_PATTERNS.some((re) => re.test(l)));
  if (hits.length) {
    const head = hits[0]!.trim();
    if (!BARE_HEADER.test(head)) return head;
    const detail = hits.slice(1).find((l) => !BARE_HEADER.test(l));
    return detail ? `${head} | ${detail.trim()}` : head;
  }
  const tail = lines.filter((l) => l.trim() && !NOISE.test(l.trim())).slice(-3).map((l) => l.trim());
  return tail.join(" | ");
}

/** Failing-test count when the log says so (jest, vitest, pytest, mocha, go), else null. */
export function countFailingTests(log: string): number | null {
  const t = stripAnsi(log);
  for (const re of [/Tests?:?\s+(\d+) failed/i, /=+\s*(\d+) failed/i, /\b(\d+) failing\b/i, /\b(\d+) tests? failed\b/i]) {
    const m = re.exec(t);
    if (m) return Number(m[1]);
  }
  const go = t.match(/^\s*--- FAIL:/gm);
  return go ? go.length : null;
}

export interface Fingerprint {
  job: string;
  /** Short stable hash of job name + normalised first failure line (goes in the commit trailer). */
  hash: string;
  /** Normalised first failure line. */
  line: string;
  /** The first failure line as it appeared (still to be redacted before showing). */
  raw: string;
  tests: number | null;
}

export function fingerprintFailure(job: string, log: string): Fingerprint {
  const raw = firstFailureLine(log);
  const line = normalizeError(raw);
  return { job, hash: createHash("sha1").update(`${job}\n${line}`).digest("hex").slice(0, 10), line, raw, tests: countFailingTests(log) };
}

/** Failing jobs plus failing tests where the log reports them. Compared before and after each attempt (L4). */
export function failureCount(fps: Pick<Fingerprint, "tests">[]): number {
  return fps.reduce((n, f) => n + 1 + (f.tests && f.tests > 0 ? f.tests : 0), 0);
}

/** Last `lines` lines, at most `maxChars` characters (the end of the log is what failed). */
export function tailLog(log: string, lines = 200, maxChars = 20_000): string {
  const t = stripAnsi(log).split(/\r?\n/).slice(-lines).join("\n");
  return t.length > maxChars ? t.slice(t.length - maxChars) : t;
}

// ---------------- file references in logs ----------------

const FILE_REF = /(?<![\w./-])((?:\.{0,2}\/)?(?:[\w@.+-]+\/)*[\w@.+-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|hpp|ya?ml|json|toml|sh|md|css|scss|vue|svelte))(?![\w])/g;

/** Repo-relative file paths a log mentions (workspace prefix and line:col removed). */
export function referencedFiles(log: string, workspace?: string): string[] {
  const out = new Set<string>();
  let text = stripAnsi(log);
  if (workspace) text = text.split(workspace.replace(/\/$/, "") + "/").join("");
  text = text.replace(/\/home\/runner\/work\/[^/\s]+\/[^/\s]+\//g, "");
  for (const m of text.matchAll(FILE_REF)) {
    const p = m[1]!.replace(/^\.\//, "");
    if (p.startsWith("/") || p.startsWith("..") || p.includes("node_modules/")) continue;
    out.add(p);
    if (out.size >= 40) break;
  }
  return [...out];
}

// ---------------- can't-fix classes ----------------

export interface FailedJob { name: string; conclusion: string | null }
export type FailureClass = { kind: "code" } | { kind: "cant-fix"; reason: string; rule: typeof RULE.H1 | typeof RULE.H3 };

const SECRETS: RegExp[] = [
  /Resource not accessible by integration/i,
  /\bsecrets?\b[^\n]{0,60}\b(?:not set|is not set|missing|is missing|is empty|undefined|not found)\b/i,
  /Input required and not supplied/i,
  /Permission denied \(publickey\)/i,
  /Bad credentials/i,
  /could not read (?:Username|Password) for/i,
  /npm (?:ERR!|error) code E40[13]\b/i,
  /\b40[13]\b[^\n]{0,20}(?:Unauthorized|Forbidden)[^\n]{0,200}(?:registry|npm|pypi|ghcr|docker|crates)/i,
  /(?:registry|npmjs|pypi|ghcr\.io|docker\.io|crates)[^\n]{0,160}\b40[13]\b/i,
];
const INFRA: RegExp[] = [
  /The runner has received a shutdown signal/i,
  /lost communication with the server/i,
  /No space left on device/i,
  /exceeded the maximum execution time/i,
  /The hosted runner encountered an error/i,
  /The operation was canceled/i,
];
const REGISTRY: RegExp[] = [
  /npm (?:ERR!|error) code (?:ETIMEDOUT|ECONNRESET|EAI_AGAIN|ECONNREFUSED|E5\d\d)\b/i,
  /\b5\d\d\b[^\n]{0,30}(?:Service Unavailable|Bad Gateway|Gateway Time-?out)[^\n]{0,200}(?:registry|npmjs|pypi|pythonhosted|crates|golang)/i,
  /(?:registry\.npmjs\.org|pypi\.org|files\.pythonhosted\.org|proxy\.golang\.org|crates\.io)[^\n]{0,200}(?:503|502|504|ETIMEDOUT|ECONNRESET|timed out|Service Unavailable)/i,
  /\b503 Service Unavailable\b/i,
];
const NOT_CODE_CONCLUSIONS = new Set(["timed_out", "cancelled", "startup_failure"]);

/**
 * Is this failure something a code change can fix? Pure over the failed jobs and their logs (keyed by job name).
 * All failing jobs must be unfixable for the result to be cant-fix; one code failure is enough to try a fix.
 * `isProtected` lets "the only files involved are protected" (e.g. the workflow file itself is invalid) count as H1.
 */
export function classifyFailure(jobs: FailedJob[], logs: Record<string, string>, isProtected?: (path: string) => boolean): FailureClass {
  if (!jobs.length) return { kind: "cant-fix", reason: "no failed job was found for the run", rule: RULE.H3 };
  let first: FailureClass | null = null;
  for (const j of jobs) {
    const log = logs[j.name] ?? "";
    let verdict: FailureClass = { kind: "code" };
    if (j.conclusion && NOT_CODE_CONCLUSIONS.has(j.conclusion)) verdict = { kind: "cant-fix", reason: `job \`${j.name}\` ${j.conclusion.replace("_", " ")} (runner or infrastructure)`, rule: RULE.H3 };
    else if (SECRETS.some((re) => re.test(log))) verdict = { kind: "cant-fix", reason: `job \`${j.name}\` failed on missing secrets, permissions or credentials`, rule: RULE.H3 };
    else if (INFRA.some((re) => re.test(log))) verdict = { kind: "cant-fix", reason: `job \`${j.name}\` hit a runner or infrastructure error`, rule: RULE.H3 };
    else if (REGISTRY.some((re) => re.test(log))) verdict = { kind: "cant-fix", reason: `job \`${j.name}\` could not reach a package registry (outage or network)`, rule: RULE.H3 };
    else if (isProtected) {
      const refs = referencedFiles(log);
      if (/Invalid workflow file/i.test(log) || (refs.length > 0 && refs.every(isProtected)))
        verdict = { kind: "cant-fix", reason: `job \`${j.name}\` only involves protected files (${refs.filter(isProtected).slice(0, 3).join(", ") || "the workflow file"})`, rule: RULE.H1 };
    }
    if (verdict.kind === "code") return verdict;
    first ??= verdict;
  }
  return first!;
}

// ---------------- commit trailers and attempt history ----------------

export const TRAILER_ATTEMPT = "MergeJudge-Shepherd";
export const TRAILER_FINGERPRINT = "MergeJudge-Shepherd-Fingerprint";
export const TRAILER_FAILURES = "MergeJudge-Shepherd-Failures";
export const TRAILER_KIND = "MergeJudge-Shepherd-Kind";
export const ACTOR_TRAILER = "MergeJudge-Actor: agent";

export interface AttemptRecord {
  sha: string;
  attempt: number;
  kind: "ci" | "conflict";
  /** Fingerprints of the failures this attempt set out to fix. */
  fingerprints: string[];
  /** Failure count before the attempt (L4). */
  failures: number | null;
}

export function parseAttemptCommit(sha: string, message: string): AttemptRecord | null {
  const m = /^MergeJudge-Shepherd:\s*attempt\s+(\d+)\s*$/m.exec(message);
  if (!m) return null;
  const fps = [...message.matchAll(/^MergeJudge-Shepherd-Fingerprint:\s*([0-9a-f]{6,16})\s*$/gim)].map((x) => x[1]!.toLowerCase());
  const f = /^MergeJudge-Shepherd-Failures:\s*(\d+)\s*$/m.exec(message);
  const kind = /^MergeJudge-Shepherd-Kind:\s*conflict\s*$/m.test(message) ? "conflict" : "ci";
  return { sha, attempt: Number(m[1]), kind, fingerprints: fps, failures: f ? Number(f[1]) : null };
}

export const isShepherdCommitMessage = (message: string | null | undefined): boolean => /^MergeJudge-Shepherd:\s*attempt\s+\d+\s*$/m.test(message ?? "");

export interface ShepherdHistory {
  /** Shepherd's own fix commits on the PR, oldest first. The count is authoritative for L1. */
  records: AttemptRecord[];
  attempts: number;
  latest: AttemptRecord | null;
}

/** Build the history from the PR's commits (pulls.listCommits order: oldest first). */
export function shepherdHistory(commits: { sha: string; message: string }[]): ShepherdHistory {
  const records = commits.map((c) => parseAttemptCommit(c.sha, c.message)).filter((r): r is AttemptRecord => !!r);
  return { records, attempts: records.length, latest: records[records.length - 1] ?? null };
}

export function buildCommitMessage(o: { subject: string; attempt: number; kind: "ci" | "conflict"; fingerprints?: string[]; failures?: number | null }): string {
  const lines = [o.subject.replace(/\s+/g, " ").slice(0, 100), "", `${TRAILER_ATTEMPT}: attempt ${o.attempt}`];
  if (o.kind === "conflict") lines.push(`${TRAILER_KIND}: conflict`);
  for (const f of o.fingerprints ?? []) lines.push(`${TRAILER_FINGERPRINT}: ${f}`);
  if (o.failures != null) lines.push(`${TRAILER_FAILURES}: ${o.failures}`);
  lines.push(ACTOR_TRAILER);
  return lines.join("\n") + "\n";
}

// ---------------- decision ----------------

export type Decision =
  | { action: "skip"; reason: string }
  | { action: "green" }
  | { action: "rerun"; reason: string }
  | { action: "handoff"; rule: RuleId; reason: string; question: string }
  | { action: "fix"; attempt: number };

export interface DecideInput {
  /** `needs-human` label present: Shepherd does nothing until a human clears it. */
  needsHuman: boolean;
  /** Shepherd is on for the PR (label) and the repo allows it. */
  on: boolean;
  maxAttempts: number;
  /** Attempts granted with `/mergejudge shepherd retry`; the cap is `maxAttempts + grants`. */
  grants?: number;
  history: ShepherdHistory;
  /** Head sha the workflow run was for (already checked to equal the PR head). */
  headSha: string;
  runAttempt: number;
  conclusion: string;
  failures: Fingerprint[];
  cantFix: FailureClass;
  /** Shepherd's own log shows it re-ran this run's failed jobs to rule out a flaky test. */
  rerunRequested: boolean;
  /** Fingerprints the Shepherd comment recorded (mirror of the trailers); only widens the L3 set, commits stay authoritative. */
  stateFingerprints?: string[];
}

const hand = (rule: RuleId, reason: string): Decision => ({ action: "handoff", rule, reason, question: RULE_QUESTION[rule] });

/**
 * Map a finished workflow run to one action. Order matters: needs-human and off first; then not-a-code-problem (H3);
 * then loop detection against Shepherd's own earlier commits (L2, L3); then the flaky re-run (H3); then L4 and the
 * retry budget (L1); only then a fix.
 */
export function decide(i: DecideInput): Decision {
  if (i.needsHuman) return { action: "skip", reason: "needs-human is set; waiting for a human" };
  if (!i.on) return { action: "skip", reason: "Shepherd is off for this PR" };
  if (i.conclusion === "success") {
    if (i.runAttempt > 1 && i.rerunRequested)
      return hand(RULE.H3, "not a code problem: flaky test (passed on rerun with no change)");
    return { action: "green" };
  }
  if (i.cantFix.kind === "cant-fix") return hand(i.cantFix.rule, `not a code problem: ${i.cantFix.reason}`);

  const cap = effectiveCap(i.maxAttempts, i.grants);
  const latest = i.history.latest;
  const postFix = !!latest && latest.sha === i.headSha;
  const known = new Set([...i.history.records.flatMap((r) => r.fingerprints), ...(i.stateFingerprints ?? [])]);
  const current = i.failures.map((f) => f.hash);
  if (postFix && latest) {
    const same = current.filter((h) => latest.fingerprints.includes(h));
    if (same.length) return hand(RULE.L2, `the fix left the same failure in place (fingerprint ${same[0]})`);
    const back = current.filter((h) => known.has(h));
    if (back.length) return hand(RULE.L3, `the fix brought back an earlier failure (fingerprint ${back[0]}) seen in an earlier attempt`);
  }
  if (i.runAttempt === 1 && !i.rerunRequested && current.some((h) => !known.has(h)) && i.history.attempts < cap)
    return { action: "rerun", reason: "re-running failed jobs to rule out a flaky test" };
  if (postFix && latest?.failures != null) {
    const now = failureCount(i.failures);
    if (now >= latest.failures) return hand(RULE.L4, `the fix did not reduce the failures (${latest.failures} before, ${now} now)`);
  }
  if (i.history.attempts >= cap) return hand(RULE.L1, `all ${cap} fix attempts are used (${i.history.attempts}/${cap})`);
  return { action: "fix", attempt: i.history.attempts + 1 };
}

/** All check runs on the head passed and the lane check is not failing. Pending or missing checks are not green. */
export function isGreen(checkRuns: { name: string; status: string; conclusion: string | null }[], laneCheckName: string): boolean {
  const others = checkRuns.filter((c) => c.name !== laneCheckName);
  const lane = checkRuns.find((c) => c.name === laneCheckName);
  if (lane?.status === "completed" && lane.conclusion === "failure") return false;
  return others.length > 0 && others.every((c) => c.status === "completed" && ["success", "skipped", "neutral"].includes(c.conclusion ?? ""));
}
