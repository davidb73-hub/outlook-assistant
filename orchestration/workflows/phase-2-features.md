# Workflow: Phase 2 — v3.8.x Feature Delivery

**Goal:** ship the v3.8.x carry-over slate from `ROADMAP.md` §"v3.8.x — Task Integration & Auth".
**Precondition:** Phase 1 exit criteria met; `orchestration/STATE.md` records the current baseline test count (751 + Phase 1 additions) — that number is the new pre-task gate.
**Global rules:** `orchestration/EXECUTOR-GUIDE.md` §1. Same step template as Phase 1: `feature-engineer` implements TDD-style on a branch, `docs-maintainer` handles the docs checklist, `reviewer` gates, merge is the checkpoint, revert is the rollback.

## Steps

| # | Issue(s) | Brief | Module | Parallel group | Live-verify after merge? |
|---|----------|-------|--------|----------------|--------------------------|
| 1 | #118 `list-events` timezone info | `tasks/phase-2/118-list-events-timezone.md` | calendar | C1 | yes — read-only |
| 2 | #125 recurring events | `tasks/phase-2/125-recurring-events.md` | calendar | C1 (after 1) | yes — create+delete own event |
| 3 | #126 `findMeetingTimes` | `tasks/phase-2/126-find-meeting-times.md` | calendar | C1 (after 2) | work/school account only |
| 4 | #117 + #169 search improvements | `tasks/phase-2/117-169-search-improvements.md` | email | C2 | yes — read-only |
| 5 | #127 contact structured email fields | `tasks/phase-2/127-contact-email-fields.md` | contacts | C3 | yes — create+delete own contact |
| 6 | #91 search-people org hierarchy | `tasks/phase-2/91-search-people-org-hierarchy.md` | contacts | C3 (after 5) | work/school account only |
| 7 | #90 MCP prompts | `tasks/phase-2/90-mcp-prompts.md` | index.js | C4 | yes — prompts/list |
| 8 | #89 `manage-tasks` (To Do) | `tasks/phase-2/89-manage-tasks.md` | new `tasks/` module | serial, after C1–C4 | yes — 👤 re-auth needed (new scope) |
| 9 | #123 app-only auth | `tasks/phase-2/123-app-only-auth.md` | auth | serial, after 8 | 👤 owner Azure admin required |
| 10 | Minor release(s) | below | — | after each coherent slice | — |

## Sequencing rules

- Groups C1–C4 touch disjoint modules and may proceed in parallel on separate branches. Within a group, steps are serial (same files).
- Steps 8 and 9 are **serialized at the end**: both change `config.js` `AUTH_CONFIG.scopes` / the auth model, both force re-authentication (`docs/troubleshooting.md`: "New scopes not picked up → delete `~/.outlook-assistant-tokens.json` and authenticate again"), and #123 has the largest blast radius in the codebase's most security-sensitive area.
- Account-type gating (from Phase 0 T0.1's recorded account type in STATE.md): if the live account is **personal**, steps 3 and 6 still merge on green unit tests, but their live verification is recorded as "not verifiable on personal account — deferred" rather than skipped silently.
- After each merge with "Live-verify: yes": `golive-operator` runs the read-only smoke order (EXECUTOR-GUIDE §4) plus the brief's specific live check, and logs evidence in STATE.md. Any live regression → revert the merge, reopen the issue.

## Step 10 — Release(s)

Same mechanics as Phase 1 step 6, with `npm version minor`. Cut a release after any coherent slice (e.g. calendar trio, or #89) rather than holding everything for one big-bang release — each release keeps the "independently valuable" property. 👤 Owner approves each bump. FAQ triggers expected this phase: **new tool** (#89), **auth flow change** (#123 — update questions on permissions/tokens per `.claude/rules/faq-maintenance.md`), **account-compatibility shift** (#126, #91 work/school gating).

## Phase exit criteria

All nine issue slots merged (or explicitly re-scoped by the owner with a note in STATE.md), releases cut, live verifications logged. The ROADMAP v3.8.x section then contains no open items — update `ROADMAP.md` accordingly (docs-maintainer) and close the phase in STATE.md.
