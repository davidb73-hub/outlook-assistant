# #89 — `manage-tasks` tool for Microsoft To Do (10th module)

**Phase:** 2 (serial slot, after groups C1–C4) · **Owner:** `feature-engineer` → `reviewer`; 👤 owner re-auth required · **Branch:** `feat/89-manage-tasks`
**Issue:** [#89](https://github.com/littlebearapps/outlook-assistant/issues/89) ("`manage-tasks` tool for Microsoft To Do — list, create, update, complete tasks (10th tool module)" — `ROADMAP.md` §v3.8.x Highlights). `gh issue view 89` first; issue body wins.
**Global rules:** `orchestration/EXECUTOR-GUIDE.md` §1. **Sequenced late because it adds a Graph scope → forces re-authentication.**

## Grounded context

- Today: 9 modules, 22 tools (`docs/architecture.md` §"Module Layout"; `package.json:5`). No To Do code exists.
- Graph To Do API: `GET/POST /me/todo/lists`, `GET/POST/PATCH /me/todo/lists/{listId}/tasks` — delegated scope **`Tasks.ReadWrite`**, absent from `AUTH_CONFIG.scopes` (`config.js:81-96`). Works on both personal and work/school accounts (To Do is consumer-available) — verify current Graph docs.
- **Naming collision warning:** a new top-level `tasks/` source dir must be added to `package.json` `files` (`package.json:56-75`) or it won't ship in the npm package — note `rules/`, `settings/`, `advanced/` are all listed individually. Also ensure Jest picks up `test/tasks/`.
- Action-based single-tool pattern to copy: `manage-rules` (`rules/` module — builder/create/update/list split) or simpler `folder/` (one file, `action` param). Consolidation philosophy: one tool, `action` param (`docs/architecture.md` §"Tool Consolidation Map").
- Safety conventions for a mutating tool: rate limiting via `checkRateLimit('manage-tasks')` — which auto-reads `OUTLOOK_MAX_MANAGE_TASKS_PER_SESSION` (derived key, `utils/safety.js:18`) — and `dryRun` on create/update following `manage-rules`' precedent (`CLAUDE.md` §"Safety Controls"). No recipient allowlist (no outbound comms). Task delete: **omit or gate carefully** — `manage-rules` deliberately excludes `permanentDelete` as "too dangerous for AI" (`CLAUDE.md`); PROPOSED: support `complete` but not `delete` unless the issue asks, mirroring that caution.

## PROPOSED design

New module `tasks/` (handler files + `index.js` exporting `tasksTools`), one tool `manage-tasks`: actions `list-lists`, `list`, `create`, `update`, `complete` (issue body final). Annotations: `readOnlyHint: false, destructiveHint: false` (no irreversible action if delete is excluded), `idempotentHint: false`, `openWorldHint: false` — revisit against post-#92 conventions. `dryRun` on create/update. Registered in root `index.js` alongside the other modules (`index.js:16-24` import block + `TOOLS` array at `:44`).

## Steps

1. TDD: `test/tasks/manage-tasks.test.js` — per-action payload/endpoint/rendering tests + mock data in `utils/mock-data.js`; rate-limit test (set `OUTLOOK_MAX_MANAGE_TASKS_PER_SESSION=1` in-test, assert second mutating call blocked — pattern exists in the send/draft tests); dryRun preview test. Red → implement → green.
2. Add `Tasks.ReadWrite` to `AUTH_CONFIG.scopes` (`config.js:81-96`).
3. Wire module: `CLAUDE.md` §"Adding New Tools" checklist. Update every tool/module count: `CLAUDE.md` (header "22 tools across 9 modules"), `package.json:5`, `README.md`, `docs/architecture.md` module layout, `docs/quickrefs/tools-reference.md` (heading + new section).
4. 👤 **Re-auth:** owner must re-consent to the new scope — Azure API-permissions add (if not pre-consented), then `rm ~/.outlook-assistant-tokens.json` and re-run the T0.2 auth steps (`docs/troubleshooting.md` "New scopes not picked up"). Record in STATE.md.

## Acceptance criteria (runnable)

| Check | Command | Expected |
|-------|---------|----------|
| Unit tests | `npx jest test/tasks` | pass (list/create/update/complete/dryRun/rate-limit) |
| Registration | stdio `tools/list` (`USE_TEST_MODE=true`) | `manage-tasks` present with annotations; count = previous+1 everywhere it's asserted |
| npm packaging | `npm pack --dry-run 2>&1 | grep "tasks/"` | module files included |
| Suite / lint | `npm test` · `npm run lint` | all pass · 0 errors |
| Live check (post-merge, golive-operator, after re-auth) | `manage-tasks` `{"action":"list-lists"}` → create task `oa-89-test` (dryRun first, then real) → `complete` it | round-trip works; calls logged in STATE.md |

## Files in scope / must not change

**In scope:** new `tasks/` dir, `index.js` wiring, `config.js` scopes, `package.json` (`files` + description count), `utils/mock-data.js`, `test/tasks/`, `CHANGELOG.md` → Added, `CLAUDE.md`, `README.md`, `docs/architecture.md`, `docs/quickrefs/tools-reference.md`, FAQ (see below).
**Must not change:** existing tools/modules, `utils/safety.js` internals (consume its exports as-is), annotations of other tools.

## PR

`feat(tasks): manage-tasks tool for Microsoft To Do` … "Fixes #89", Module(s): new + Documentation + Auth (scope). Reviewer gate. FAQ triggers fire: **new tool** + **auth flow change (scopes)** → docs-maintainer updates "what you can do" and permissions answers (targeted Edit, ≥7 H2s). This slice is a strong release candidate on its own (Phase 2 workflow step 10).
