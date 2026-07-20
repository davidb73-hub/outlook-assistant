# Scope Proposal — Completing the Outlook Assistant

**Status:** Committed. This is the plan the execution package implements — no approval gate.
**Authored:** 2026-07-07, against `main` at `998c9a8`.
**Verified baseline at authoring time:** v3.8.1 (`package.json:3`), 22 MCP tools, `npm test` → 29 suites / 751 tests passing, `npm run lint` → 0 errors / 25 warnings.

## 1. What "complete" means

Two authoritative signals compete:

1. **`HANDOVER.md`** (2026-06-28, most recent operational state): the code is done for now; the explicit instruction is *"Do not build more features yet. The next phase is configuration and live read-only smoke testing."*
2. **`ROADMAP.md`**: open milestones with real issue numbers — v3.7.5 polish (#93, #92, #72, #69, #68), the v3.8.x carry-over slate (#89, #123, #125, #117, #169, #127, #91, #126, #118, #90), and v3.9.0 (#147, #133, #132, #131, #130, #129, #128).

**Resolution:** these signals are sequential, not contradictory. HANDOVER constrains *what comes first*, not *what "done" is*. The committed definition of complete is:

> **Phase 0** — the server is configured, authenticated, live-verified read-only, send-safety-verified, and signed off for production use (HANDOVER's next phase, executed to completion).
> **Phase 1** — the v3.7.5 polish/hardening slate is shipped (#68, #69, #72, #92, #93).
> **Phase 2** — the v3.8.x feature slate is shipped (#118, #125, #126, #117+#169, #127, #91, #89, #123, #90).

Each phase is independently executable and independently valuable: the owner can stop after any phase and still have shipped something coherent (a production-live server after Phase 0; a hardened patch release after Phase 1; the feature milestone after Phase 2).

**v3.9.0 is explicitly out of scope** — see Decisions & Assumptions D3.

## 2. Phase plan

### Phase 0 — Go-live & production hardening

Source: `HANDOVER.md` ("Recommended Next Step", "Azure Setup Checklist", "Live Smoke Test Order"). No code changes; configuration and live verification only.

| Task | Brief | Depends on |
|------|-------|-----------|
| T0.1 | Azure app registration + local MCP config (`orchestration/tasks/phase-0/T0.1-azure-app-config.md`) | Owner supplies Azure access |
| T0.2 | Device-code auth + read-only live smoke test (`orchestration/tasks/phase-0/T0.2-auth-and-readonly-smoke.md`) | T0.1 |
| T0.3 | Send-safety verification — dryRun, allowlist, rate limit (`orchestration/tasks/phase-0/T0.3-send-safety-verification.md`) | T0.2 |
| T0.4 | Go-live sign-off + docs sync (`orchestration/tasks/phase-0/T0.4-golive-signoff.md`) | T0.3 |

Workflow: `orchestration/workflows/phase-0-golive.md`. Owner-in-the-loop: T0.1 requires the owner's Azure portal access and secrets; T0.2's sign-in step requires a human at a browser. Everything else is executor-driven.

### Phase 1 — v3.7.5 polish & hardening

Source: `ROADMAP.md` §"v3.7.5 — Fixes & Polish". All five issues are small, independent, and low-risk — ideal first code changes after go-live because they exercise the full TDD → review → merge loop on low-stakes ground.

| Order | Issue | Brief | Risk |
|-------|-------|-------|------|
| 1.1 | #68 `--version` CLI flag | `orchestration/tasks/phase-1/68-version-flag.md` | trivial |
| 1.2 | #69 better wrong-client-secret error | `orchestration/tasks/phase-1/69-secret-error-message.md` | low |
| 1.3 | #72 token-refresh integration test | `orchestration/tasks/phase-1/72-token-refresh-integration-test.md` | low (test-only) |
| 1.4 | #92 `openWorldHint` annotation audit | `orchestration/tasks/phase-1/92-openworldhint-audit.md` | low |
| 1.5 | #93 tool-description audit | `orchestration/tasks/phase-1/93-tool-descriptions-audit.md` | low, wide surface |

1.1–1.3 are parallelizable (disjoint files). 1.4 must land before 1.5 (both touch every tool definition; sequencing avoids rebase churn). Workflow: `orchestration/workflows/phase-1-polish.md`.

### Phase 2 — v3.8.x feature delivery

Source: `ROADMAP.md` §"v3.8.x — Task Integration & Auth (carry-over)". Sequenced by risk and module coupling: bugfixes first, then feature clusters grouped by module, then the auth-model change (highest blast radius) near the end, with the additive MCP-prompts feature closing the phase.

| Order | Issue(s) | Brief | Notes |
|-------|----------|-------|-------|
| 2.1 | #118 `list-events` timezone info | `orchestration/tasks/phase-2/118-list-events-timezone.md` | bugfix, calendar |
| 2.2 | #125 recurring events | `orchestration/tasks/phase-2/125-recurring-events.md` | calendar |
| 2.3 | #126 `findMeetingTimes` | `orchestration/tasks/phase-2/126-find-meeting-times.md` | calendar; work/school-only Graph API |
| 2.4 | #117 + #169 search-emails improvements | `orchestration/tasks/phase-2/117-169-search-improvements.md` | grouped: same tool, overlapping code paths |
| 2.5 | #127 contact structured email fields | `orchestration/tasks/phase-2/127-contact-email-fields.md` | contacts |
| 2.6 | #91 search-people org hierarchy | `orchestration/tasks/phase-2/91-search-people-org-hierarchy.md` | contacts; work/school-only |
| 2.7 | #89 `manage-tasks` (Microsoft To Do) | `orchestration/tasks/phase-2/89-manage-tasks.md` | new 10th module; new Graph scope → re-auth + FAQ |
| 2.8 | #123 client-credentials (app-only) auth | `orchestration/tasks/phase-2/123-app-only-auth.md` | auth architecture; owner Azure admin needed |
| 2.9 | #90 MCP prompts | `orchestration/tasks/phase-2/90-mcp-prompts.md` | additive; `index.js:114` already stubs `prompts/list` |

Parallelizable groups (disjoint modules): {2.1–2.3 calendar}, {2.4 email}, {2.5–2.6 contacts}, {2.9}. 2.7 and 2.8 are serialized after the others because both change `config.js` scopes/auth and force re-authentication. Workflow: `orchestration/workflows/phase-2-features.md`.

## 3. Decisions & Assumptions

**D1 — HANDOVER-vs-ROADMAP tension: go-live first, features after.** HANDOVER's "do not build more features yet" is read as a sequencing constraint, not a scope cut. Phase 0 executes HANDOVER verbatim; Phases 1–2 then deliver the roadmap. Rationale: features shipped against a never-live-verified server risk building on broken auth/config assumptions; conversely, discarding the roadmap would ignore the repo's own definition of remaining work.

**D2 — v3.7.5 before v3.8.x.** ROADMAP lists v3.7.5 as carry-over polish "the next patch after v3.7.4". It is smaller, lower-risk, and #92/#93 improve the tool-definition surface that Phase 2 features will extend. Shipping it first also validates the executor's full code-change loop cheaply.

**D3 — v3.9.0 excluded from "complete".** The v3.9.0 items (#147, #133, #132, #131, #130, #129, #128) are dated "Roughly Q3 2026" in `ROADMAP.md`, depend on external Microsoft platform changes (e.g. #131 tracks a Graph deprecation landing Dec 2026), and #147 has its own research/rollout track (referenced in `CLAUDE.md` §"See Also" as `docs/research/publisher-verification.md` — note that path does not exist in the working tree at authoring time; the CLAUDE.md reference is stale, which itself argues the #147 track is not ready to brief). Authoring execution briefs for them now would violate the grounding rule — their specs are not yet stable. They remain roadmap, not scope.

**D4 — Workflows live in `orchestration/workflows/`, not `.claude-flow/workflows/`.** The superprompt names `.claude-flow/workflows/` as a primary landing place, but `.gitignore:33-38` ignores the local agent tooling wholesale: `.agents/`, `.claude/`, `.claude-flow/`, `.codex/`, `.mcp.json`, and `AGENTS.md` (only `.claude/hooks/faq-protection.sh` and `.claude/rules/faq-maintenance.md` are force-tracked — verified with `git ls-files .claude`). Files there would be invisible to review, to git history, and to a fresh clone. The package therefore keeps all artifacts under git-tracked `orchestration/`. An executor using claude-flow tooling may copy workflow files into `.claude-flow/workflows/` at runtime; the tracked copies remain canonical.

**D5 — Root `AGENTS.md` is treated as unreliable.** It is claude-flow scaffold boilerplate: it describes a "TypeScript / DDD" project and references npm scripts that do not exist in `package.json` (`build`, `dev`, `test:integration`, `test:coverage`, `test:security`, `test:production`, `test:e2e`). It is also gitignored (`.gitignore:38`) — present in this working copy only, absent from a fresh clone. `CLAUDE.md`, `package.json`, and `docs/` are the ground truth. `orchestration/EXECUTOR-GUIDE.md` §2 carries the explicit warning for Codex, which reads `AGENTS.md` by default when present.

**D6 — Agent definitions follow the observed `.claude/agents/**` frontmatter schema** (`name`, `type`, `color`, `description`, `capabilities`, `priority`, optional `tools`, optional `hooks.pre/post` — observed in `.claude/agents/core/planner.md`, `.claude/agents/testing/production-validator.md`, `.claude/agents/github/pr-manager.md`). Hooks in this package are plain shell (echo + `npm test`-style checks) — no `npx claude-flow` / `agentdb-cli` invocations, since those runtimes are not guaranteed present for either executor.

**D7 — No version numbers pre-assigned to Phase 1/2 releases.** ROADMAP itself says items may be "renumbered if scope shifts", and shipped versions (3.8.0, 3.8.1) have already outrun milestone labels (a milestone named "v3.7.5" would ship as ≥3.8.2). Release tasks instruct semver-at-release-time: patch for Phase 1, minor for Phase 2 slices, using `npm version` (whose `version` script, `package.json:21`, syncs `server.json`).

**D8 — Grouping #117 with #169.** Both modify `search-emails` (`email/search.js`) and #169 explicitly includes the `kqlQuery` rename that #117's folder-scoped search UX depends on. One brief, one branch, one PR avoids double churn in the most regression-prone module (see v3.7.4 history in `CHANGELOG.md`).

**D9 — Live verification uses the executor's MCP access where available.** Claude Code can drive the connected Outlook MCP server directly; Codex cannot assume an MCP client. Phase 0 briefs therefore specify tool-call sequences with a shell-based fallback (`npm run inspect` / MCP Inspector) — see `orchestration/EXECUTOR-GUIDE.md` §4.

**D10 — Issue specs are taken from `ROADMAP.md` one-line descriptions only.** GitHub issue bodies were not readable at authoring time (no network guarantee). Where a brief needs detail beyond the ROADMAP line, it says so and instructs the executor to read the issue via `gh issue view <n>` **before** implementation, treating the issue body as authoritative over the brief's inferred design. Inferred designs are marked "PROPOSED" in each brief.

**A1 — No live Azure credentials exist yet.** T0.1 treats app registration as owner-supplied. Nothing in this package assumes working tokens until T0.2 completes.

**A2 — The account used for go-live is the owner's** (`david.basseal@vitasci.com.au` per HANDOVER context) — account type (personal vs work/school) is confirmed in T0.1 and gates which optional scopes and Phase 2 features (#126, #91, shared-mailbox scopes) apply.

**A3 — Baseline drift handling.** If `npm test` ever reports a different passing baseline than 751/29 before a task starts, the executor stops and reports rather than proceeding on a moved baseline (rule embedded in every brief).

## 3a. Cross-cutting requirements

**R1 — All user-facing times must render in the configured display timezone, DST-correct.**

Added 2026-07-08 after a live inbox check surfaced that email tool output presents times inconsistently and none of it honours `OUTLOOK_DEFAULT_TIMEZONE` (`Australia/Sydney` in the owner's live `.env`, see STATE 2026-07-07 15:17):

- Microsoft Graph returns email `receivedDateTime`/`sentDateTime` as **UTC** (ISO-8601 with a `Z` suffix). Calendar `start`/`end` come as `{dateTime, timeZone}` objects.
- `email/headers.js:258` and `email/conversations.js:539,637` emit the **raw UTC** string with no conversion or label.
- `email/export.js:168` uses `new Date(...).toLocaleString('en-AU')`, which renders in the **host machine's** timezone — not the configured display timezone, and not pinned to Australia.
- Only the calendar path (#118, `calendar/list.js`) converts correctly, via `toLocaleString('en-AU', { timeZone: tz })`.

**Requirement:** every tool that renders a timestamp for the user (email received/sent times, calendar, tasks once #89 lands, any future time-bearing output) must convert to the `OUTLOOK_DEFAULT_TIMEZONE` IANA zone and name that zone in the output, matching the convention #118 established for `list-events`. Conversion must go through `Intl`/`toLocaleString('en-AU', { timeZone })` (or an equivalent IANA-zone API) so the **AEST (UTC+10) ↔ AEDT (UTC+11)** daylight-saving switch — first Sunday in April / first Sunday in October — is handled automatically. Do **not** apply a fixed ±10/±11 offset anywhere. Where a tool cannot convert (raw/forensic output such as `read-email` `headersMode`), it must explicitly label the value as UTC rather than presenting an ambiguous bare timestamp.

**Acceptance (per touched tool):** a test that renders one timestamp in the AEDT half of the year and one in the AEST half and asserts the offsets differ by exactly one hour and the IANA zone name appears in the output. Scope for the email side (`email/headers.js`, `email/conversations.js`, `email/export.js`) is currently unbudgeted — it has no ROADMAP issue and is not yet a Phase 2 task brief; treat R1 as the requirement of record and open a task/issue before implementing, rather than folding it silently into an unrelated PR. #118 already satisfies R1 for `list-events`.

## 4. Risk register (summary)

| Risk | Phase | Mitigation |
|------|-------|-----------|
| Live send to unintended recipient | 0, 2 | Every send path: `dryRun: true` first; `OUTLOOK_ALLOWED_RECIPIENTS` + `OUTLOOK_MAX_EMAILS_PER_SESSION` mandatory in config (enforced by `utils/safety.js`) |
| Auth misconfig burns time | 0 | HANDOVER's "Common Auth Failures" table embedded in T0.1/T0.2 |
| Scope creep in #93 (touches all 22 tools) | 1 | Brief bounds it to descriptions only; annotations already handled by #92 |
| #123 destabilizes delegated auth | 2 | Additive auth path only; delegated flow tests must stay green; sequenced last-but-one |
| New Graph scope forces re-auth mid-phase | 2 | #89/#123 serialized at phase end; re-auth step explicit in briefs |
| GitHub issue body contradicts brief | 1, 2 | D10: issue body wins; executor re-plans within brief's acceptance-criteria framework |
