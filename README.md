# mergejudge-runner

Runs the AI step of a [MergeJudge](https://mergejudge.si) review on **your own machine**, with your own Claude Code or Codex (ChatGPT) login, or a GLM (z.ai) API key. The MergeJudge service keeps handling GitHub events, lanes, the panel and posting; the runner connects **out** over HTTPS (protocol `/runner/v1`), takes review jobs, and sends back a result. No inbound ports.

The runner is not standalone: it connects to the MergeJudge hosted service, which is **invite-only for now**, and needs an enrollment code from the MergeJudge panel (Runners > Add runner). This repository contains the open-source runner (MIT) and the review core it bundles.

## Privacy: what MergeJudge's servers see

**With deep-local mode** (`review.mode: deep` and `runner.code_source: local`, see below), the AI review runs on your machine with your own AI login and reads your code from your own git clone. MergeJudge's servers never receive your repository's files. They read the pull request's diff from GitHub only to run the rules check, and keep only the review result: the lane, the reasons, the summary and the findings. Findings can quote short lines of code; this is the same text that's posted on your pull request.

**In the default diff and context modes**, the hosted service passes the PR diff, your policy files and related code snippets to your runner through its job queue, so they're stored on MergeJudge's servers. Choose deep-local to keep your code off our servers.

In every mode, your code is sent to **your own AI provider** under your own account (Claude Code, Codex or GLM), not through MergeJudge.

## Install

Needs Node >= 20 and, for the default engine, the [Claude Code](https://code.claude.com) CLI (`claude`), logged in.

```sh
npm i -g mergejudge-runner
mergejudge-runner setup <code>   # code from the panel: Runners > Add runner
```

`setup` registers the runner, detects which of `claude` and `codex` are installed and signed in (`claude auth status`, `codex login status`; Codex counts only when signed in **with ChatGPT**, an API-key login is warned about and codex is not offered), asks yes/no about a GLM (z.ai) API key, and offers to start it at login (launchd / systemd user unit). Flags: `--yes`, `--no-autostart`, `--print-unit`, `--engine <claude-code|codex|glm>`, `--model [engine=]<model>` (repeatable), `--codex-effort <minimal|low|medium|high|xhigh>` (default `low`; stored as `engines.codex.effort` in the config), `--glm-key-env NAME`, `--no-glm`; `MERGEJUDGE_URL` overrides the server (default `https://app.mergejudge.si`). Without a global install, `npx mergejudge-runner setup <code>` works too.

## Register

Create an enrollment code in the MergeJudge panel (valid 15 minutes, single use), then:

```sh
mergejudge-runner register --code mjr_e_... --url https://app.mergejudge.si --name my-mac
```

This stores the runner id and token in `$XDG_CONFIG_HOME/mergejudge-runner/config.json` (default `~/.config/...`). The directory is `0700`, the file `0600`, written atomically. The runner **refuses to start** if the file is readable by group or others. Only `https://` URLs are accepted (`http://` only for localhost). Use `--force` to replace an existing registration, `--claude-bin /path/to/claude` to pin the binary.

## Engines and models

| Engine | What runs | Billing |
|---|---|---|
| `claude-code` | `claude -p --tools ""` on your subscription | subscription |
| `codex` | `codex exec --sandbox read-only --skip-git-repo-check --ephemeral --color never --ignore-user-config [-m MODEL] -c model_reasoning_effort=EFFORT --output-schema <file> -o <file> -` (prompt on stdin, ChatGPT login) | subscription |
| `glm` | `claude -p` with `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` and `ANTHROPIC_AUTH_TOKEN=<your key>` set only in the child env | **API key (billed per use)** |

- The runner declares its engines, billing and models when it registers and on the runner heartbeat at every start. The config keeps `engine` (default), `engines: { name: { model, models } }` and, for GLM, `glmApiKey` (config is `0600`; `ZAI_API_KEY` in the environment works too). `models: ["*"]` offers any model.
- A repo can ask for an engine/model in the panel or in `.mergejudge.yml` (`runner.engine`, `runner.model`; the panel wins). If this runner does not offer it, the job is nacked with `code: "unsupported"` and a reason, no attempt is used, and it stays queued for other runners.
- A 0.1.0 config (no `engines`) keeps working as `claude-code` with the default model.
- Codex needs a ChatGPT sign-in: at startup the runner runs `codex login status` and drops codex from its capabilities on an API-key login or no login; a codex job that still arrives is nacked `unsupported` with that reason.
- Never passed to any engine: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, the runner token. The z.ai key is only in the GLM child's env and is masked in logs.

## Run

```sh
mergejudge-runner run                 # long-poll forever
mergejudge-runner run --once          # handle one job (or exit if none is waiting), then exit
mergejudge-runner run --concurrency 2 # capped by the concurrency registered with the server
```

- Heartbeats every <= 20 s while a job runs (lease is 60 s). If the server answers `cancel: true` (a newer push superseded the job) or the lease is lost, the `claude` process tree is killed and nothing is submitted.
- Per-job timeout 10 min (`--job-timeout-min`); on timeout the process tree is killed and the job is nacked.
- Errors (bad engine output, crash, unsupported job) are **nacked** with a short reason; the server retries up to its limit.
- Network errors, 5xx and 429 back off exponentially with jitter; `Retry-After` is honoured.
- `SIGINT`/`SIGTERM`: stop polling, give in-flight jobs 30 s to finish, then kill the engine and nack them ("runner shutting down") and exit. A second signal exits immediately.
- The access token is rotated through `/token/rotate` when it has < 14 days left (or when a response carries an `x-mergejudge-rotate` header). The new token is written to the config file (atomic rename) **before** it is used.
- Modes: `diff`, `context` and `deep`. **Deep on a runner is a single pass**: the Worker builds a temporary index of the repo (the index is not stored, no hosted AI), looks up callers, importers and imports of the changed code (two hops out, hop 1 first), plus files that reference strings, object keys and env var names the diff changed or removed, and sends them as context with the job. The engine still runs with no tools and no checkout, so it cannot browse further. If the repo is too big to index, the review falls back to `context` and says so. Runners older than 0.3.0 do not advertise `deep`, so they are never offered such jobs; upgrade and restart to receive them. With `runner.code_source: local` the runner reads its own clone instead; see below.

## Local code (deep-local: keeps your code off MergeJudge's servers) — runner 0.4.0

By default (`runner.code_source: worker`) the Worker reads the repo through the GitHub API and sends the diff and context with the job. With `code_source: local` in the repo's `.mergejudge.yml` (read from the base commit):

```yaml
review:
  mode: deep
runner:
  code_source: local
```

the job carries only the repo, PR number, base/head SHAs, the config and the rules result. **No diff, no context, no file contents, no token.** The runner reads the code itself:

1. keeps a persistent **partial bare clone** per repo, `~/.mergejudge/repos/<owner>__<repo>.git` (`git clone --bare --filter=blob:none`), and fetches the job's base and head SHAs;
2. computes the PR diff locally (`git diff base...head`, renames detected, `diff_exclude` respected);
3. builds an index of the base commit (symbols, import graph, code chunks) over `git ls-tree` / `git cat-file`, saved at `~/.mergejudge/idx/<owner>__<repo>/<sha>.json`. The next job on the repo updates it incrementally from the git diff between the saved commit and the new base; the PR's own changes are overlaid in memory. There is no 300-file cap (up to 20,000 files, 200 MB read, 15 min);
4. retrieves callers, importers and imports of the changed code, reviews in one pass with your engine, and sends back only the structured result (verdict, findings, comments).

**Git access.** The runner uses the machine's own git credentials, nothing from MergeJudge. Make sure `git clone https://github.com/<owner>/<repo>.git` works for the user that runs the runner (`gh auth setup-git`, a credential helper, or a deploy key). For SSH or a mirror, set a remote URL template with `{owner}` and `{repo}`:

```sh
MERGEJUDGE_REMOTE_URL_TEMPLATE='git@github.com:{owner}/{repo}.git' mergejudge-runner run
mergejudge-runner run --remote-url-template 'https://git.example.com/{owner}/{repo}.git'
```

(precedence: flag, environment, `localCode.remoteUrlTemplate` in the config file, default `https://github.com/{owner}/{repo}.git`). If git cannot read the repo, the job **fails with an explicit message** ("cannot read owner/repo with this runner's own git access ...", shown on the PR); it never silently falls back to a diff-only review. Private-repo credentials are never logged; URLs in errors are scrubbed.

**Cache.** `MERGEJUDGE_HOME` moves everything (default `~/.mergejudge`). After each job the runner keeps the newest **3** index snapshots per repo, evicts repos untouched for **30 days**, and, when `repos/` + `idx/` exceed **5 GB**, evicts the least recently used repos. Tune with `MERGEJUDGE_CACHE_MAX_GB`, `MERGEJUDGE_CACHE_KEEP_SNAPSHOTS`, `MERGEJUDGE_CACHE_MAX_AGE_DAYS`, `--cache-max-gb`, or `localCode` in the config file. An evicted repo is simply cloned and indexed again on its next job. Jobs on the same repo run one after another (lock); different repos run in parallel.

**Compatibility.** The runner announces `features: ["local-code"]` at start and on every heartbeat. The Worker only sends the SHAs-only payload to a runner that announced it and was seen in the last 10 minutes; otherwise (older runner, none online) it uses the 0.3.0 path (the Worker builds the context). A 0.4.0 runner still handles those old-style jobs. The panel and `.mergejudge.yml` stay unchanged for repos that do not set `code_source: local`.

The repo's contents stay on your disk: both the clone and the snapshots (which contain code chunks) live under `MERGEJUDGE_HOME`. The Worker also skips building its own R2/Vectorize index for such repos.

## Status

```sh
mergejudge-runner status
```

Prints the config (token shown as its first 10 characters only), whether the Worker is reachable, and the result of a runner-level heartbeat (which also extends the leases the Worker holds for this runner).

## Keep it running

- macOS: [examples/si.mergejudge.runner.plist](examples/si.mergejudge.runner.plist) (LaunchAgent, `KeepAlive`, logs to `~/Library/Logs`). It contains no secrets.
- Linux: a systemd user unit with `ExecStart=node /path/to/dist/cli.js run`, `Restart=always`, `TimeoutStopSec=45`.

Logs go to stderr.

## Security notes

- **Use your own login, for your own repos.** The `claude-code` engine uses *your* Claude subscription login on *your* machine. Do not share one subscription with a team or run it for an organisation; check the terms of your Claude plan, and prefer API-key engines where they apply. This is not legal advice.
- **`ANTHROPIC_API_KEY` must stay unset.** If it is set, Claude Code bills the API instead of your subscription. The runner never passes it (or `ANTHROPIC_AUTH_TOKEN`, any `MERGEJUDGE_*`, `OPENAI_*`, `GITHUB_*`, `AWS_*`, the runner token) to `claude`. The child gets a minimal allowlist copy of the environment (`PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, `XDG_*`, `CLAUDE_CONFIG_DIR`, proxy and CA variables, `CLAUDE_CODE_OAUTH_TOKEN` for `claude setup-token` logins). Unset `ANTHROPIC_API_KEY` in your own shell/service too, so `claude` is not confused by your global setup.
- **PR content is untrusted.** The prompt goes to `claude -p` on **stdin** (never argv, so it is not visible in `ps`), the CLI runs with `--tools ""` (no tools at all), an empty temp directory as cwd, no session persistence, and no slash commands. The model can only answer with text, which the shared parser validates; the server then applies its own floor (a runner can raise a lane, never lower it).
- **Token storage.** The runner token (`mjr_a_...`) is a bearer credential for your installation's review jobs. It lives only in the 0600 config file; it is never logged (logs hold job ids, repo/PR numbers, durations and sizes; a redaction filter masks token shapes as a safety net) and never passed to the engine. Revoke or rotate it in the panel if a machine is lost. The runner follows no redirects, so the token cannot be forwarded to another origin.
- **What the runner sees.** Job payloads contain the PR diff, title/body, the repo's policy files and (context mode) related files. Nothing is written to disk by the runner except the config file (and, in local-code mode, the clone and index cache).
- The `claude` process runs as you. Run the runner under a dedicated OS user if you do not want PR text processed in your main account.

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Build from source

```sh
git clone https://github.com/gauravsharmaGG/mergejudge-runner && cd mergejudge-runner
npm ci
npm run verify                  # typecheck + tests + build
node dist/cli.js --help
```

`src/` is the runner; `core/` is the shared review code (rules, prompts, parsing, result format) vendored from the MergeJudge core, so the prompt, JSON parsing and result format are identical to the service. `core/` is synced by maintainers; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Changelog

See the GitHub releases. Latest: **0.4.5** (policy files share the total budget fairly; truncation is reported).

## Licence

[MIT](LICENSE)
