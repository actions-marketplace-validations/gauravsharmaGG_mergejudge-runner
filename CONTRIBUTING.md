# Contributing

## Setup

Needs Node >= 20 and git.

```sh
npm ci
npm run verify   # typecheck + vitest + build
```

Individual steps: `npm run typecheck`, `npm test`, `npm run build` (writes `dist/cli.js`, git-ignored). Tests run offline against a fake Worker and a fake `claude`; no network or real logins are needed.

## Layout

- `src/` runner source (CLI, config, polling loop, engines, local-code mode).
- `core/` the shared review code (rules, prompts, parsing, result format) **vendored** from the MergeJudge core. Each file starts with a "Vendored ... Keep in sync." header. Please do not make behavioural changes here in a pull request: open an issue describing the problem and maintainers will apply and sync the change from upstream. Bug fixes in `src/` are welcome directly.
- `test/` tests; `test/support/` holds a small copy of the Worker's result schema used to check what the runner submits.

## Pull requests

- Keep PRs small and focused; describe the behaviour change and why.
- Add or update tests for changed behaviour. `npm run verify` must pass (CI runs it on Node 20 and 22).
- Never commit tokens, keys or real repository data, and never log them. Anything touching token handling, the child-process environment or git access needs a note in the PR on its security impact.
- Do not bump the version in `package.json`; maintainers handle releases.
- By contributing you agree your work is released under the MIT licence.
