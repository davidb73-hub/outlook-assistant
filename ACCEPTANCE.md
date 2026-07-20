# Email Assistant Acceptance Tests

**Status:** Approved for implementation on 2026-07-18  
**Applies to:** Phase 1 deterministic local email archive  
**Last updated:** 2026-07-18

## Evidence rules

Each test must record:

- date and environment;
- command or operator action;
- sanitized observed result;
- pass/fail status;
- linked defect when failed;
- hashes or counts where required.

Email bodies, tokens, credentials, private attachment contents, and unnecessary personal identifiers must not appear in committed evidence.

Unit tests alone cannot satisfy a live, backup, restore, timing, or clean-install criterion.

## A. Clean installation and repository quality

### A1. Clean fixture installation

From a clean checkout with no existing archive directory or credentials:

- dependency installation succeeds from documented commands;
- the empty schema is created through migrations;
- fixture ingestion and search tests pass;
- no file is written outside documented test/temp locations;
- no live mailbox access is attempted.

### A2. Quality gates

- all automated tests pass;
- lint passes with zero errors;
- formatting check passes;
- no skipped test covers a required Phase 1 behavior;
- the public npm package dry-run excludes private archive code, live data, tokens, and private documentation.

### A3. Secret and private-data containment

Automated checks and manual inspection confirm that Git does not contain:

- OAuth access or refresh tokens;
- client secrets or private keys;
- `.mcp.json` live configuration;
- email bodies or private EML fixtures;
- live SQLite databases;
- live attachments;
- raw runtime logs containing private content.

## B. Database and storage integrity

### B1. Schema lifecycle

- a new database migrates from version zero to current;
- every migration is ordered and recorded;
- rerunning migrations is safe;
- an older supported fixture database upgrades without data loss;
- an incompatible schema fails loudly rather than continuing.

### B2. Atomic message commit

Simulate interruption during metadata, raw-message, attachment, and final-status writes. After restart:

- no partial record is reported as `archived_complete`;
- verified work is retained;
- incomplete work is retryable;
- database integrity check passes.

### B3. Idempotency

Ingest the same provider message repeatedly:

- one logical message record exists per account/provider identity;
- folder/label state updates correctly;
- raw content is not duplicated;
- attachment content is not duplicated;
- ingestion attempts remain auditable.

### B4. Content-addressed attachments

- identical attachment bytes from multiple messages produce one stored blob;
- each message retains its own relationship and original filename metadata;
- changed bytes produce a different hash;
- stored bytes match the recorded SHA-256 hash;
- unsafe filenames cannot escape the archive directory.

### B5. Full-text search

Fixture searches find messages by subject, body text, sender, recipient, account, and date. Account filters prevent unintended cross-account results.

## C. Provider behavior

### C1. Account isolation

For VitaSci Outlook, Ablative Gmail, and Personal Gmail:

- credentials and cursors are distinct;
- provider identifiers cannot collide across accounts;
- errors in one account do not advance another account's checkpoint;
- an account-scoped query returns only that account.

### C2. Folder and label inclusion

Fixture and live sanitized evidence show import from:

- Inbox;
- Sent;
- Archive;
- at least one custom folder or label where present.

### C3. Exclusion policy

Drafts, Spam/Junk, and Trash/Deleted Items are not imported during initial or incremental discovery.

### C4. Remote deletion retention

When a previously archived fixture or controlled test message is reported deleted or moved into an excluded state:

- archived content remains;
- a tombstone/change event is recorded;
- the record is no longer presented as currently eligible;
- no local purge occurs.

### C5. Outlook incremental sync

- a controlled new Outlook message is discovered from the correct checkpoint;
- content and attachments are verified;
- the checkpoint advances only after successful commit;
- repeated sync produces no duplicate;
- expired/invalid delta state follows a documented safe recovery path.

### C6. Gmail incremental sync

Run C5-equivalent tests independently for Ablative Gmail and Personal Gmail, including Gmail history/checkpoint expiry recovery.

### C7. Authentication recovery

Expired access tokens refresh without losing sync state. Revoked/invalid credentials stop only the affected account, preserve its last safe checkpoint, and produce a plain-English recovery instruction without printing secrets.

### C8. Throttling and transient failure

Simulated and live provider throttling/network failures:

- use bounded retry/backoff;
- do not spin continuously;
- do not advance unsafe checkpoints;
- resume without duplication;
- remain visible in operator status.

## D. Historical backfill and reconciliation

### D1. New-mail priority

While a historical fixture backfill is active, a newly arriving incremental fixture is archived before the next historical batch completes.

### D2. Resumable backfill

Interrupt and restart each provider backfill. It resumes from the recorded position without starting over or duplicating verified content.

### D3. Adaptive Personal Gmail import

Personal Gmail backfill:

- starts newest-first;
- records processed and remaining estimates;
- adapts to throttling;
- checkpoints every batch;
- can be paused and resumed safely;
- does not prevent new-message sync.

### D4. Complete reconciliation

For every account, compare the provider's eligible inventory with the archive:

- every eligible item is archived, or
- an explicit error identifies the missing item and required recovery.

Phase 1 cannot be called complete while unexplained reconciliation differences remain.

## E. Scheduling and operations

### E1. Scheduling target

With the Mac awake and network/provider available, the scheduler starts within the approved polling interval. The proposed interval is 15 minutes.

### E2. Archival latency

Measure at least 20 controlled ordinary messages across the three providers. Report median, 95th percentile, and maximum time from provider receipt to verified local archival. Results must be compared with the approved service target; estimates are not evidence.

The approved target is median ≤10 minutes, p95 ≤20 minutes, and maximum ≤30
minutes while the Mac is awake and online. Large attachments, provider
outages, and a sleeping Mac are outside this ordinary-message target.

### E3. Large attachment behavior

A controlled large attachment does not block unrelated messages. Status distinguishes message preservation from pending attachment completion and retries safely.

### E4. Sleep and restart recovery

After macOS sleep, application restart, and machine restart:

- missed work is discovered;
- no overlapping worker corrupts state;
- no item duplicates;
- status reports the recovery.

### E5. Unattended run

Run for 72 hours with scheduled sync enabled:

- no silent provider failure;
- no duplicate logical messages;
- no overlapping worker;
- no database-integrity failure;
- no uncontrolled log growth;
- no secrets or bodies in routine logs.

## F. Backup and recovery

### F1. Consistent encrypted backup

- backup uses a transactionally consistent SQLite snapshot;
- raw messages and attachments are included;
- backup is encrypted before or during transfer;
- live data is not operated from the OneDrive sync directory;
- a manifest records counts and hashes.

### F2. Incremental deduplication

Running backup twice without source changes transfers/stores no unnecessary full duplicate. Adding one fixture message results in an incremental backup.

### F3. Clean restore from VitaSci OneDrive

Restore into an empty temporary location using documented commands:

- SQLite integrity check passes;
- migrations recognise the restored schema;
- account/message/attachment counts match the manifest;
- sampled raw messages and attachments match hashes;
- full-text search returns expected results.

### F4. Recovery documentation

A non-developer can follow the runbook to identify the latest successful backup, restore it, verify it, and locate a known message without relying on undocumented knowledge.

## G. Safety boundaries

### G1. Read-only provider permissions

The archival service exposes no send, draft, move, label, mark-read, or delete operation. Its Gmail access is read-only. Outlook permissions are documented; if broader existing permissions remain necessary for the separate MCP server, the archive code still has no mutation path.

### G2. No LLM dependency

With Ollama, the Local LLM gateway, and all cloud LLMs unavailable:

- ingestion works;
- incremental sync works;
- backfill works;
- search works;
- reconciliation works;
- backup and restore work.

### G3. Untrusted content

- HTML is stored without executing scripts;
- attachments are never automatically opened or executed;
- path traversal and unsafe filename fixtures are contained;
- parsing failures are isolated and retryable;
- email content cannot alter system instructions or archival policy.

## H. Final demonstration

The owner observes a clean-install demonstration that:

1. creates an empty archive;
2. ingests fixtures;
3. connects each live account without exposing credentials;
4. archives one controlled message per provider;
5. retrieves a message through local search;
6. demonstrates idempotent rerun;
7. shows account progress and reconciliation;
8. creates an encrypted OneDrive backup;
9. restores and verifies the archive in an empty location.

All acceptance evidence is recorded and every required test passes before completion is claimed.
