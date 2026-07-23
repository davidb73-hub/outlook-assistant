---
schema: email-assistant.assessment.v1
title: Production-Readiness Assessment — Local Email Archive + Draft-Reply System
date: 2026-07-23
assessor: Claude (adversarial review, Claude Code session)
scope:
  repos:
    - path: ~/Developer/EMAIL-Assistant-Repos/outlook-assistant
      vcs: git
      branch: feat/local-email-archive
      head: 8bcee29
    - path: ~/Developer/command-centre
      vcs: none
      note: NOT under version control at assessment time
  subsystems: [archive-worker, delivery-pipeline, triage, draft-replies, command-centre-brains]
overall_verdict: >
  Functional, well-tested, currently running reliably in production, but NOT
  production-grade for a system holding litigation evidence, client CRM, and financial
  data. Distance to production is almost entirely recoverability/version-control, not
  correctness. Rough maturity: ~60%.
evidence_snapshot:
  outlook_assistant_tests: { total: 946, passing: 946, suites: 69 }
  command_centre_selftests: { status: all_passing, note: "stdlib unittest / house runner, no pytest" }
  last_8_scheduled_runs: completed        # per-message isolation fix verified in prod
  notifications_status: stopped
  git_uncommitted_files: 12               # incl. 8 core-module files, ~194 insertions
  git_unpushed_commits: 54
  git_remote: fork (davidb73-hub/outlook-assistant), nothing pushed
  delivery_jobs: { delivered: 15, rejected: 43, review: 10, non_delivered_total: 53 }
  attachment_scan: { safe: 10113, scanner_unavailable: 2, pending: 12743, backfill: running }
  internet_message_id_coverage: "27538/27541"   # present
  list_unsub_headers: not_captured               # no column; bulk veto half-inert
  eslint: { errors: 1, warnings: 3 }
  auth: { method: device-code, has_refresh_token: true, scope_includes_write: true }
findings:
  - id: F1
    severity: blocking
    category: recoverability
    title: command-centre has zero version control
    detail: >
      24 Python files including ledger.py (audit spine), tiering.py (the safety gate the
      privacy model depends on), egress.py, and the Hannibal/Reggie brains have no git
      history, no rollback, no diff, no code backup independent of restic. The one
      subsystem whose trustworthiness is load-bearing is the one that cannot be audited.
    recommendation: >
      git init command-centre with a .gitignore excluding tokens/secrets/*.sqlite3/data
      and the vault; commit current working state; push to a private remote. Review the
      .gitignore and file list with the owner BEFORE the first commit.
    verify: "git -C ~/Developer/command-centre log --oneline | head; git status is clean"
  - id: F2
    severity: blocking
    category: reproducibility
    title: Production runs uncommitted working-tree code
    detail: >
      launchd runs the working tree. outlook-assistant has 8 uncommitted core-module files
      (archive-service.js, config.js, migrations.js, triage-router.js and 4 new test files)
      totalling ~194 insertions. What is actually running has no recorded version.
    recommendation: >
      Review and commit the uncommitted archive-worker changes (or explicitly revert them);
      make "clean working tree" the launchd invariant. Consider running launchd from a
      committed tag/ref rather than the live working tree.
    verify: "git status --porcelain is empty on the branch launchd runs from"
  - id: F3
    severity: blocking
    category: durability
    title: No commits pushed to any remote
    detail: >
      Branch feat/local-email-archive is 54 commits ahead of origin/main (a fork) and
      unpushed. The only copy of committed history is this Mac. With F1+F2 the bus factor
      is a single disk failure.
    recommendation: "Push both repos to a private remote; establish a routine push cadence."
    verify: "git log origin/<branch>..HEAD is empty after push"
  - id: F4
    severity: serious
    category: reliability
    title: Delivery pipeline has a reject/stuck backlog with no auto re-drive
    detail: >
      43 rejected, 10 review, 53 non-delivered delivery jobs. Some rejects are the
      unscanned-attachment failures the backfill is now clearing, but a 'rejected' job is
      not automatically re-driven once its attachments become 'safe'.
    recommendation: >
      After the attachment-scan backfill finishes, add a re-drive/dead-letter step that
      re-evaluates rejected jobs whose blocking condition (unscanned attachment) has
      cleared. Distinguish terminal rejects (quarantined/blocked) from transient ones.
    verify: "delivery_jobs rejected count drops after re-drive; quarantined stay rejected"
  - id: F5
    severity: serious
    category: correctness
    title: Triage bulk-mail veto is knowingly inert (List-Unsubscribe/List-Id not captured)
    detail: >
      routing-orchestrator.js documents that looksLikeBulk's List-Unsubscribe/List-Id veto
      cannot fire because those headers are not stored (no column). internet_message_id IS
      present (27538/27541) but that is a different field. Newsletters can be misrouted.
    recommendation: >
      Capture List-Unsubscribe / List-Id at sync time into a new column (or a headers
      table), then re-enable the veto. Backfill headers for existing rows if feasible.
    verify: "veto fires in a test with a List-Unsubscribe header; newsletter routed to review"
  - id: F6
    severity: serious
    category: security
    title: Prompt-injection risk is accepted, not solved
    detail: >
      Inbound attacker-controlled email is read into a local LLM (triage and draft-reply).
      The <external-content tier/provenance> fencing added for draft-replies is a
      mitigation, not a guarantee. Per the owner's Phase-1 constraint, no
      prompt-injection defence exists across the repos; this is a deliberate accepted risk
      on a mailbox holding litigation evidence.
    recommendation: >
      Keep the no-autonomous-outbound-from-inbound rule. Before granting the draft-reply
      job more agency, review genuine mitigations (dual-LLM quarantine, capability-scoped
      tools, taint tracking). Treat any new inbound->action path as requiring sign-off.
    verify: "no code path lets inbound email content trigger send/delete/move/exfiltration"
  - id: F7
    severity: serious
    category: completeness
    title: Draft-reply feature built but not activated or prod-verified
    detail: >
      email_draft_push.py, style_profile.py, draft_replies.py enrichment, and the launchd
      plist (com.vitasci.draft-replies) exist and are unit-tested, and a dry-run generated
      good drafts. But the plist is NOT loaded and a live --push cycle was never run, so
      real Outlook Drafts creation is unverified end-to-end.
    recommendation: >
      Run one live 'python3 draft_replies.py --push --broad --limit 1', verify it threads
      correctly in Outlook and nothing lands in Sent, then bootstrap the launchd job.
    verify: "one reply draft appears in Outlook Drafts, correctly threaded; Sent unchanged"
  - id: F8
    severity: minor
    category: hygiene
    title: No CI; 1 ESLint error + 3 warnings uncaught
    detail: >
      No CI pipeline. eslint archive-worker/ reports 1 error (no-nested-ternary) and 3
      require-await warnings. Nothing enforces lint or tests before the launchd job runs
      new code.
    recommendation: "Fix the lint error; add a pre-push or pre-commit hook running jest + eslint."
    verify: "eslint exits clean; hook blocks a failing commit/push"
  - id: F9
    severity: minor
    category: observability
    title: Archive launchd job logs to /dev/null
    detail: >
      com.davidbasseal.email-assistant-archive sends stdout/stderr to /dev/null. Diagnosis
      of the failure notifications was only possible via the app's own scheduled.jsonl.
    recommendation: "Point StandardOut/ErrorPath at a rotating log file under the archive logs dir."
    verify: "log file receives run output; errors are inspectable without re-running"
  - id: F10
    severity: minor
    category: reliability
    title: Refresh-token ~90-day expiry is a silent single point of failure
    detail: >
      Delegated refresh token expires ~90 days after issue; expiry makes every Graph job
      fail at once. job_health sees the symptom, not the impending expiry.
    recommendation: "Add a proactive check that warns N days before refresh-token expiry."
    verify: "a near-expiry token produces a warning before jobs start failing"
strengths:
  - 946 passing tests (outlook-assistant); command-centre self-tests all pass.
  - Per-message routing isolation fix verified in prod (last 8 runs completed, notifications stopped).
  - Content-addressed blob store with dedup + hash verification + 0600/0700 perms.
  - Deterministic tiering with enforced GREEN-only frontier egress (EgressRefused before network).
  - Local-first LLM posture; sensitive content never leaves the Mac.
  - Path-traversal delivery vulnerability found and fixed (basename + containment guard) this session.
work_done_this_session:
  - "Security review: found+fixed attachment-filename path traversal (commit 0a56564)."
  - "Built draft-reply capability (spec+plan under docs/superpowers/; code in command-centre, untracked)."
  - "Root-caused the failure notifications; shipped per-message isolation + backfill scanner (commit 8bcee29)."
  - "Backfill of unscanned attachments running detached; ~10k/23k scanned at assessment time."
priority_order: [F1, F2, F3, F7, F4, F5, F6, F9, F8, F10]
---

# Production-Readiness Assessment — Local Email Archive + Draft-Reply System

**Date:** 2026-07-23 · **Type:** adversarial review · **Overall:** functional and running,
but not production-grade for the data it holds (~60% maturity). The gap is recoverability
and version control, not correctness.

This file has a machine-readable YAML block above (schema `email-assistant.assessment.v1`)
containing every finding with `id`, `severity`, `category`, `detail`, `recommendation`, and
`verify`. The prose below is the human summary. A downstream LLM should treat the YAML
`findings` array as the work list and `priority_order` as the sequence.

## Verdict

The system is genuinely well-engineered and is running reliably in production right now
(the last eight scheduled runs completed and the failure notifications have stopped). It is
**not** production-grade by conventional standards for a platform storing litigation
evidence, client CRM, and financial records — because of three blocking gaps that are all
about resilience and recoverability rather than whether the code is correct.

## Blocking (fix before "production")

- **F1 — `command-centre` has no version control.** The ledger, the tiering safety gate,
  egress, and the Hannibal/Reggie brains have no git history, rollback, or code backup. The
  most trust-critical subsystem is the least auditable. **Top priority.**
- **F2 — production runs uncommitted working-tree code.** launchd runs the working tree,
  which carries ~194 lines of uncommitted changes to core modules. What is running has no
  recorded version.
- **F3 — nothing is pushed to a remote.** 54 commits ahead of the fork, unpushed. With F1
  and F2, one disk failure loses everything.

## Serious

- **F4 — delivery backlog** (43 rejected / 53 non-delivered) with no automatic re-drive
  once the backfill clears the unscanned-attachment blocker.
- **F5 — triage bulk-mail veto is inert** because List-Unsubscribe/List-Id headers are not
  captured; newsletters can be misrouted.
- **F6 — prompt-injection is an accepted risk, not solved.** Fencing is a mitigation only.
- **F7 — the draft-reply feature is built but not activated or prod-verified.**

## Minor

- **F8** no CI; 1 ESLint error + 3 warnings. **F9** archive job logs to `/dev/null`.
  **F10** refresh-token 90-day expiry is a silent single point of failure.

## Strengths (do not regress)

946 passing tests; the per-message isolation fix (verified in prod); content-addressed
storage with dedup and hash verification; deterministic tiering with enforced GREEN-only
egress; local-first LLM posture; the path-traversal fix landed this session.

## Guidance for the downstream LLM

1. Start with **F1–F3** (recoverability) — highest leverage, ~1 hour, removes all three
   blocking risks. For F1, propose the `.gitignore` (exclude tokens, secrets, `*.sqlite3`,
   raw-message/attachment blobs, the vault) and the file list to the owner **before** the
   first commit. Never commit secrets or mailbox data.
2. Then **F7** (verify + activate draft-replies) and **F4** (delivery re-drive) once the
   attachment-scan backfill has finished.
3. **F5, F6** are design changes — brainstorm with the owner before building; F6 touches the
   Phase-1 no-autonomous-outbound-from-inbound constraint and must not be weakened.
4. Respect the existing conventions: `unittest` (not pytest) in command-centre; `Edit` not
   `Write` for `docs/faq/faq.md` (a protected file); do not delete `docs/faq/`.
5. Post-op: append your outcomes per finding (`fixed` / `skipped` / `no_change_needed`) so
   the loop is auditable, and re-run the `verify` line for each finding you touch.
