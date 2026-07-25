# Email Archive Operations Runbook

**Audience:** owner/operator; no development knowledge assumed  
**Scope:** deterministic Phase 1 archive only  
**Live archive:** `/Users/davidbasseal/Library/Application Support/Email Assistant Archive/`

## What the system does

Every scheduled cycle checks VitaSci Outlook, Ablative Gmail, and Personal
Gmail for recent changes first, then processes a bounded batch of historical
mail. It stores original message bytes, searchable metadata, bodies, labels or
folders, and verified attachment bytes. Drafts, Spam/Junk, and Trash/Deleted
Items are excluded.

The system never sends, moves, labels, marks read, or deletes live mail. It
retains local content if a remote message is later deleted. Local LLMs are not
part of retrieval or archival integrity.

## Clean installation check

The normal locked installation commands are:

```bash
npm ci
npm ci --prefix archive-worker
```

This Mac currently has an unrelated permissions defect in its global npm
cache. If either command reports `EACCES` under `~/.npm`, do not use `sudo` and
do not overwrite that cache. Use the verified isolated-cache form:

```bash
npm_config_cache=/tmp/email-assistant-npm-cache npm ci
npm_config_cache=/tmp/email-assistant-npm-cache npm ci --prefix archive-worker
```

The acceptance demonstration used a new credential-free repository copy, an
empty external archive directory, and this isolated cache. It did not contact
any live mailbox.

## Normal checks

From the repository directory:

```bash
npm run archive:status
npm run archive:acceptance-status
npm run archive:verify
npm run archive:backup-status
```

`archive:status` shows each account's archived, complete, pending-attachment,
and tombstone counts plus recent runs and unresolved errors. `archive:verify`
checks SQLite integrity and every recorded content hash. These commands do not
modify a mailbox.

`archive:acceptance-status` is a privacy-safe progress report. It summarises
backfill and reconciliation completion, location-policy evidence, unresolved
error counts, passive latency samples, and unattended runtime. Passive latency
is labelled separately and never claims to replace the required controlled
20-message test. Its historical unattended totals retain earlier development
failures. `currentCleanWindow` starts again after the most recent failed cycle
and requires 72 elapsed hours, at least 288 completed 15-minute cycles, a recent
event, and zero malformed log lines before it reports the unattended test as
satisfied.

After the owner has created the approved controlled messages and recorded their
account IDs and provider message IDs in a temporary JSON file, measure the
sample without printing message content:

```bash
node archive-worker/index.js latency-report --input /path/to/private-latency-samples.json
```

The report passes only for exactly 20 unique, completely archived messages and
the approved median, p95, and maximum limits. Keep the input file outside Git
and delete it after the evidence is recorded.

Search locally without contacting a provider:

```bash
node archive-worker/index.js search "renewal"
node archive-worker/index.js search "invoice" --account gmail-personal
node archive-worker/index.js search --after 2026-07-01 --before 2026-08-01
```

Search output contains message metadata, not credentials.

## Manual sync and account isolation

Sync every account:

```bash
npm run archive:sync
```

Sync only one account:

```bash
node archive-worker/index.js sync --account vitasci-outlook
node archive-worker/index.js sync --account gmail-ablative
node archive-worker/index.js sync --account gmail-personal
```

A failed account does not advance its checkpoint or prevent later accounts
from running. New/recent mail is processed before the next historical batch.
Provider requests use bounded retry/backoff and a five-minute per-request abort
timeout. A timed-out item remains retryable; the safe page checkpoint does not
advance until that page succeeds.

After Gmail exhausts its bounded HTTP 429 retry budget, that account is reported
as `rate_limited` and the scheduled cycle as `degraded`. The worker stops making
requests to that mailbox for the current cycle, preserves its checkpoint,
continues the other accounts, and exits successfully so launchd does not
misreport provider throttling as a crashed worker. The rate limit remains
visible in `scheduled.jsonl` and is retried on the next 15-minute cycle. Gmail
authentication failures and other non-throttling errors remain `failed` and
produce a failing service exit code.

## Authentication recovery

Outlook uses the repository's existing delegated read token. If status reports
that Outlook authentication is required, use the existing Outlook device-code
authentication flow. Do not paste tokens into documentation, chat, Git, or
logs.

Gmail uses read-only OAuth tokens stored under `local-worker/state/` with
owner-only file permissions. Re-authorise one account with:

```bash
npm run triage:gmail-auth -- ablative
npm run triage:gmail-auth -- personal
```

Authentication failure preserves the last safe cursor. Re-running sync after
reauthorisation resumes without intentionally starting over.

## Scheduling

Install or refresh the 15-minute user scheduler:

```bash
npm run archive:schedule:install
```

The LaunchAgent label is:

```text
com.davidbasseal.email-assistant-archive
```

Its sanitized, size-bounded log is:

```text
/Users/davidbasseal/Library/Application Support/Email Assistant Archive/logs/scheduled.jsonl
```

After installing or refreshing the current LaunchAgent, unexpected process
stdout and stderr are retained separately instead of discarded:

```text
/Users/davidbasseal/Library/Logs/vitasci/email-assistant-archive.out.log
/Users/davidbasseal/Library/Logs/vitasci/email-assistant-archive.err.log
```

The Mac must be awake and online for an immediate run. Missed work is found on
the next run after sleep or restart. A process lock prevents overlapping runs.
After a successful sync, the same service creates an encrypted backup when the
last successful backup is at least 24 hours old. Backup failure makes that
service cycle visibly fail rather than silently leaving stale protection.
When an account's historical backfill becomes complete, the service
automatically runs a complete provider-to-archive reconciliation. It repeats
after a later backfill reset and at least weekly thereafter. A reconciliation
difference or error also makes the cycle visibly fail and prevents a fresh
backup from implying that the archive is complete.
Account, reconciliation, and backup failures also request a content-free macOS
notification telling the operator to run `npm run archive:status`. A routine
overlap rejected by the single-writer lock is logged but does not create a
notification.

## Encrypted OneDrive backup

The live database remains outside OneDrive. Restic creates a consistent SQLite
snapshot, encrypts and deduplicates the archive, and writes its repository to:

```text
/Users/davidbasseal/Library/CloudStorage/OneDrive-VitaSciConsulting/Email Assistant Archive Backup/
```

The randomly generated Restic password is held in macOS Keychain under service
`Email Assistant Archive Restic`. It must not be copied into the repository.

Create and verify a backup:

```bash
npm run archive:backup
npm run archive:backup-status
```

The OneDrive desktop client performs cloud transfer. Rclone is deliberately not
installed because running a second OneDrive transfer client adds configuration
and failure modes without adding an independent backup destination.

## Restore drill

Choose a new empty directory. Never restore over the live archive.

```bash
npm run archive:restore -- /tmp/email-archive-restored
```

The command restores the newest encrypted snapshot and verifies:

- SQLite integrity;
- the snapshot database hash;
- account, message, attachment, and blob counts;
- every stored raw-message and attachment hash.

An `ok: true` result proves that specific restored snapshot is internally
usable. It does not by itself prove that OneDrive has completed cloud upload;
confirm the OneDrive client is fully synchronised before treating an immediate
backup as off-device.

## Reconciliation

Reconciliation inventories every eligible provider message and can take hours
on a large mailbox:

```bash
npm run archive:reconcile
```

Do not interrupt it merely because the Personal Gmail account is slow. If it is
interrupted, already archived content remains safe; run it again. Phase 1 is
not complete while unexplained reconciliation differences remain.

If a deliberately tiny controlled test embedded an unsuitable page size in an
Outlook continuation link, reset only that historical checkpoint with:

```bash
node archive-worker/index.js backfill-reset --account vitasci-outlook --reason controlled-test-page-size
```

This does not delete archived content or touch the mailbox. The next cycle
restarts historical discovery newest-first, and idempotency prevents logical
duplicates. Do not use this command merely because a normal import is slow.

## What not to do

- Do not place the live archive inside OneDrive.
- Do not open or execute attachments automatically.
- Do not delete the archive directory to fix a sync problem.
- Do not remove a token or cursor unless a documented recovery step requires it.
- Do not claim completion from a successful unit test or a single sync.

Completion still requires every item in `ACCEPTANCE.md`, including the 72-hour
unattended run, measured 20-message latency sample, all-account reconciliation,
encrypted restore, and clean-install demonstration.

## Triage and delivery operations

The safe delivery sequence is:

```text
archive → security scan → deterministic/local-LLM triage → review or package
→ destination validation → delivery acknowledgement
```

Inspect queued deliveries with:

```bash
npm run archive:status
npm run archive:delivery-run
```

`archive:delivery-run` only processes packages with valid manifests and safe
attachment statuses. Missing packages, missing adapters, rejected content, and
retry exhaustion are written to the review state; they are never silently
discarded. Destination packages contain `original.eml`, unchanged attachments,
and `manifest.json` with source IDs and SHA-256 provenance.

If ClamAV is unavailable, attachment status is `scanner_unavailable` and the
item remains ineligible for downstream ingestion. Restore scanner availability
and rerun the security scan before retrying delivery.
