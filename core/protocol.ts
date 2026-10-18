// Runner protocol (/runner/v1) job payload types: the shape of the jobs a runner leases from the Worker.
import type { Config } from "./config.js";
import type { ContextPiece } from "./context.js";
import type { Want } from "./engines.js";
import type { FileVerdict, Lane, PrFile } from "./types.js";

export const PAYLOAD_VERSION = 1;
/** Payload v2 = `codeSource: "local"`: SHAs, PR metadata, config and the rules result only. The runner reads the code from its own git clone. */
export const LOCAL_PAYLOAD_VERSION = 2;

/** What a runner receives. Built field by field: only data a reviewer needs, never credentials. */
export interface RunnerJobPayload {
  v: typeof PAYLOAD_VERSION;
  repo: { owner: string; repo: string };
  pr: {
    number: number; title: string; body: string; author: string | null;
    authorType?: string | null;
    labels: string[]; node_id: string;
    head: { sha: string; ref: string | null }; base: { sha: string | null; ref: string | null };
  };
  mode: "diff" | "context" | "deep";
  /** Config read from the BASE commit (provider.base_url / api_key_env removed: the runner picks its own engine). */
  cfg: Config;
  cfgRef: string;
  /** Files with patches. Paths in `rules.stripped` (diff_exclude, over the size cap) have no patch. */
  files: PrFile[];
  /** Policy files at cfgRef (raw, capped) plus what loadPolicies makes of them. */
  policyFiles: Record<string, string>;
  policy: { text: string; used: { path: string; truncated: boolean }[]; skipped?: string[] };
  /** Context-mode pieces gathered by the Worker (absent for diff mode; deep uses the runner's checkout). */
  context?: ContextPiece[];
  /**
   * Deep mode only: `ok` = `context` was retrieved from a repo index the Worker built (single pass on the runner, no tool loop);
   * otherwise `context` is plain context-mode pieces and `notes` says why. A deep job without this field is from an older Worker.
   */
  deep?: { ok: boolean; notes: string[] };
  /**
   * Team-preferences lines (known false alarms, writer notes, outcome hints): already defanged and capped. The runner re-sanitises
   * them and puts them in its prompt as data. Absent = nothing learned, or an older Worker. Older runners ignore it.
   */
  learnedLines?: string[];
  /** Engine/model this repo asks for (panel setting, else .mergejudge.yml runner.*). Absent keys = the runner's own default. 0.1.0 runners ignore it. */
  want?: Want;
  /** Deterministic result (rules + labels, no LLM) computed by the Worker with full patches: the floor a runner can only raise. */
  rules: { lane: Lane; files: FileVerdict[]; labelReasons: string[]; stripped: string[] };
}

/**
 * What a runner with `code_source: local` receives (deep mode). Same fields the Worker needs back (files for the finding filter,
 * policy.used, rules), but no patch, no policy text, no context pieces: nothing from the repo's contents. Runners older than
 * 0.4.0 never get this (the job has mode `deep-local`, which only runners announcing the `local-code` feature lease).
 */
export type LocalJobPayload = Omit<RunnerJobPayload, "v" | "context" | "deep"> & { v: typeof LOCAL_PAYLOAD_VERSION; codeSource: "local" };

// ---- Device sign-in (`mergejudge-runner login`): POST /runner/v1/device/start and /runner/v1/device/poll ----

/** Response of POST /runner/v1/device/start (request body: `{}`). */
export interface DeviceStartResponse {
  /** Opaque handle for this sign-in attempt. A secret: send it only to /device/poll, never print or log it. */
  session: string;
  /** Code the user types at `verification_uri`. */
  user_code: string;
  verification_uri: string;
  /** Minimum seconds between polls. */
  interval: number;
  /** Seconds until the sign-in attempt expires. */
  expires_in: number;
}

/** A GitHub App installation the signed-in user may add a runner to. */
export interface DeviceInstallation { id: number; account: string }

/** Body of POST /runner/v1/device/poll: the session plus the same capability fields as /runner/v1/register. */
export interface DevicePollRequest {
  session: string;
  name?: string;
  /** Pick this installation (needed after `choose_installation`, or to skip the choice). */
  installation_id?: number;
  engines: string[];
  capabilities: unknown[];
  modes: string[];
  limits?: unknown;
  concurrency: number;
  version: string;
  features: string[];
  labels: string[];
}

/** Same fields as the /runner/v1/register response (HTTP 200 or 201). */
export interface DeviceRegistered {
  state: "registered";
  protocol: "v1";
  runnerId: string;
  installationId: number;
  accessToken: string;
  expiresAt: string;
}

/** Response of POST /runner/v1/device/poll, discriminated by `state`. */
export type DevicePollResponse =
  | { state: "pending"; interval: number }
  | { state: "slow_down"; interval: number }
  | { state: "expired" }
  | { state: "denied" }
  | { state: "choose_installation"; installations: DeviceInstallation[] }
  | { state: "no_installation"; install_url: string }
  | DeviceRegistered;

/** `error` values of the non-2xx answers of the device endpoints (429 also carries Retry-After). */
export type DeviceErrorCode =
  | "installation_forbidden" | "not_admin" | "runner_limit" | "installation_gone" | "installation_suspended" // 403
  | "unknown_session" // 404
  | "rate_limited" // 429
  | "device_flow_unavailable"; // 503
