# Workflow: Phase 0 — Go-Live & Production Hardening

**Goal:** the server is configured, authenticated, live-verified read-only, send-safety-verified, and signed off for production use.
**Owner agent:** `golive-operator` (`orchestration/agents/golive-operator.md`) for every step; the human owner participates where marked 👤.
**No code changes in this phase.** A code defect discovered here is a stop-and-report, not a fix.
**Global rules:** `orchestration/EXECUTOR-GUIDE.md` §1 applies to every step.

## Preconditions

- `npm install` completed; `npm test` reports `Test Suites: 29 passed` / `Tests: 751 passed`; `npm run lint` reports 0 errors. (If not: abort, report — the handover baseline has drifted.)
- Owner available for Azure portal work and one browser sign-in.

## Steps

| # | Step | Brief | Inputs | Outputs | Verification gate (must pass before next step) | Abort/rollback |
|---|------|-------|--------|---------|-----------------------------------------------|----------------|
| 0 | Create state ledger | — | — | `orchestration/STATE.md` with baseline evidence | File exists, contains today's `npm test` tail | — |
| 1 | 👤 Azure app registration + local MCP config | `tasks/phase-0/T0.1-azure-app-config.md` | Owner's Azure access | Registered app (client ID), local MCP config with safety env vars set | T0.1 acceptance criteria: config file shape verified, secrets absent from repo (`git status --short` clean of config) | Delete the app registration; remove local config |
| 2 | 👤 Device-code auth + read-only smoke test | `tasks/phase-0/T0.2-auth-and-readonly-smoke.md` | T0.1 config; owner at a browser | Valid tokens at `~/.outlook-assistant-tokens.json`; six passing read-only calls logged | All six EXECUTOR-GUIDE §4 checks pass, evidence in STATE.md | `rm ~/.outlook-assistant-tokens.json ~/.outlook-assistant-pending-auth.json` and retry per troubleshooting table |
| 3 | Send-safety verification | `tasks/phase-0/T0.3-send-safety-verification.md` | Passing step 2 | Evidence that dryRun, allowlist, rate limit each demonstrably block/preview | T0.3 acceptance criteria incl. exactly one guarded live self-send | None needed — worst case is one email to the owner's own address |
| 4 | Go-live sign-off + docs sync | `tasks/phase-0/T0.4-golive-signoff.md` | Steps 1–3 evidence | Signed checklist in STATE.md; HANDOVER.md updated; docs PR if drift found | Checklist 100% checked; PR (if any) merged with reviewer approval | Revert docs PR |

## Sequencing rules

- Strictly serial: 1 → 2 → 3 → 4. No step may start before the previous step's gate is recorded in `orchestration/STATE.md`.
- Step 2 failing on an error listed in `HANDOVER.md` §"Common Auth Failures": apply the listed fix and retry (max 3 attempts per distinct error), logging each attempt. An error **not** in that table or `docs/troubleshooting.md`: stop and report.
- Checkpoint/resume: a cold executor reads `orchestration/STATE.md`, finds the last gated step, and continues from the next one. Tokens persisting at `~/.outlook-assistant-tokens.json` mean step 2 need not be repeated after a restart (auto-refresh per `auth/token-storage.js`).

## Phase exit criteria

All four gates recorded; the server is declared production-live for read + guarded-send use; Phase 1 may begin.
