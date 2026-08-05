# Email Assistant Delivery and Recovery Plan

**Status:** Approved for implementation on 2026-07-18  
**Depends on:** `PRODUCT.md`, `ACCEPTANCE.md`, and the approved replacement `AGENTS.md`  
**Last updated:** 2026-08-02

## Current execution status

- Stage 0: governance and preservation safeguards implemented; owner-approved
  keep/move/remove cleanup of unrelated existing repository material remains
  pending, so the repository-hygiene gate is not complete.
- Stages 1-3: implemented historically, but every provider now requires a fresh
  profile-to-semantic-account guard before live retrieval. The new guards pass
  synthetic tests; all three explicit identities were atomically seeded
  owner-only and proved live in read-only mode at 2026-08-02T12:10:13Z. Tokens,
  the live database, and cursors were not written by that proof.
- Stage 4: **paused**. The verified 18 July Gmail whole-account correction is
  still right. A later wrong-binding interval created partition duplicates, so
  only the reviewed targeted repair may run. Repeating the whole-account swap
  is permanently prohibited after the targeted-repair receipt exists. The
  first database-only rehearsal clone was rejected by safety review. A fresh
  self-contained clone then proved that wrong-binding reconciliation also
  falsely tombstoned correct canonical rows and that new mail can arrive after
  the paused snapshot; no live repair was applied. Plan schema 2 and migration
  11 now model both conditions with explicit provenance. The corrected
  database dry run and apply rehearsal then passed on the verified clone:
  24,228 wrong copies were quarantined, 127 proved canonical rows moved, 24,186
  canonical tombstones restored, one provider-only message retained as guarded
  backlog, and the second invocation was a verified no-op. That rehearsal
  proved the algorithm. A fresh schema-preserving production snapshot
  `eeb38ba6…` then restored exactly with live schema 7 unchanged. The immutable
  final live plan (`1de8b927…`) was generated read-only and that exact plan
  passed dry-run and apply rehearsal on the restored clone: 48,541 planned
  changes, zero overlap, unchanged durable counts, integrity/FTS/foreign keys
  passed, and the second invocation was a no-op. The next gate is explicit
  owner approval of that exact digest; no live repair has run.
- Stage 5: **paused and persistently disabled in launchd**. The plist is
  preserved. One stale ingestion-run row remains `running` and must be recovered
  through the tested transition before any reviewed resume.
- Stage 6: fresh whole-tree source snapshot `8c74e8fa…` and schema-preserving
  archive snapshot `eeb38ba6…` were restored to new directories with matching
  manifests, hashes, modes, counts, integrity, FTS, and all 35,396 blob hashes.
  The live database remained schema 7 byte-for-byte while a disposable restore
  recognised schema 11. A new backup and clean restore remain mandatory after
  any live repair.
  Remote repository probe failure now stops safely and never falls through to
  automatic `restic init`; remote initialisation is a separate explicit
  operator action.
- Stage 7: **not accepted**. Current static, full-test, archive-test,
  clean-install, audit, secret-scan, formatting, lint, and package-boundary
  gates pass. Live apply/reconciliation/post-repair restore, controlled timing,
  deletion/move, sleep/restart, and 72-hour/288-cycle gates remain pending.

Downstream execution remains disabled for Phase 1. The Command Centre inbox
path is confirmed, but its actual receipt, manifest-digest, and raw-hash
consumer contract is not implemented. That cross-repository change requires a
separate owner-approved commissioning stage and must not be inferred from local
filesystem-copy tests.

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
8. Before any Graph folder, message, or cursor operation, compare delegated
   Graph `/me` identity with the explicit logical Outlook expectation and fail
   closed without archive writes on absence or mismatch.

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
6. Treat credential-slot labels as implementation detail. Require explicit
   logical-account expectations and verify `users/me/profile` before any Gmail
   folder, message, or cursor operation.

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
7. Keep launchd disabled until identity seeding, targeted repair, full
   reconciliation, post-repair backup/restore, and reviewed installation all
   pass.

### Gate

- A 72-hour unattended run completes without duplicate records, overlapping workers, silent failure, or secret/PII leakage in logs.

## Stage 6 — Encrypted OneDrive backup and restore

### Objective

Make the archive recoverable after local disk or database loss.

### Work

1. Create transactionally consistent SQLite snapshots.
2. Configure Restic encryption and deduplication.
3. Transfer the encrypted Restic repository through the existing VitaSci
   OneDrive Rclone remote without placing the live database in a sync folder or
   relying on the macOS FileProvider mount.
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
