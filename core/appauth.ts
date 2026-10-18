// Vendored from the MergeJudge core. Keep in sync.
import { createSign } from "node:crypto";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** RS256 JWT for a GitHub App (iat backdated 60s, 9 min expiry). */
export function appJwt(appId: string, privateKeyPem: string, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(normalizePem(privateKeyPem));
  return `${header}.${payload}.${b64url(sig)}`;
}

/** Accept keys pasted with literal "\\n" sequences (common in secrets). */
export function normalizePem(k: string): string {
  return k.includes("\\n") && !k.includes("\n") ? k.replace(/\\n/g, "\n") : k;
}

/** DER length prefix. */
function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) { out.unshift(n & 0xff); n >>= 8; }
  return [0x80 | out.length, ...out];
}

/** PEM (PKCS#1 "RSA PRIVATE KEY" or PKCS#8 "PRIVATE KEY") to PKCS#8 DER bytes for WebCrypto. */
export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const k = normalizePem(pem);
  const b64 = k.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (!k.includes("BEGIN RSA PRIVATE KEY")) return der as Uint8Array<ArrayBuffer>;
  // Wrap PKCS#1 in PKCS#8: SEQ { INT 0, SEQ { OID rsaEncryption, NULL }, OCTET STRING { pkcs1 } }
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLen(der.length), ...der];
  const body = [0x02, 0x01, 0x00, ...algo, ...octet];
  return new Uint8Array([0x30, ...derLen(body.length), ...body]);
}

const b64urlBytes = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlStr = (s: string) => b64urlBytes(new TextEncoder().encode(s));

/**
 * Same JWT as appJwt, signed with WebCrypto. Works on Node 20 and on Cloudflare Workers
 * (workerd's node:crypto does not implement createSign).
 */
export async function appJwtAsync(appId: string, privateKeyPem: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64urlStr(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8(privateKeyPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`)));
  return `${header}.${payload}.${b64urlBytes(sig)}`;
}

type Fetch = typeof fetch;

/** Mint an installation token scoped to one repository. */
export async function installationToken(
  appId: string, privateKeyPem: string, owner: string, repo: string,
  opts: { apiUrl?: string; fetchImpl?: Fetch; installationId?: number } = {},
): Promise<string> {
  const api = opts.apiUrl ?? "https://api.github.com";
  const f = opts.fetchImpl ?? fetch;
  const headers = {
    authorization: `Bearer ${await appJwtAsync(appId, privateKeyPem)}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "mergejudge",
  };
  let id = opts.installationId;
  if (!id) {
    // The Worker already knows the installation id from the webhook; the Action looks it up.
    const inst = await f(`${api}/repos/${owner}/${repo}/installation`, { headers });
    if (!inst.ok) throw new Error(`app installation lookup failed: HTTP ${inst.status}`);
    ({ id } = (await inst.json()) as { id: number });
  }
  const tok = await f(`${api}/app/installations/${id}/access_tokens`, {
    method: "POST",
    headers,
    body: JSON.stringify({ repositories: [repo] }),
  });
  if (!tok.ok) throw new Error(`installation token request failed: HTTP ${tok.status}`);
  const { token } = (await tok.json()) as { token: string };
  if (!token) throw new Error("installation token missing in response");
  return token;
}
