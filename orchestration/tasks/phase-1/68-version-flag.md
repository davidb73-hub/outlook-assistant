# #68 — Add `--version` CLI flag

**Phase:** 1 · **Owner:** `feature-engineer` → `reviewer` · **Branch:** `feat/68-version-flag`
**Issue:** [#68](https://github.com/littlebearapps/outlook-assistant/issues/68) ("Add `--version` CLI flag", good first issue — `ROADMAP.md` §v3.7.5). Run `gh issue view 68` first; issue body wins over PROPOSED design (EXECUTOR-GUIDE §1.9).
**Global rules:** `orchestration/EXECUTOR-GUIDE.md` §1 (baseline gate 751/29 + lint 0 errors before starting).

## Objective

`node index.js --version` (and the `outlook-assistant` bin, `package.json:7-9`) prints the package version and exits 0 without starting the MCP stdio server.

## Grounded context

- `index.js` currently has **no** `process.argv` handling (verified by search, 2026-07-07) — requiring it boots the stdio server directly.
- The version is already exposed as `config.SERVER_VERSION` (`config.js:71`, sourced from `package.json`); `index.js:61` uses it for the MCP server info. Reuse it — do not read `package.json` a second way.
- Test home: `test/dispatcher/` exists for entry-point-level tests.

## PROPOSED design

Early in `index.js`, before any server construction: if `process.argv.includes('--version')` (also accept `-v` only if the issue asks), `console.log` the bare version string (e.g. `3.8.1`) and `process.exit(0)`. Keep it above MCP bootstrap so no stdio banner/noise precedes the version line.

## TDD steps

1. New test `test/dispatcher/version-flag.test.js`: use `child_process.execFileSync('node', ['index.js', '--version'])` from the repo root; assert stdout trimmed equals `require('../../package.json').version` and exit code 0. Confirm it fails before implementation.
2. Implement; suite green.

## Acceptance criteria (runnable)

| Check | Command | Expected |
|-------|---------|----------|
| Flag works | `node index.js --version` | Exactly the version from `package.json` (currently `3.8.1`) on stdout; exit code 0; no MCP/stderr noise on stdout |
| Server unaffected | EXECUTOR-GUIDE §3 stdio `tools/list` recipe with `USE_TEST_MODE=true` | Still returns 22 tools |
| Suite | `npm test` | All suites pass: 751 baseline + the new test file |
| Lint | `npm run lint` | 0 errors |

## Files in scope / must not change

- **In scope:** `index.js` (top-of-file argv handling only), `test/dispatcher/version-flag.test.js` (new), `CHANGELOG.md` `[Unreleased]` → Added.
- **Must not change:** `config.js`, any module dir, `utils/safety.js`, annotations, docs FAQ.

## Docs

- CHANGELOG entry. `docs/quickrefs/tools-reference.md` unaffected (no MCP tool change). FAQ trigger check (`.claude/rules/faq-maintenance.md`): "install/update procedure change" — borderline; add a line to the install-related answer only if the issue body asks for user-facing docs.

## PR

`feat(cli): add --version flag` … body per `.github/PULL_REQUEST_TEMPLATE.md`, "Related Issues: Fixes #68", Module(s): Utils/Config + Documentation. Reviewer gate per `orchestration/agents/reviewer.md`.
