# Workflow: Phase 1 — v3.7.5 Polish & Hardening

**Goal:** ship the five-issue polish slate from `ROADMAP.md` §"v3.7.5 — Fixes & Polish" as a patch release.
**Precondition:** Phase 0 exit criteria met (see `orchestration/STATE.md`); baseline green (`npm test` 751/29, `npm run lint` 0 errors).
**Global rules:** `orchestration/EXECUTOR-GUIDE.md` §1. Every code step is: baseline gate → branch → TDD → PR → review → merge.

## Step template (applies to steps 1–5)

- **Owner:** `feature-engineer` implements; `reviewer` gates the PR; `docs-maintainer` owns the brief's docs checklist items (may be executed by the same session wearing different roles — the checks, not the headcount, are the point).
- **Input:** the task brief + the live GitHub issue body (issue wins over PROPOSED design, EXECUTOR-GUIDE §1.9).
- **Output:** merged PR referencing the issue.
- **Gate:** reviewer approval per `orchestration/agents/reviewer.md` procedure — acceptance criteria re-run, baseline + new tests green, lint 0 errors, safety surface unchanged.
- **Rollback:** revert the merge commit; each step's changes are isolated to its brief's files-in-scope.

## Steps

| # | Issue | Brief | Parallel group |
|---|-------|-------|----------------|
| 1 | #68 `--version` CLI flag | `tasks/phase-1/68-version-flag.md` | A |
| 2 | #69 wrong-client-secret error message | `tasks/phase-1/69-secret-error-message.md` | A |
| 3 | #72 token-refresh integration test | `tasks/phase-1/72-token-refresh-integration-test.md` | A |
| 4 | #92 `openWorldHint` annotation audit | `tasks/phase-1/92-openworldhint-audit.md` | B (before 5) |
| 5 | #93 tool-description audit | `tasks/phase-1/93-tool-descriptions-audit.md` | B (after 4) |
| 6 | Patch release | below | after 1–5 |

Group A steps touch disjoint files and may run in any order or in parallel (separate branches). Group B is serialized: #92 then #93, because both edit tool definitions across all module `index.js` files and #93 rebases painfully over annotation churn.

## Step 6 — Patch release

**Owner:** `feature-engineer` (mechanics) + `docs-maintainer` (CHANGELOG/FAQ pass) + `reviewer` (gate). 👤 Owner approves the version bump before push.

1. Baseline gate on `main` after all merges: `npm test` → all suites pass (751 + tests added in steps 1–5); `npm run lint` → 0 errors.
2. `docs-maintainer`: move `[Unreleased]` entries under a new version heading in `CHANGELOG.md`; walk the FAQ trigger checklist (`.claude/rules/faq-maintenance.md`) — for this slate, expect "new safety controls" (#92 annotations) and possibly "install/update" (#68) triggers.
3. On a release branch: `npm version patch` (runs the `version` script from `package.json:21`, syncing `server.json`; verify with `git diff HEAD~1 -- server.json package.json`).
4. PR titled `chore(release): v<x.y.z> — v3.7.5 milestone slate`; reviewer gate; 👤 owner merges; tagging/publish follows the repo's existing CI (`.github/workflows/publish.yml`, npm Trusted Publishing) — do not hand-publish.

**Gate:** release PR merged; `orchestration/STATE.md` updated with the released version and final test count.
**Rollback:** revert the release PR before tag/publish; if published, ship a follow-up patch (npm unpublish is not an option for a public package).

## Phase exit criteria

Five issue PRs + release PR merged; STATE.md records the new baseline test count (replaces 751 as the gate number for Phase 2).
