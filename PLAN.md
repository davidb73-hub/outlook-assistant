# Email Assistant Delivery and Recovery Plan

**Status:** Approved for implementation on 2026-07-18  
**Depends on:** `PRODUCT.md`, `ACCEPTANCE.md`, and the approved replacement `AGENTS.md`  
**Last updated:** 2026-07-18

## Current execution status

- Stage 0: governance and preservation safeguards implemented; owner-approved
  keep/move/remove cleanup of unrelated existing repository material remains
  pending, so the repository-hygiene gate is not complete.
- Stages 1-3: implemented; controlled live ingestion passed for all three
  accounts.
- Stage 4: technically reconciled, but the two Gmail credential identities are
  currently assigned to the wrong account labels. Historical Gmail totals must
  be remapped and re-verified before this stage can be accepted.
- Stage 5: paused after the Gmail identity mismatch was discovered. The
  LaunchAgent remains installed but must not resume until account mapping is
  corrected and reconciled.
- Stage 6: implemented; corrected encrypted backup snapshot, full repository
  check, and 34,894-blob clean restore passed. The post-remap snapshot is now
  visible through the Microsoft cloud API alongside older off-device snapshots.
- Stage 7: final credential-free clean installation passed with 51 suites and
  870 tests; owner-controlled live timing/deletion demonstrations and elapsed
  operational tests remain pending in `docs/acceptance-evidence-2026-07-18.md`.

## Delivery principle

Reliable archival comes before AI processing. Each stage must produce a usable, testable result and must not depend on a later stage.

## Stage 0 — Recover and govern the repository

### Objective

Create a safe development baseline without losing current uncommitted work or mixing generated tooling, private evidence, and product code.

### Work

1. Record a complete inventory of tracked modifications and untracked files.
2. Preserve intentional product work on a local recovery branch before removing or relocating anything.
3. Separate the following classes of material:
   - upstream Outlook MCP product code;
   - private archive/triage application code;
   - generated agent-framework files;
   - runtime databases and coverage output;
   - credentials and local MCP configuration;
   - private email/evidence artifacts;
   - CRM/KMS design material that belongs in another repository.
4. Propose an explicit keep, move, ignore, or remove action for each class.
5. Remove or relocate material only after owner approval and only after preservation is verified.
6. Replace the inaccurate generated `AGENTS.md` with the approved project-specific version.
7. Restore repository-wide lint and formatting gates so generated local tooling cannot break product checks.
8. Establish a descriptive working branch based on the intended private product, not the stale Phase 0 branch name.

### Recovery recommendations

| Material | Recommended treatment |
|---|---|
| Existing Outlook multi-account changes | Preserve and integrate deliberately |
| `local-worker/` prototype and tests | Preserve as evidence; refactor rather than discard |
| `.agents/`, `.claude-flow/`, `.swarm/` generated frameworks | Move outside product or remove after preservation; do not ship |
| `.claude/*.db`, `ruvector.db`, coverage output | Treat as runtime state; remove from product tree and ignore |
| `.mcp.json`, token files, Gmail token state | Keep local only; ensure ignored and never print secret values |
| `.eml`, corpus, and private evidence files | Relocate to controlled data storage; do not commit |
| duplicated VitaSci CRM/KMS prompt | Relocate to the separate CRM/KMS repository |
| old orchestration package | Archive as historical planning evidence or remove after extracting valid decisions |

### Gate

- No current intentional change is lost.
- The proposed cleanup list is approved.
- Product tests pass.
- Lint and formatting checks apply to product files and pass.
- Git status contains only intentional, explained work.

## Stage 1 — Archive foundation

### Objective

Create the private archival application boundary and durable local storage.

### Work

1. Add a private archive module that is excluded from the public npm package allowlist.
2. Define configuration for the three named account profiles and the external data root.
3. Add versioned SQLite migrations for:
   - schema versions;
   - accounts;
   - folders and labels;
   - messages and provider identifiers;
   - recipients;
   - message locations;
   - raw source objects;
   - attachments and message relationships;
   - sync cursors/checkpoints;
   - ingestion runs and failures;
   - deletion tombstones;
   - processing queue state reserved for later phases.
4. Add SQLite full-text search over safe normalised message fields.
5. Add managed raw-message and attachment stores using SHA-256 content addressing.
6. Enforce owner-only permissions and atomic writes.

### Dependencies

- Stage 0 complete.
- SQLite driver selected through a short compatibility/security evaluation.
- External data directory approved and writable.

### Gate

- Schema installs and migrates from an empty directory.
- Fixture messages can be committed, searched, deduplicated, and verified.
- Interrupted writes leave no falsely complete records.

## Stage 2 — VitaSci Outlook vertical slice

### Objective

Prove one end-to-end incremental archival path using existing Outlook work.

### Work

1. Reuse the existing token/authentication implementation without exposing tokens.
2. Build a deterministic Graph connector rather than driving archival through an LLM.
3. Enumerate eligible Outlook folders and exclude Drafts, Junk, and Deleted Items.
4. Import message metadata, bodies, original MIME where available, and attachments.
5. Persist and resume Graph delta/checkpoint state.
6. Record moves, updates, and deletion tombstones without purging archived content.
7. Reconcile provider counts with local eligible records.

### Gate — smallest usable increment

- One live message and its attachments archive successfully.
- The record is searchable locally.
- A repeated sync creates no duplicates.
- A controlled interruption resumes safely.
- A backup restores the same message and verified hashes.

## Stage 3 — Gmail connector and account isolation

### Objective

Add Ablative Gmail and Personal Gmail without cross-account leakage.

### Work

1. Reuse the existing read-only Gmail OAuth/provider prototype where sound.
2. Enumerate Gmail labels and exclude Drafts, Spam, and Trash.
3. Preserve raw MIME, thread IDs, labels, recipients, and attachments.
4. Use Gmail history/checkpoint mechanisms for incremental changes, with a safe reset path when history expires.
5. Prove credentials, cursors, errors, and records remain isolated per account.

### Gate

- Both Gmail accounts independently pass incremental, retry, deduplication, exclusion, attachment, and reconciliation tests.
- No query or report mixes records across accounts unless explicitly requested.

## Stage 4 — Resumable historical backfill

### Objective

Archive all available eligible history without delaying new mail.

### Work

1. Run newest-first backfill separately for each account.
2. Give new incremental email priority over backfill batches.
3. Checkpoint every batch and record progress, throttling, failures, and estimates.
4. Adapt batch size to provider throttling and attachment volume.
5. Never re-download verified content.
6. Reconcile eligible provider inventory with local records at completion.

### Sequence

1. VitaSci Outlook
2. Ablative Gmail
3. Personal Gmail

Personal Gmail may continue for multiple days. This does not block ongoing incremental archival.

### Gate

- All eligible provider records are either archived or represented by an explicit, actionable error.
- Reconciliation differences are zero or individually explained and approved.

## Stage 5 — Scheduling and operations

### Objective

Operate reliably without a developer present.

### Work

1. Add a macOS `launchd` schedule, proposed at 15-minute intervals.
2. Prevent overlapping runs with a recoverable lock.
3. Catch up safely after sleep, restart, network loss, or missed schedules.
4. Expose plain-English status, account progress, last success, backlog, and errors.
5. Add integrity checks, bounded logs, and failure notifications that contain no email bodies.
6. Add an operator runbook for authentication, pause/resume, reconciliation, repair, and recovery.

### Gate

- A 72-hour unattended run completes without duplicate records, overlapping workers, silent failure, or secret/PII leakage in logs.

## Stage 6 — Encrypted OneDrive backup and restore

### Objective

Make the archive recoverable after local disk or database loss.

### Work

1. Create transactionally consistent SQLite snapshots.
2. Configure Restic encryption and deduplication.
3. Store the Restic repository in the existing VitaSci OneDrive desktop mount without placing the live database in the sync folder. Rclone is deferred because a second transfer client would be redundant on this Mac.
4. Store backup credentials in macOS Keychain.
5. Define retention after measuring archive growth.
6. Automate integrity checks and restore drills.

### Gate

- Restore into an empty temporary location from OneDrive.
- Database integrity passes.
- Sample raw messages and attachments match recorded hashes.
- Search results and account counts match the backup manifest.

## Stage 7 — Clean-install demonstration and Phase 1 sign-off

### Objective

Prove the system can be reproduced and operated from documented instructions.

### Work

1. Install from a clean checkout into an empty environment.
2. Run all fixture tests without live credentials.
3. Configure live data and credentials using documented local-only steps.
4. Demonstrate one incremental sync per provider.
5. Demonstrate reconciliation, search, status, backup, and restore.
6. Record sanitized evidence against every test in `ACCEPTANCE.md`.

### Gate

Every applicable acceptance test passes. No required criterion is waived or replaced with a claim.

## Deferred delivery plan

Only after Phase 1 sign-off:

1. Define and evaluate local-LLM processing contracts.
2. Produce separate Obsidian account memory at 7:00 am and 7:00 pm Australia/Sydney.
3. Route financial records to Financial-Assistant.
4. Route VitaSci records to the separate CRM/KMS.
5. Add other destinations through explicit contracts and approval gates.

## Actions intentionally not authorised by this plan

- sending, drafting, moving, labelling, marking read, or deleting live email;
- deleting current repository material before preservation and approval;
- pushing branches or publishing packages;
- writing into Financial-Assistant, Obsidian, CRM/KMS, or OneDrive before the applicable stage is approved;
- claiming completion before clean-install acceptance evidence exists.
