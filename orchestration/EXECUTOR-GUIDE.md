# Executor Guide — Rules of Engagement & Adapter Notes

Read this once before your first task. Every task brief assumes these rules; briefs reference this file by path instead of repeating it.

## 1. Global rules (non-negotiable, both executors)

This is a live email tool with send, delete, calendar, and rules capabilities against a real mailbox.

1. **Read-only first, always.** Any live verification starts with the smoke-test order from `HANDOVER.md` §"Live Smoke Test Order": `auth` (action=status) → `auth` (action=about) → list recent emails → read one email → list calendar events → list folders. No mutating tool call before those pass.
2. **No live sends without guards.** Every send/draft/rules step: `dryRun: true` first; `OUTLOOK_ALLOWED_RECIPIENTS` set; `OUTLOOK_MAX_EMAILS_PER_SESSION` set. Never weaken, unset, or instruct anyone to weaken these (`utils/safety.js` enforces them at runtime; your config keeps them on).
3. **Preserve safety code and annotations.** Do not remove or downgrade MCP `readOnlyHint` / `destructiveHint` / `idempotentHint` annotations, do not weaken `utils/safety.js`, do not bypass `.claude/hooks/faq-protection.sh`.
4. **FAQ policy.** `docs/faq/faq.md` (currently 11 question H2s) must never be deleted, moved, or dropped below 7 question-shaped H2s. Revise via `Edit`-style targeted replacement, never wholesale rewrite. Full policy: `.claude/rules/faq-maintenance.md`.
5. **Tests are the gate.** Baseline: **29 suites / 751 tests passing, `npm run lint` 0 errors** (25 pre-existing warnings are accepted). Confirm the baseline *before* starting any code task; if it differs, stop and report — do not proceed on a moved baseline. After your change: full suite green (751 + your new tests), lint still 0 errors. New behaviour lands TDD-style: failing test first, then implementation.
6. **No secrets in the repo.** Client IDs/secrets live in local MCP config or local env only. Tokens live at `~/.outlook-assistant-tokens.json`; pending device-code state at `~/.outlook-assistant-pending-auth.json`. Never commit, print, or log token contents (redact if you must show state — see `docs/troubleshooting.md` §"Checking Authentication State").
7. **Docs move with code.** Any tool/auth/safety change updates: the tool table in `docs/quickrefs/tools-reference.md`, `CHANGELOG.md` `[Unreleased]`, and — when a trigger in `.claude/rules/faq-maintenance.md` §"When to update the FAQ" fires — `docs/faq/faq.md`. Each brief lists its specific doc obligations.
8. **Reversibility.** One branch per task (`feat/…`, `fix/…`, `test/…`, `docs/…`), small conventional commits (`commitlint.config.js` extends `@commitlint/config-conventional`; types seen in history: `feat`, `fix`, `docs`, `test`, `chore`, `ci`). PRs follow `.github/PULL_REQUEST_TEMPLATE.md` including its checklist. Never commit directly to `main`.
9. **Issue body wins.** Briefs marked "PROPOSED" infer design from `ROADMAP.md` one-liners. Before implementing, run `gh issue view <n> --repo littlebearapps/outlook-assistant` (or read the issue in a browser). If the issue body contradicts the brief's proposed design, follow the issue and note the divergence in your PR description. Acceptance criteria that encode safety or baseline gates are not overridable.
10. **Stop conditions.** Stop and report (do not improvise) if: the test baseline is broken before you start; auth fails with an error not in `HANDOVER.md` §"Common Auth Failures" or `docs/troubleshooting.md`; a task requires weakening any rule above; or a required owner input (Azure access, secrets, sign-in) is missing.

## 2. Ground-truth map — what to trust

| Source | Trust |
|--------|-------|
| `CLAUDE.md`, `package.json`, `config.js`, `docs/**`, `HANDOVER.md`, `ROADMAP.md`, `CHANGELOG.md` | Authoritative |
| `orchestration/**` (this package) | Authoritative for process; cites the above for facts |
| `.claude/hooks/faq-protection.sh`, `.claude/rules/faq-maintenance.md` | Authoritative (the only two git-tracked files under `.claude/`) |
| Root `AGENTS.md` | **Unreliable — claude-flow scaffold boilerplate**, and gitignored (`.gitignore:38`, local-only). It describes a TypeScript/DDD project and references npm scripts that do not exist (`build`, `dev`, `test:integration`, `test:coverage`, `test:security`). Ignore its Quick Start, testing, and commit-footer guidance. Real scripts are in `package.json:10-21`. |
| `.claude/**` (rest of it), `.claude-flow/`, `.agents/`, `.codex/`, `.mcp.json` | claude-flow scaffolding; local-only (gitignored, `.gitignore:33-38`); not project ground truth. |

Real npm scripts (from `package.json`): `start`, `auth-server`, `test-mode`, `inspect`, `test`, `lint`, `lint:fix`, `format`, `format:check`.

## 3. Per-executor adapters

### Claude Code (Opus 4.8)

- Repo instructions load from `CLAUDE.md` automatically; `.claude/settings.json` wires claude-flow hooks (harmless if the claude-flow runtime is absent) and **denies reading `.env`** — keep secrets out of files you need to read.
- Agent roles for this package are defined in `orchestration/agents/*.md` using the repo's observed frontmatter schema. Adopt the role matching your current task (the workflow files name the owner per step). You may run them as subagents or simply follow the role definition inline — either satisfies the workflows.
- **Live MCP verification:** if the `outlook` MCP server is connected (config shape in `HANDOVER.md` §"Recommended Next Step"), call the tools directly (`auth`, `search-emails`, `read-email`, `list-events`, `folders`, …). This is the preferred path for Phase 0.
- The `faq-protection.sh` hook only enforces inside Claude Code *when wired into local `.claude/settings.json`* (see `CLAUDE.md` §"Protected Files"). Treat the FAQ rules as binding regardless.

### Codex CLI

- Reads root `AGENTS.md` by default — apply the §2 warning above; `.codex/config.toml` / `.agents/config.toml` are claude-flow-generated and gitignored.
- No Claude Code hooks run for you. The FAQ protection, therefore, is policy you enforce on yourself: never `rm`/`mv`/`git rm`/`git mv` anything under `docs/faq/`, never rewrite `docs/faq/faq.md` below 7 `## ` question headings.
- **Live MCP verification fallback:** you have no MCP client. Use the MCP Inspector instead: `npm run inspect` starts the server under `npx @modelcontextprotocol/inspector` for interactive tool calls. For scripted checks, drive the stdio server directly, e.g.:

  ```bash
  # tools/list over stdio (server exits after EOF)
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
    | node index.js 2>/dev/null | tail -1 | head -c 400
  ```

  For live-mailbox calls, substitute `tools/call` requests (`{"method":"tools/call","params":{"name":"auth","arguments":{"action":"status"}}}`); export the env vars from your local MCP config first. Never echo secrets into the transcript.
- Agent `.md` role files are not natively loadable; read the relevant `orchestration/agents/*.md` and follow it as your operating brief for the step.

## 4. Live smoke-test recipes (Phase 0 canonical sequence)

Executor-agnostic tool-call order (arguments shown as MCP tool args):

| # | Tool | Args | Pass condition |
|---|------|------|----------------|
| 1 | `auth` | `{"action":"status"}` | Reports authenticated, token not expired |
| 2 | `auth` | `{"action":"about"}` | Returns the signed-in account identity (v3.7.3+ identity surface) |
| 3 | `search-emails` | `{}` (no params = list mode) | Returns recent emails, count ≥ 1 |
| 4 | `read-email` | `{"id":"<id from step 3>"}` | Returns subject + body of that message |
| 5 | `list-events` | `{}` | Returns events or an explicit empty result — not an error |
| 6 | `folders` | `{"action":"list"}` | Returns folder list including Inbox |

Only after 1–6 pass may any mutating verification begin (T0.3), and then only `dryRun` first.

## 5. Working state & checkpoints

- **Progress ledger:** `orchestration/STATE.md` (created by the first workflow step; append-only). One line per completed step: date, phase.step, branch/PR, verification evidence (test counts, tool-call results). This file is how a cold executor resumes mid-phase.
- **Checkpoint = merged PR** (Phases 1–2) or **ledger entry with evidence** (Phase 0, which has no code changes). Every workflow step is written to be abortable: nothing in a later step depends on uncommitted state from an earlier one.
- Rollback: revert the PR (`git revert -m 1 <merge-sha>` or GitHub "Revert"); each brief's "files in scope" bounds the blast radius.
