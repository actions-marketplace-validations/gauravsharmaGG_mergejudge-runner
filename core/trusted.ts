// Vendored from the MergeJudge core. Keep in sync.
import type { Config } from "./config.js";

/**
 * `lanes.trusted_authors`: the auto lane's light paths are only for listed GitHub logins. The author comes
 * from GitHub (`pull_request.user`), so a PR author cannot fake it — unlike the body, which is untrusted.
 * Disabled (the default) is exactly today's behaviour. The gate can only take the auto lane away.
 */

export interface PrAuthor {
  login?: string | null;
  /** GitHub user type ("User" | "Bot"); a Bot login is untrusted unless listed. */
  type?: string | null;
}

export interface TrustedAuthorInput {
  author?: PrAuthor | null;
  /** True when the PR carries the agent marker (label `mergejudge:agent` or the `MergeJudge-Actor: agent` body line). */
  agentMarked?: boolean;
}

export type TrustDecision = { trusted: true } | { trusted: false; why: string };

const isBot = (a: PrAuthor) => !!a.login && (/\[bot\]$/i.test(a.login) || a.type === "Bot");

/**
 * Is the author of this PR trusted for the auto lane? Disabled or unconfigured = trusted (no gate).
 * `why` names the config key so the reason reads well in a file's reason list.
 */
export function trustedAuthor(cfg: Config, pr: TrustedAuthorInput): TrustDecision {
  const t = cfg.lanes?.trusted_authors;
  if (!t?.enabled) return { trusted: true };
  const listed = (login: string) => t.users.some((u) => u.trim().toLowerCase() === login.toLowerCase());
  if (t.agents === "untrusted" && pr.agentMarked)
    return { trusted: false, why: "this PR carries the agent marker and lanes.trusted_authors.agents is `untrusted`" };
  const login = pr.author?.login?.trim() ?? "";
  if (!login) return { trusted: false, why: "the PR author is unknown and not on the trusted list (lanes.trusted_authors)" };
  if (!listed(login))
    return {
      trusted: false,
      why: `author ${login} is ${isBot(pr.author!) ? "a bot and not" : "not"} on the trusted list (lanes.trusted_authors)`,
    };
  return { trusted: true };
}
