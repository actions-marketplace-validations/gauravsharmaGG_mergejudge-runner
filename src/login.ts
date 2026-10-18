/** `mergejudge-runner login`: sign in with GitHub (device flow) and get a registered runner, no enrollment code needed. */
import { errorCode, NetworkError, type Api, type ApiResponse } from "./api.js";
import { ConfigError } from "./config.js";
import type { DeviceInstallation, DevicePollRequest, DevicePollResponse, DeviceRegistered, DeviceStartResponse } from "../core/protocol.js";

export type DevicePollBody = Omit<DevicePollRequest, "session" | "installation_id">;

export interface DeviceLoginDeps {
  api: Api;
  out: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Interactive pick among several installations (index into the list); absent = not interactive. */
  choose?: (installations: DeviceInstallation[]) => Promise<number>;
  now?: () => number;
}

const MAX_429_RETRIES = 5;
const MAX_NET_RETRIES = 3;
const clampS = (n: unknown, d: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(60, Math.max(1, n)) : d);
/** Strips control characters before text from the server reaches the terminal. */
const plain = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, "");

const FORBIDDEN: Record<string, string> = {
  installation_forbidden: "your GitHub account may not add a runner to that installation",
  not_admin: "only an owner or admin of the GitHub account or organisation can add a runner",
  runner_limit: "this installation has reached its limit of runners; remove one in the MergeJudge panel first",
  installation_gone: "that installation no longer exists; reinstall the MergeJudge GitHub App",
  installation_suspended: "that installation is suspended on GitHub; unsuspend the MergeJudge GitHub App first",
};

/** One request; waits and retries on 429 (Retry-After), and optionally on transient network errors. */
async function call(d: DeviceLoginDeps, path: string, body: unknown, netRetries: number): Promise<ApiResponse> {
  let rl = 0, net = 0;
  for (;;) {
    let r: ApiResponse;
    try { r = await d.api("POST", path, { body }); } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
      if (++net > netRetries) throw new Error(`could not reach the server: ${e.message}`);
      await d.sleep(2000 * net);
      continue;
    }
    if (r.status !== 429) return r;
    if (++rl > MAX_429_RETRIES) throw new Error("rate limited by the server; try again in a few minutes");
    await d.sleep(Math.max(1000, r.retryAfterMs ?? 10_000));
  }
}

function failure(r: ApiResponse): Error {
  const code = errorCode(r);
  if (r.status === 503 || code === "device_flow_unavailable") return new Error("sign-in with GitHub is not available on this server; create an enrollment code in the panel and run `mergejudge-runner setup <code>`");
  if (r.status === 403 && FORBIDDEN[code]) return new Error(FORBIDDEN[code]!);
  if (r.status === 404 && code === "unknown_session") return new Error("the sign-in attempt is no longer valid; run the command again");
  return new Error(`sign-in failed (HTTP ${r.status}: ${plain(code)})`);
}

export async function deviceLogin(d: DeviceLoginDeps, caps: DevicePollBody, name: string, installationId?: number): Promise<DeviceRegistered> {
  const now = d.now ?? Date.now;
  const start = await call(d, "/device/start", {}, MAX_NET_RETRIES);
  const s = start.body as Partial<DeviceStartResponse> | null;
  if (start.status !== 200 || !s || typeof s.session !== "string" || typeof s.user_code !== "string" || typeof s.verification_uri !== "string") throw failure(start);
  if (!/^[A-Za-z0-9-]{4,20}$/.test(s.user_code)) throw new Error("the server sent an unexpected sign-in code");
  let vu: URL;
  try { vu = new URL(s.verification_uri); } catch { throw new Error("the server sent an unexpected sign-in address"); }
  if (vu.protocol !== "https:") throw new Error("the server sent an unexpected sign-in address");
  const session = s.session; // a secret: only ever sent back to /device/poll
  let interval = clampS(s.interval, 5);
  const deadline = now() + (typeof s.expires_in === "number" && s.expires_in > 0 ? Math.min(s.expires_in, 900) : 900) * 1000;

  d.out(`To sign in, open ${vu.href} and enter the code ${s.user_code}`);
  d.out("Then approve the MergeJudge GitHub App. Waiting for you to finish (Ctrl+C to cancel)...");

  let chosen = installationId;
  for (;;) {
    await d.sleep(interval * 1000);
    if (now() > deadline) throw new Error("the sign-in code expired; run the command again");
    const r = await call(d, "/device/poll", { session, name, ...(chosen !== undefined ? { installation_id: chosen } : {}), ...caps } satisfies DevicePollRequest, MAX_NET_RETRIES);
    const p = r.body as DevicePollResponse | null;
    if ((r.status !== 200 && r.status !== 201) || !p || typeof p.state !== "string") throw failure(r);
    switch (p.state) {
      case "pending": interval = clampS(p.interval, interval); break;
      case "slow_down": interval = clampS(p.interval, interval + 5); break;
      case "expired": throw new Error("the sign-in code expired; run the command again");
      case "denied": throw new Error("sign-in was cancelled on GitHub; nothing was registered");
      case "no_installation":
        d.out("Signed in, but the MergeJudge GitHub App is not installed on any of your accounts.");
        if (typeof p.install_url === "string" && /^https:\/\//.test(p.install_url)) d.out(`Install it here, then run this command again: ${plain(p.install_url)}`);
        throw new Error("no MergeJudge GitHub App installation found");
      case "choose_installation": {
        const list = (Array.isArray(p.installations) ? p.installations : []).filter((i) => i && Number.isInteger(i.id) && typeof i.account === "string");
        if (!list.length) throw failure(r);
        if (!d.choose) {
          d.out("Several installations are available:");
          for (const i of list) d.out(`  ${i.id}  ${plain(i.account)}`);
          throw new ConfigError("pass --installation <id> to choose one (run `mergejudge-runner login --installation <id>`)");
        }
        d.out("Which installation should this runner serve?");
        list.forEach((i, n) => d.out(`  ${n + 1}) ${plain(i.account)} (${i.id})`));
        chosen = list[await d.choose(list)]!.id;
        interval = 0; // the sign-in is already approved: poll again right away
        break;
      }
      case "registered": {
        if (typeof p.accessToken !== "string" || typeof p.runnerId !== "string") throw failure(r);
        return p;
      }
      default: throw new Error("unexpected answer from the server; update mergejudge-runner and try again");
    }
  }
}
