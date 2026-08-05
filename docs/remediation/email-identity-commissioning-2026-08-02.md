# Email Identity and Commissioning Remediation — 2 August 2026

**Outcome:** `PAUSED_BLOCKED` (exact live plan rehearsed; owner approval required)
**Environment:** production Mac, Australia/Sydney
**Evidence cut-off:** 2026-08-02T15:56:55Z
**Privacy rule:** this report intentionally contains no mailbox addresses, tokens,
message identifiers, subjects, bodies, or attachment names.

## Plain-language verdict

The recovery gate now passes, and a privacy-safe live Gmail profile audit proved
the historical cross-binding: credential slot `personal` belongs to logical
Ablative, while slot `ablative` belongs to logical Personal. The historical
18 July whole-account correction remains right. A later interval inserted
wrong-partition duplicates, so repeating the old whole-account swap would
reverse good data. The required remedy is a targeted, transactionally verified
partition repair. That repair has not been applied to the live archive.

The fresh source and archive recovery gates now pass. The final schema-7 live
plan was generated read-only after that exact restore and written owner-only
outside Git and the archive. That same immutable plan then passed both dry-run
and apply on the restored self-contained clone, including independent provider
inventories and a durable second-invocation no-op. The live database remains
schema 7 and unmodified. The next gate is explicit owner approval of plan
digest `1de8b927…`; no approval file or live apply has been created.

The archive is still not acceptable for production. At preflight there were
344 unresolved errors (230 + 113 + 1) and 205 incomplete Gmail records. The
three explicit archive identity keys have now been atomically written to the
live `.env` at owner-only mode `0600`. A subsequent live, read-only identity
audit proved Outlook and both Gmail bindings at 2026-08-02T12:10:13Z. A second
privacy-safe audit passed at 2026-08-02T15:12:18Z, and plan/rehearsal evidence
re-proved the three bindings again. Any token refresh occurred in memory only:
token files, the live database, and cursors were not written.

The archive LaunchAgent was protectively paused at 2026-08-02T09:55Z and is now
persistently disabled in launchd. No mailbox was changed, no live archive
account was repaired or remapped, and the installed plist was preserved. No
worker or lock remains. The last `gmail-ablative` ingestion-run row still says
`running`; it has deliberately not been rewritten by an unreviewed live code
path. The reviewed recovery transition must mark it interrupted before resume.

## Repository baseline

| Item | Observed state |
|---|---|
| Git root | `/Users/davidbasseal/Developer/EMAIL-Assistant-Repos/outlook-assistant` |
| Branch | `feat/local-email-archive` |
| HEAD | `2ec1ac2fe64b1b1012f1b2079515fb09862fff59` |
| Upstream divergence | 4 commits ahead, 0 behind |
| Remote | Public GitHub repository; default branch `main` |
| Working tree | 17 modified tracked files and 1 untracked test at preflight |
| Current remediation tree | 32 modified tracked paths and 17 untracked paths; staging remains empty |
| Staging area | Empty at preflight |
| Deployment source | LaunchAgent directly executes this dirty working tree |

The existing modified and untracked files are owner work and are being
preserved. Nothing has been reset, stashed, cleaned, staged, pushed, or
published.

## Live service baseline

| Item | Observed state |
|---|---|
| LaunchAgent label | `com.davidbasseal.email-assistant-archive` |
| Node runtime | Pinned Homebrew Node 22 |
| Worker | `archive-worker/scheduled.js` in this repository |
| Working directory | This repository's dirty working tree |
| Interval | 900 seconds |
| Preflight service history | 75 launches; most recent recorded exit code 0 |
| State after safety action | Persistently disabled; launchctl lookup absent, no worker process, no lock |
| Plist | Preserved, owner-only, not edited or removed |
| SQLite integrity | `ok` |
| Automated archive gate | Failed |
| Unresolved errors | 344 total: 230 in one Gmail partition, 113 in the other, 1 in Outlook |
| Pending records | 204 in one Gmail partition, 1 in the other, 0 in Outlook |
| Last measured clean window | 20.30 hours and 72/288 cycles; not satisfied |

The last ten recorded account runs were marked completed, but this is not
accepted as identity evidence because the current runtime retrieves Gmail data
without first checking the authenticated provider profile against mandatory
expected identity configuration.

## Identity and inventory preflight

| Logical account | Credential slot | Expected identity | Latest identity proof | Local messages | Provider eligible evidence | Pending | Cursor rows / age | Latest successful run age |
|---|---|---:|---|---:|---:|---:|---:|---:|
| VitaSci Outlook | delegated Outlook credential | configured | passed again during final planning | 3,479 | 3,473 at last full reconciliation | 0 | 3 / 6.1 h | 6.1 h |
| Ablative Gmail | legacy slot `personal` | configured | passed again during exact rehearsal | 24,342 | 160 fresh | 204 | 3 / 6.3 h | 6.3 h |
| Personal Gmail | legacy slot `ablative` | configured | passed again during exact rehearsal | 24,258 | 24,212 fresh | 1 | 3 / 6.3 h | 6.3 h |

The opposite-looking Gmail credential-slot names are historical implementation
labels, not proof of an error. Current provider inventories are disjoint. All
24,060 anchor rows remain in their correct semantic partitions; a later wrong-
binding interval created additional wrong copies. The closest mandated
classification is **STATE C**, with the important qualification that the
historical whole-account remap must not be repeated. The targeted repair receipt
permanently supersedes that whole-swap mechanism.

One provider-deleted singleton was deterministically attributed to logical
Ablative using its preserved, hash-verified raw headers: inbound Inbox mail,
exact target in both `Delivered-To` and `To`, no other logical identity, and no
forwarding or resent headers. No address or message identifier is recorded here.

## Root cause

The semantic Gmail cross-binding was already correct: legacy credential slot
`personal` belongs to logical Ablative, and legacy slot `ablative` belongs to
logical Personal. The historical 18 July whole-account correction must not be
repeated.

The production defect was the absence of a mandatory provider-profile guard at
the archive write boundary. During a later interval, the worker could use a
valid read-only credential without first proving which semantic mailbox it
represented. That produced wrong-partition duplicates. Subsequent
reconciliation under the wrong binding also marked many correct canonical rows
as remotely deleted. This conclusion is supported by the immutable anchor,
disjoint current provider inventories, preserved raw evidence, and clone plan;
it is not inferred from the confusing credential-slot names.

## Recovery evidence completed

- Source snapshot `7573db…` restored with all 25,521 files and matching digests.
- After the implementation and macOS scheduler-parser correction stabilised, a
  new encrypted whole-tree source snapshot `8c74e8fa…` was restored exactly to
  `/private/tmp/email-source-postguard-restore-20260803.jO4W25`. All 25,474
  files, 3,056 directories, 58 symlink paths/targets, modes, and content hashes
  matched aggregate digest `46e16ea0…`; all 329 tracked, 32 modified-tracked,
  and 17 untracked manifests matched. Ignored owner material was included in
  the encrypted whole-tree comparison without printing its content.
- Current archive snapshot `fe829c…` restored into a new directory; database
  digest, counts, SQLite integrity, foreign keys, FTS, and all 35,396 blobs
  matched.
- The dedicated production workflow then created exact archive snapshot
  `eeb38ba6…`, restored that ID to
  `/private/tmp/email-archive-pre-repair-final-20260803.idAedV`, and wrote an
  owner-only receipt under the live archive. The live database remained schema
  7 with identical hash, mtime, inode, size, and counts. The retained restore
  matched database digest `5d6a0f5c…` and blob-inventory digest `9c7da915…`;
  SQLite integrity, foreign keys, FTS, and all 35,396 blobs passed. Only a
  disposable restored copy migrated through schema 11.
- The 18 July anchor snapshot `2a887…` restored separately with matching
  database digest and integrity.
- A first database-only clone was rejected because its blob trees were outside
  the clone and the initial dry-run implementation could set SQLite WAL mode.
  A fresh self-contained APFS clone was then created with 52,079 messages,
  52,136 attachments, 35,396 registered blob files, SQLite integrity `ok`, and
  zero foreign-key problems. The corrected operator opened it read-only with
  `query_only`. Its version-1 plan correctly failed: it would quarantine the
  wrong copies but did not restore correct canonical rows that the contaminated
  reconciliation had falsely tombstoned, and it could not distinguish new mail
  arriving after the paused snapshot. The CPU-bound dry run was stopped after
  that substantive failure was established. No repair apply flag was present;
  the clone is retained only as failed-plan evidence.
- The corrected schema-2 plan then passed a read-only dry run in 95.336 seconds
  and an apply rehearsal in 205.776 seconds on a fresh verified clone. The clone
  contained 52,079 messages, 52,136 attachment rows, and 35,396 blobs. The plan
  quarantined 24,228 wrong copies, moved 127 proved canonical rows, restored
  24,186 falsely tombstoned canonical states, retained one provider-only item as
  guarded backlog, and preserved 56 derived folder/cursor rows in provenance
  before clearing that derived state. It also recorded 721 contaminated runs
  and 10 contaminated errors without deleting them. After apply, SQLite
  integrity, foreign keys, FTS ownership/search, blob inventory, active
  provider ownership, and the permanent receipt all passed; a second call was
  a verified no-op. The rehearsal used provider inventories of 160 and 24,212
  messages. The archive held 160 and 24,211 active rows afterward, with the one
  absent row represented explicitly as backlog.
- The final read-only live envelope was generated at
  2026-08-02T15:47:39Z from that fresh backup and receipt. Plan digest
  `1de8b927…`, precondition digest `34e9c502…`, and envelope digest `4e008f6e…`
  bind 24,228 quarantines, 127 canonical moves, 24,186 canonical-state
  restorations, one provider-only backlog item, 721 run-provenance rows, 10
  error-provenance rows, and preservation/reset of 50 Gmail folder rows plus 6
  cursors.
- That exact envelope passed clone dry-run and apply rehearsal. The clone
  changed 48,541 planned rows, retained all 52,079 messages, 52,136 attachment
  rows and 35,396 blobs, produced zero active overlap and zero independent
  provider additions, preserved stable IDs/children/blobs/FTS/search, passed
  integrity and foreign keys, and recorded post-state digest `c1cf666b…`. A
  second invocation was a verified no-op. This proves the reviewed plan, not
  permission to apply it live.
- The pre-existing `.git/refs/.DS_Store` causes Git fsck noise in both source
  and restored copy. It was preserved and is not an email-repair discrepancy.

## Implementation checkpoint

Synthetic coverage now proves fail-closed Gmail and Outlook profile guards,
non-persisting commissioning probes, atomic owner-only identity seeding,
causal error-resolution receipts, independent provider/anchor evidence checks,
hash-verified raw-header attribution, disabled quarantine defaults, and
permanent supersession of the historical whole-swap command. The rehearsal
operator now opens a dry-run database read-only with SQLite `query_only`, binds
all raw content and its private plan to the verified temporary clone, hashes the
anchor database against its manifest, refreshes Outlook proof for the second
inventory collection, and explicitly requires zero FTS ownership mismatch
before and after apply. Repair plan schema 2 and database migration 11 now model
provider-proved canonical tombstone restoration explicitly, preserve every
original state field in immutable provenance, and record provider-present mail
that is absent from the paused archive as post-repair ingestion backlog. A
second inventory may contain only genuinely new, archive-absent additions; any
removal, account change, overlap, or collision with local/anchor/planned
ownership fails closed. The permanent receipt binds immutable ownership and
provenance, while immediate apply checks the restored mutable state; later
legitimate provider timestamp or deletion changes therefore do not create a
false receipt-drift alarm. The optimized preservation digest no longer copies
all FTS body text through JavaScript: it hashes stable repair fields and derived
field lengths, checks exact mutable-state projections, requires FTS ownership
and search fingerprints to remain sound, and verifies every clone blob against
the restored manifest and database inventory. Remote Restic probe failures also
fail closed and can no longer trigger automatic repository initialisation.

The owner-gated live workflow now plans against schema 7 without writing or
migrating it, requires a fresh encrypted backup plus exact-restore receipt,
binds a separate mode-0600 approval to the exact plan, precondition, and clone
receipt, and requires a typed live warning. Apply rechecks launchd, process,
lock, backup, restore, anchor, identities, provider inventories, and database
state. Migrations 8–11 and repair content share one outer SQLite transaction;
an induced repair failure leaves schema and archive content at version 7.
Ordinary commands cannot silently migrate an existing pre-repair archive. The
live apply never reconciles, backs up, or resumes scheduling automatically.
Synthetic end-to-end coverage exercises plan → exact clone receipt → approval →
apply and permanent no-op. This remains code and clone evidence, not a live
repair or Phase 1 acceptance result.

Clone isolation additionally rejects symlinked files, any database or manifest
with more than one hard link, a clone database inode matching the live database,
and non-empty clone WAL state. The permanent receipt digest covers receipt
metadata, all immutable message and canonical-state provenance, saved derived
state, operational provenance, current ownership/raw/FTS outcomes, and the
disabled quarantine. Tests prove that ordinary later provider timestamps and
eligibility changes remain valid while audit-trail or ownership tampering fails.

A redacted secret scan across full Git history found zero findings. A broader
working-folder scan reported nine generic-key matches across three ignored
local files: the owner-only environment file and two ignored raw-mail files.
The safe aggregate was three candidate files, all three ignored, zero tracked,
and zero staged. Their contents were not inspected, moved, or deleted. This is
a local data-hygiene risk requiring owner disposition, not evidence of tracked
or published leakage.

There was also a contained privacy-process incident during local diagnosis:
two inspection commands inadvertently displayed private-looking filenames and
one pre-existing tracked address inside the owner-only Codex tool session. The
values were not copied into repository files, this report, operational logs, or
commits. A later failed aggregate-count diagnostic also displayed a short
preview of generic ignored repository paths, but no file content or secret
value. Nothing was staged, pushed, or sent to an external service. These remain
local tool-session exposures; the final evidence must not claim unqualified
“no tool/chat exposure.”

The reviewed [private archive extraction manifest](../private-archive-extraction-manifest-2026-08-02.md)
records the intended future split between the public Outlook connector and the
private archival application. It is planning only: no files were moved, no
repository was created, and nothing was pushed.

Downstream delivery remains gated off. The Command Centre path is confirmed as
`Assistant-Vault/30-Business/Email-Briefs`, but its current consumer neither
writes a producer receipt nor verifies the package name, manifest digest, or raw
hashes before use. Email Assistant also has no `hannibal-briefs` receipt root.
That real cross-repository contract is a separately approved commissioning
blocker; local copy tests must not be described as consumer acceptance.

## Static and synthetic verification

The remediation tree and Aion integration passed these content-free gates after
the compatible dependency refresh, most recently on 6 August 2026:

- `npm ci --prefix archive-worker`: passed; the private worker dependency tree
  reported zero vulnerabilities.
- `npm test -- --runInBand`: passed (77 suites, 1,101 tests).
- `npm run archive:test`: passed (33 archive suites, 260 tests).
- `npm run lint`: passed with zero errors. Existing `require-await` warnings
  remain visible (85 warnings) and are not described as errors.
- `npm run format:check`: passed.
- `npm run archive:clean-install-check`: passed fixture ingestion and search in
  a new credential-free installation.
- `npm audit --omit=dev`: the 6 August rerun found newly published Hono and
  `ip-address` advisories. A non-forced transitive refresh plus the Hono
  4.12.30 → 4.12.34 patch override removed them. The final audit reports zero
  vulnerabilities; no declared package range or public API changed.
- `npm pack --dry-run --json`: passed with 63 public-package entries and no
  `archive-worker/`, `local-worker/`, private evidence, database, or raw-mail
  path. Existing public connector token-handling source remains intentionally
  packaged; no token store or credential is present.
- Redacted Gitleaks full-history and tracked-worktree-diff scans: zero findings.
- `git diff --check`: passed.

The final static/synthetic suite was rerun after the live macOS output showed
that `launchctl print-disabled` serialises the persisted state as `disabled`
rather than `true`; the parser now accepts those two exact disabled forms and
rejects `false`, `enabled`, an absent label, or any unexpected lookup code.
The live apply, reconcile, post-repair restore, deployment, and acceptance
gates remain outstanding.

## Files, commits, and deployment state

The remediation changes span explicit identity configuration and audits;
Outlook/Gmail runtime guards; account-isolated sync, reconciliation, scheduling,
notifications and privacy-safe status; migrations and targeted-repair
provenance; schema-preserving backup/restore; owner-gated plan/approval/apply
operators; FTS verification; clean-install and package-boundary checks; the
runbook, plan, extraction manifest and dated evidence; and their synthetic
tests. The exact current path list is preserved by `git status`; no pre-existing
owner change was reset, stashed, cleaned, or silently removed.

The remediation and Aion integration are preserved in one focused local commit.
No release has been deployed and nothing has been pushed. The LaunchAgent
remains disabled. Live repair approval and immutable deployment remain separate
owner gates after the exact live remediation evidence passes.

## Contradiction register

| Statement | Source and date | Scope | Current resolution |
|---|---|---|---|
| Stage 5 is paused pending Gmail correction | `PLAN.md`, 2026-07-18 | Historical/stale status text | Contradicted by later execution; scheduler is now persistently disabled for this remediation |
| Transactional Gmail remap completed | `docs/acceptance-evidence-2026-07-18.md`, 2026-07-18 | Historical action | Anchor evidence confirms the resulting historical ownership remains right; do not repeat |
| Corrected scheduler restarted | 18 July evidence | Historical action | Confirmed by current LaunchAgent installation and recent cycles before the protective pause |
| Scheduler installed and active | Current plist/launchctl, 2026-08-02 | Current before pause | Confirmed; it executed dirty working-tree code and was protectively paused |
| Automated acceptance gate passes | 18 July evidence | Historical snapshot | False now: current gate reports unresolved errors and incomplete records |
| Clean unattended window is complete | Current status | Current | False: 20.30 hours and 72/288 cycles at preflight; pause stops observation |
| Current encrypted backup is recoverable off-device | Restic restore, 2026-08-02 | Current pre-repair snapshot | Proved for exact snapshot `eeb38ba6…` with schema 7 unchanged and all 35,396 blobs; a fresh post-repair backup and restore will still be required |
| Downstream delivery is deferred | `PRODUCT.md`, `PLAN.md`, 2026-07-18 | Governing Phase 1 boundary | The remediation code gates routing/delivery off by default; the real consumer contract remains uncommissioned |

## Risk classification

**High.** The last live scheduler code was fail-open: a valid token could
retrieve from a mailbox without proving which mailbox it was. The scheduler is
disabled, and the replacement guard passes synthetic tests, but it is not yet a
reviewed scheduled deployment. All three live identities are now proved against
explicit owner-only configuration, but retrieval has not been allowed to
resume. Wrong-partition copies, a public repository, ignored local private
files, and a dirty working-tree deployment add separate integrity, privacy, and
reproducibility risks.

## Preflight gate and next authorised work

**Gate result: fail closed.** Scheduler pause is complete. No identity,
credential, historical archive, or scheduler-resume mutation is permitted until:

1. the owner explicitly approves exact reviewed plan digest `1de8b927…`;
2. the already-seeded Outlook and Gmail identity proof remains fresh at every
   independent evidence collection;
3. live targeted repair, a guarded manual sync that clears the five known
   active pending-attachment records, sequential full reconciliation, backup,
   and clean restore pass; and
4. only then is the scheduler explicitly enabled and reinstalled from reviewed
   code.

Recovery, the read-only final plan, and rehearsal of that exact plan are now
complete. The next required action is an owner decision on that digest. Until
approval is explicit, no live account repair, schema migration,
reconciliation, or scheduler resume is authorised. The historical
whole-account remap remains explicitly **not run**.

## Operator interventions during review — 2026-08-03

Recorded for audit. Both entries are live-state mutations made outside the
gated repair sequence during an incident review, before the reviewer had
established that the scheduler pause was intentional.

1. **Stale `worker.lock` removed** (2026-08-03T01:03Z, Claude Opus 5, at
   `~/Library/Application Support/Email Assistant Archive/worker.lock`).
   Exact prior contents: `{"pid":67738,"startedAt":"2026-08-03T00:12:31.538Z"}`.
   Owner PID 67738 was confirmed dead before removal. The lock was written by a
   separate pre-repair backup run (see `manifests/last-backup.json`,
   `completedAt` 2026-08-03T00:14:22.321Z), not by an ingestion cycle.
   Consequence: **no adverse effect observed** — but the lock was not inert.
   `archive-worker/lock.js` unlinks a dead-PID lock only when a worker starts,
   and no worker may start under this hold, so that auto-clear path could never
   run. The path that does gate the next authorised action is the repair
   preflight `live-gmail-partition-repair.js:369` (`assertNoWorkerLock`), which
   rejects on **any** lock file present and states it "never removes or guesses
   about it". Left in place, the stale lock would have failed the repair
   preflight before ordinary auto-clear logic ran. Its removal cleared a real
   obstruction, which is why it is recorded here as an operator action rather
   than treated as routine cleanup.

2. **`com.vitasci.draft-replies` bootstrapped and then booted out**
   (2026-08-03T01:03Z–01:12Z). It was loaded in error, never executed (job logs
   unchanged since 2026-08-01T05:10Z; no draft was generated or pushed), and has
   been returned to booted-out state. `com.davidbasseal.email-assistant-archive`
   was **not** resumed: `launchctl bootstrap` failed with error 5 because the
   job is `launchctl disable`d, and the pause was confirmed intentional before
   any further attempt. No `launchctl enable` was issued.

**Correction to the incident assessment of 2026-08-03.** That assessment's claim
of a hung ingestion run at 2026-08-02T09:54Z is **correct** and supersedes a
later reviewer claim that no hung run existed. The latter was derived from
`logs/scheduled.jsonl`, which records only completed cycles and therefore cannot
show an interrupted one. Direct read-only query of `ingestion_runs` confirms:

- `3558` `vitasci-outlook` `scheduled_cycle` started 2026-08-02T09:54:11.912Z,
  finished 09:54:16.015Z, `completed`.
- `3559` `gmail-ablative` `scheduled_cycle` started 2026-08-02T09:54:16.020Z,
  `finished_at` NULL, status `running`, counts all zero — orphaned by the
  interruption. `gmail-personal` received no row for that cycle.
- `3559` is both the only `status='running'` row and `MAX(id)`; no worker
  process remains.

Row `3559` is the "stale running record" the runbook's post-repair guarded sync
is specified to recover through its tested transition
(`docs/archive-operations-runbook.md:484-490`). It must **not** be hand-cleared:
leaving it in place is the required input to that gate. It is an *orphaned*
record, not an active hang — no worker process remains — and the two
characterisations are not in conflict.

**Method note.** The erroneous "no hung run" conclusion came from reading
`logs/scheduled.jsonl`, which appends a line only when a cycle completes; an
interrupted cycle leaves no trace in it. Ingestion health must be read from
`ingestion_runs`. Recorded because the same reasoning error — treating a
monitoring surface that is structurally silent about a failure mode as evidence
of health — is the incident's own root cause.

**Resume gate, restated.** No restart, enable, kickstart, sync, reconcile, or
lock mutation until every gate passes in order: approved repair → identity audit
→ one guarded manual sync (recovering row 3559 and the pending attachment
records) → verification → sequential full reconciliation → status and
verification again → new encrypted backup → clean restore into a new empty
directory → **reviewed deployment** → owner-authorised re-enable.

Cross-reference: the corresponding incident assessment is
`command-centre/docs/fable-5-email-crm-incident-adversarial-assessment-2026-08-03.md`
(revision 3), §9a of which records the same two interventions.

## Recovery and rollback route

- Source recovery: restore encrypted source snapshot `8c74e8fa…` into a new
  temporary directory; never overwrite this working tree.
- Archive recovery: restore exact archive snapshot `eeb38ba6…` into a new empty
  target; never overwrite the live archive automatically.
- Scheduler rollback: the unchanged plist can be bootstrapped only after all
  pre-resume gates pass. Until then, leaving it booted out is the safe state.
- Any future migration failure requires a written recovery decision against the
  verified pre-migration snapshot; automatic restore over production is
  prohibited.

## Evidence still pending

- Owner approval and live targeted repair; no whole-account swap.
- Post-repair guarded manual sync with zero pending/error records, sequential
  full reconciliation, encrypted backup, and clean restore.
- Owner disposition of the ignored local files flagged by the broad secret
  scan; no tracked or staged leak was found.
- Fresh acceptance-window start, 72 elapsed hours, and 288 cycles.
- Owner-controlled latency, sleep/restart, deletion/move, and final
  demonstration evidence.
