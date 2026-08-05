# Email Archive Operations Runbook

**Audience:** owner/operator; no development knowledge assumed  
**Scope:** deterministic Phase 1 archive only  
**Live archive:** `/Users/davidbasseal/Library/Application Support/Email Assistant Archive/`

## Current safety state — 2 August 2026

The archive LaunchAgent is persistently disabled. Leave it disabled. The plist
has been preserved, but `launchctl` has no active service and there is no worker
or lock. One final `gmail-ablative` run row still says `running`; do not edit it
by hand. The reviewed recovery path will mark it interrupted immediately before
an approved live operation.

Do not run `archive:sync`, `archive:reconcile`, the schedule installer, or a
manual `launchctl enable` yet. Before owner approval, safe work is limited to
read-only identity/evidence checks, the dedicated schema-preserving backup and
exact restore, a read-only live plan, and a new-directory rehearsal of that
exact plan. The historical Gmail whole-account swap must not be run.

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
npm run archive:identity-status
npm run archive:acceptance-status
npm run archive:verify
npm run archive:backup-status
```

`archive:status` shows each account's archived, complete, pending-attachment,
and tombstone counts plus recent runs and unresolved errors. `archive:verify`
checks SQLite integrity and every recorded content hash. These commands do not
modify a mailbox.

`archive:identity-status` does not open or migrate the archive database. It
asks each provider for its authenticated profile, compares that profile with
explicit logical-account configuration, and prints only account labels,
booleans, timestamps, and safe error codes. Audit-only token refreshes stay in
memory and are not saved. The command exits non-zero if Outlook or either Gmail
account is missing, unproved, or mismatched.

The mandatory runtime keys are:

```text
EMAIL_ARCHIVE_OUTLOOK_EXPECTED_IDENTITY
EMAIL_ARCHIVE_GMAIL_ABLATIVE_EXPECTED_IDENTITY
EMAIL_ARCHIVE_GMAIL_PERSONAL_EXPECTED_IDENTITY
```

Runtime retrieval uses only these explicit logical keys. Gmail credential slot
`personal` supplies logical Ablative, and slot `ablative` supplies logical
Personal; the old slot names are not identity evidence.

For the one-time bootstrap, use the verified 18 July anchor database. The first
command is a dry run and does not change `.env` or save refreshed tokens:

```bash
npm run archive:seed-identities -- \
  --anchor-db /path/to/verified-anchor/archive.sqlite3
```

The command privately probes both Gmail slots and delegated Graph `/me`, then
requires each candidate to match deterministic historical archive ownership.
Optional legacy expected-address keys are cross-checks only. It never prints an
address or token. After reviewing a passing dry-run report, the explicit owner
apply is:

```bash
npm run archive:seed-identities -- \
  --anchor-db /path/to/verified-anchor/archive.sqlite3 \
  --apply --confirm-verified-bindings
```

Apply preserves comments and unknown keys, atomically replaces `.env`, and
sets mode `0600`. If an existing target disagrees, the command refuses instead
of overwriting it.

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

Outlook uses the repository's existing delegated read token. Before folders,
messages, or cursors are touched, Graph `/me` `mail`/UPN must match the explicit
logical Outlook identity. A refreshed token is saved only after that proof. If
status reports that Outlook authentication is required, use the existing
Outlook device-code authentication flow. Do not paste tokens into documentation,
chat, Git, or logs.

Gmail uses read-only OAuth tokens stored under `local-worker/state/` with
owner-only file permissions. Re-authorise one account with:

```bash
npm run triage:gmail-auth -- ablative
npm run triage:gmail-auth -- personal
```

The command argument names a credential slot, not proof of the mailbox behind
it. A legacy `GMAIL_*_EXPECTED_EMAIL` may protect reauthorisation, while archive
runtime uses the independent `EMAIL_ARCHIVE_GMAIL_*_EXPECTED_IDENTITY` keys.
The browser prompts for an account, and the worker reads the resulting Gmail
profile before saving the token. A mismatch is rejected without replacing the
previous token.

Authentication failure preserves the last safe cursor. Re-running sync after
reauthorisation resumes without intentionally starting over.

## Scheduling

The commands below describe the normal mechanism, but are currently blocked by
the safety state above. Resuming is a deliberate two-part action: first remove
launchd's persistent disabled flag, then run the reviewed installer. Do neither
until the live repair, reconciliation, backup, restore, and identity gates pass.

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
Account, reconciliation, and backup failures request one content-free macOS
notification when a new failure state appears. Repeated cycles with the same
failure are logged but suppressed. The notification opens Command Centre; the
first fully healthy cycle sends one recovery notice. A routine overlap rejected
by the single-writer lock is logged but does not create a notification.

## Downstream commissioning remains blocked

Phase 1 scheduling must keep
`EMAIL_ARCHIVE_DOWNSTREAM_DELIVERY_ENABLED=false`. The confirmed Command Centre
brief directory is:

```text
/Users/davidbasseal/Developer/Assistant-Vault/30-Business/Email-Briefs
```

That path match is not a delivery contract. The current consumer does not write
a receipt and does not independently verify the package name, manifest digest,
or raw hashes before using a package. Email Assistant also has no configured
`hannibal-briefs` receipt root. A local filesystem copy or synthetic adapter
test therefore cannot prove Command Centre acceptance. Fixing the consumer is a
separate cross-repository change requiring owner approval; do not edit Command
Centre as part of Phase 1 archival remediation.

## Encrypted OneDrive backup

The live database remains outside OneDrive. Restic creates a consistent SQLite
snapshot, encrypts and deduplicates the archive, and writes its repository to:

```text
rclone:onedrive-vitasci:Email Assistant Archive Backup
```

Restic reaches OneDrive through the existing Rclone remote. This bypasses the
macOS FileProvider mount, whose background reads can fail with `EDEADLK`
(`resource deadlock avoided`). The live archive and Restic cache remain local.

The randomly generated Restic password is held in macOS Keychain under service
`Email Assistant Archive Restic`. It must not be copied into the repository.

Create and verify a backup:

```bash
npm run archive:backup
npm run archive:backup-status
```

The `onedrive-vitasci` Rclone remote must remain authenticated. Restic performs
client-side encryption before Rclone transfers repository objects to OneDrive.
The backup command first asks Restic to read the remote repository config. Any
failure is treated as ambiguous and stops the backup; it never automatically
runs `restic init` against a remote. Initialising or replacing a remote
repository is a separate, explicitly reviewed operator action.

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
usable. Because the repository is addressed directly through Rclone, a completed
backup means Restic has finished writing its encrypted objects to OneDrive.

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

## Owner-gated Gmail targeted repair

This is a one-time recovery workflow, not a normal archive command. Ordinary
commands—including `archive:init`, `archive:backup`, and `archive:restore`—are
blocked from opening an existing schema-7 live archive because their normal
database constructor would silently migrate it. Leave launchd persistently
disabled throughout every step below.

### 1. Create and exactly restore a fresh pre-repair backup

Choose a new empty temporary restore directory. The receipt must be a new
`pre-repair-restore-*.json` file under the live `manifests/` directory:

```bash
npm run archive:pre-repair-backup -- \
  --live-root "/Users/davidbasseal/Library/Application Support/Email Assistant Archive" \
  --restore-target /private/tmp/email-archive-pre-repair-restore-... \
  --receipt-output "/Users/davidbasseal/Library/Application Support/Email Assistant Archive/manifests/pre-repair-restore-....json" \
  --confirm-schema-preserving-backup
```

This command acquires the archive lock before opening SQLite, verifies the
existing Keychain password and encrypted Restic repository before replacing the
current snapshot, creates a schema-7 snapshot, restores that exact Restic
snapshot, and verifies database hash, counts, integrity, foreign keys, FTS, and
every blob. It tests migration recognition only on a disposable copied database.
The retained restore and live database remain schema 7 and manifest-identical.
The command refuses to overwrite an existing receipt.

The restore contains `migration-recognition.sqlite3`, a disposable schema-11
copy of the retained schema-7 database. To make the self-contained rehearsal
root, copy that file and the retained manifest inside the same restored root;
do not hard-link them and do not point at live content:

```bash
cp /private/tmp/email-archive-pre-repair-restore-.../migration-recognition.sqlite3 \
  /private/tmp/email-archive-pre-repair-restore-.../archive.sqlite3
cp /private/tmp/email-archive-pre-repair-restore-.../snapshots/current/manifest.json \
  /private/tmp/email-archive-pre-repair-restore-.../manifest.json
chmod 600 \
  /private/tmp/email-archive-pre-repair-restore-.../archive.sqlite3 \
  /private/tmp/email-archive-pre-repair-restore-.../manifest.json
```

The resulting temporary root must contain `archive.sqlite3`, `manifest.json`,
`raw-messages/`, and `attachments/`. Symlinks, hard links, a live database
inode, a separate content root, a non-temporary path, or non-empty WAL state are
refused.

### 2. Generate the immutable live plan without writing the archive

Write the private plan outside both Git and the live archive. Supply the exact
fresh snapshot and restore receipt from step 1 and the verified 18 July anchor:

```bash
npm run archive:live-gmail-repair -- \
  --live-root "/Users/davidbasseal/Library/Application Support/Email Assistant Archive" \
  --anchor-db /private/tmp/email-archive-anchor-.../snapshots/current/archive.sqlite3 \
  --source-snapshot-db "/Users/davidbasseal/Library/Application Support/Email Assistant Archive/snapshots/current/archive.sqlite3" \
  --pre-repair-restore-receipt "/Users/davidbasseal/Library/Application Support/Email Assistant Archive/manifests/pre-repair-restore-....json" \
  --plan-output /private/tmp/email-archive-reviewed-live-plan-....json
```

Planning opens the live, snapshot, and anchor databases read-only with SQLite
`query_only`; it does not acquire the apply lock, migrate schema, or write the
archive. Review the content-free output, including action counts, provider-only
backlog, and `derivedStateToReset`. The latter reports Gmail folder and cursor
rows that will be preserved in provenance and then cleared so reconciliation
can rebuild them under proved identities. The exact 64-character plan digest
is the value the owner approves. Plans and evidence expire after 24 hours.

### 3. Rehearse that exact live plan on the restored clone

First run the exact plan in read-only mode, then independently recollect all
provider evidence and apply only to the clone:

```bash
npm run archive:rehearse-gmail-repair -- \
  --clone-root /private/tmp/email-archive-pre-repair-restore-... \
  --content-root /private/tmp/email-archive-pre-repair-restore-... \
  --anchor-db /private/tmp/email-archive-anchor-.../snapshots/current/archive.sqlite3 \
  --plan-input /private/tmp/email-archive-reviewed-live-plan-....json

npm run archive:rehearse-gmail-repair -- \
  --clone-root /private/tmp/email-archive-pre-repair-restore-... \
  --content-root /private/tmp/email-archive-pre-repair-restore-... \
  --anchor-db /private/tmp/email-archive-anchor-.../snapshots/current/archive.sqlite3 \
  --plan-input /private/tmp/email-archive-reviewed-live-plan-....json \
  --apply-rehearsal --confirm-clone-rehearsal
```

The apply rehearsal must bind to the exact live plan and precondition, recheck
all three identities, recollect both Gmail inventories, verify raw MIME, FTS,
counts, child rows, blobs, integrity and foreign keys, and prove a second
invocation is a no-op. A removal, ownership change, overlap, or collision stops
the rehearsal. Do not approve a plan produced by an earlier rehearsal: its
generation time gives it a different digest.

### 4. Record owner approval and apply once

Approval is generated as a separate owner-only file. It is accepted only when
the clone database contains a successful receipt for the same exact plan and
precondition:

```bash
npm run archive:approve-live-gmail-repair -- \
  --live-root "/Users/davidbasseal/Library/Application Support/Email Assistant Archive" \
  --plan-input /private/tmp/email-archive-reviewed-live-plan-....json \
  --clone-rehearsal-db /private/tmp/email-archive-pre-repair-restore-.../archive.sqlite3 \
  --approval-output /private/tmp/email-archive-owner-approval-....json \
  --approved-plan-digest <exact-64-character-plan-digest> \
  --approval-id owner-approval:email-repair-... \
  --approve-reviewed-plan
```

Never hand-edit the plan or approval. The live apply requires the exact warning
phrase and rechecks backup, restore, anchor, plan, approval, scheduler, process,
lock, identities, inventories, and database precondition before its one outer
transaction:

```bash
npm run archive:live-gmail-repair -- \
  --live-root "/Users/davidbasseal/Library/Application Support/Email Assistant Archive" \
  --anchor-db /private/tmp/email-archive-anchor-.../snapshots/current/archive.sqlite3 \
  --source-snapshot-db "/Users/davidbasseal/Library/Application Support/Email Assistant Archive/snapshots/current/archive.sqlite3" \
  --pre-repair-restore-receipt "/Users/davidbasseal/Library/Application Support/Email Assistant Archive/manifests/pre-repair-restore-....json" \
  --plan-input /private/tmp/email-archive-reviewed-live-plan-....json \
  --owner-approval /private/tmp/email-archive-owner-approval-....json \
  --live-confirmation APPLY_TO_LIVE_EMAIL_ARCHIVE_AND_KEEP_SCHEDULER_DISABLED \
  --apply
```

Migrations 8–11 and the repair commit or roll back together. Wrong-partition
copies move to a disabled forensic account; proved canonical rows move or have
false tombstones restored with immutable provenance; provider-only mail remains
guarded ingestion backlog. A permanent receipt makes every later invocation a
no-op and supersedes the historical whole-account swap.

The live apply deliberately does not sync, reconcile, back up, or resume
launchd. After a successful apply, keep the scheduler disabled. First rerun the
identity audit, then perform one guarded manual sync before the final full
reconciliation. This ordering matters: reconciliation fetches provider IDs that
are absent locally, but it does not retry the five known active messages whose
attachments are still pending. The guarded sync must clear those pending rows
and recover the stale running record through the tested transition. If status
still shows pending records or unresolved errors, stop; do not back up or claim
acceptance. Then run archive verification, sequential all-account
reconciliation, status and verification again, a new encrypted backup, and a
restore into another new empty directory. Any failure requires a written
recovery decision; never overwrite the live archive with a restore
automatically.

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
