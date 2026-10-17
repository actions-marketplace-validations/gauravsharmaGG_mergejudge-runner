/** Thin /runner/v1 HTTP client. Never throws on an HTTP status; throws NetworkError when no response arrived. */
export class NetworkError extends Error {}

export interface ApiResponse {
  status: number;
  /** Parsed JSON body, or null (204 / not JSON). */
  body: Record<string, unknown> | null;
  headers: Headers;
  /** Retry-After in ms (capped), when the server sent one. */
  retryAfterMs: number | null;
}

export const MAX_RETRY_AFTER_MS = 5 * 60_000;

export function parseRetryAfter(v: string | null, now = Date.now()): number | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.min(n * 1000, MAX_RETRY_AFTER_MS);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.min(Math.max(0, d - now), MAX_RETRY_AFTER_MS) : null;
}

export interface RequestOpts { token?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number }

export function createApi(origin: string, version: string, fetchImpl: typeof fetch = fetch) {
  return async function request(method: "GET" | "POST", path: string, o: RequestOpts = {}): Promise<ApiResponse> {
    const signals = [AbortSignal.timeout(o.timeoutMs ?? 30_000), ...(o.signal ? [o.signal] : [])];
    let res: Response;
    try {
      res = await fetchImpl(`${origin}/runner/v1${path}`, {
        method,
        headers: {
          ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
          ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
          "user-agent": `mergejudge-runner/${version}`,
        },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: AbortSignal.any(signals),
        redirect: "error", // never forward the bearer token to another origin
      });
    } catch (e) {
      if (o.signal?.aborted) throw o.signal.reason ?? e;
      throw new NetworkError((e as Error).name === "TimeoutError" ? "request timed out" : `network error: ${(e as Error).message}`);
    }
    let body: Record<string, unknown> | null = null;
    if (res.status !== 204) {
      try {
        const t = await res.text();
        const v: unknown = t ? JSON.parse(t) : null;
        body = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
      } catch { body = null; }
    }
    return { status: res.status, body, headers: res.headers, retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) };
  };
}
export type Api = ReturnType<typeof createApi>;

export const errorCode = (r: ApiResponse): string => (typeof r.body?.error === "string" ? r.body.error : `http_${r.status}`);
