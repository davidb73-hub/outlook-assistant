# Aion disposable email-archive commissioning — 6 August 2026

## Outcome

The production archive repair, reconciliation, backup, and restore machinery
was commissioned through a six-activity Aion workflow using only disposable
archive data and synthetic provider evidence. The durable run completed with no
activity failures or retries.

This is a verified commissioning chassis. It is not evidence that the live
archive has been repaired or that live provider reconciliation has completed.

## Durable Aion evidence

| Field | Evidence |
| --- | --- |
| Namespace | `Practice` |
| Workflow type | `email_archive_clone_commissioning` |
| Workflow ID | `c24635f9-71c1-4705-abd2-568c6762eaea` |
| Run ID | `4d3e0469-8ce9-4fd6-a947-6bf473de6530` |
| Package version | `cde39e5deea6cf91c1eaa1fc6f975e84cd5b6cc6a2d7eeb79ff0d3b20ccd4f39` |
| Started | `2026-08-05T22:17:53.924280Z` |
| Completed | `2026-08-05T22:18:01.427019Z` |
| History | 21 durable events |
| Activities | 6 completed, each on attempt 1; 0 failed |
| Worker after evidence capture | stopped; 0 connected workers |

The final contract intentionally omits a `live_archive_modified` Boolean from
failure outcomes: a failed activity cannot honestly reduce an unknown state to
true or false. It reports `live_archive_unchanged: false` until the final
fingerprint comparison proves otherwise.

Before the final run, Aion correctly refused the rebuilt worker because the
previously routed workflow version still declared the older output schema. The
revised AWL package was explicitly deployed, routing moved from package
`d8bd3129…` to `cde39e5d…`, and the worker then passed contract admission. This
was expected schema safety, not an activity failure.

## Stage results

| Stage | Result |
| --- | --- |
| Prepare | 12 synthetic messages and 11 physical content-addressed blobs |
| Repair rehearsal | 3 rows changed on the clone: 2 duplicate quarantines and 1 proved canonical move |
| Idempotency | Immediate second repair invocation was a verified no-op |
| Preservation | Stable message IDs, child rows, and blobs preserved |
| Reconciliation | 3 accounts, 9 synthetic provider inventory items, 0 differences, 0 errors |
| Integrity | SQLite `ok`, 0 foreign-key problems, FTS consistency passed |
| Backup | 2 encrypted local Restic snapshots; repository creation and deduplication observed |
| Restore | Database hash/counts and all 11 blobs verified |
| Final boundary | No live email retrieved; no live database content changed by the Aion run |

## What was real and what was synthetic

Real production components were `ArchiveDatabase`, `ContentStore`,
`ArchiveService`, the Gmail partition repair planner/applicator,
`ArchiveSyncEngine.reconcileAccount`, `BackupManager`, Restic 0.19.0, and the
restore verifier. Aion durably scheduled each boundary through the dedicated
Rust liminal worker and narrow Node adapter.

Invented fixtures supplied all identities, message bodies, provider inventory,
OAuth-style identity responses, backup password, and the local backup
repository. No Microsoft Graph or Gmail inventory/message endpoint was called.
The production OneDrive Restic repository was not used.

## Pre-run diagnostics

- Archive LaunchAgent `com.davidbasseal.email-assistant-archive` was absent and
  persistently disabled.
- No matching archive worker process or worker lock existed.
- The live database reported schema 7, integrity `ok`, and zero foreign-key
  problems.
- Aggregate counts were 3 accounts, 52,079 messages, 52,136 attachments, and
  35,396 blobs.

### Diagnostic sidecar finding

The aggregate SQLite diagnostic used `better-sqlite3` with `readonly: true` and
`query_only`. Despite those flags, SQLite created an empty
`archive.sqlite3-wal` and a 32 KiB `archive.sqlite3-shm` in the live archive
directory. Before that diagnostic, both paths were absent. The main database's
inode, size (2,419,032,064 bytes), and modification time remained unchanged.

The SHM modification time changed once between validation runs after its
creation, so the sidecar state remains unresolved rather than being treated as
benign. At final shutdown, the scheduler was still persistently disabled, no
archive worker or lock existed, and `lsof` found no process holding the database
or either sidecar.

This was a filesystem mutation caused by the diagnostic and is therefore a
safety finding. The sidecars were not removed because that would be another
live-archive mutation requiring owner approval. The later Aion run fingerprinted
the resulting state before its first activity and proved that exact database,
WAL, and SHM metadata stayed unchanged through all six activities.

Future strict diagnostics must not open the live SQLite file through this path.
Use already-preserved evidence or a separately approved immutable/copy-based
diagnostic method. Copying the archive itself also requires explicit approval
because it contains live email.

### Owner-authorized sidecar resolution

On 6 August 2026, the owner explicitly authorized removal of only the two
diagnostic-created SQLite sidecars. Before deletion, the scheduler was proved
persistently disabled, no archive worker or worker lock existed, `lsof` found
no open database handles, and both paths matched their recorded device, inode,
size, regular-file, non-symlink, and single-link identities. The exact files
`archive.sqlite3-wal` and `archive.sqlite3-shm` were removed. A subsequent
metadata comparison proved the main database device, inode, size, and
modification time were unchanged. No database connection, provider request,
Gmail repair, scheduling change, or GitHub operation was performed.

The guarded pre-repair backup and live-plan code was then corrected before any
further live operation. It now uses SQLite `immutable=1` through Node's
`node:sqlite` API, rejects any pre-existing WAL or SHM path, and verifies the
database metadata remains unchanged when the connection closes. WAL-mode
synthetic tests cover the backup and exact-plan paths and prove neither
recreates source sidecars. No live database was opened to test this correction.

### External archive consumer discovered after cleanup

Later on 6 August, a new WAL/SHM pair appeared with different inodes from the
removed diagnostic pair: WAL inode `75160005` (zero bytes) and SHM inode
`75160006` (32 KiB), both created at 09:11:33 AEST. The main database retained
device `16777231`, inode `60428152`, size `2419032064`, and modification time
03 August 07:30:23 AEST.

At approximately 09:13, `lsof` identified Python PID `91708` holding the main
database and both sidecars. macOS launchd evidence associated that process with
`com.vitasci.draft-replies`, a separate Command Centre/Hannibal drafting job.
That proves the job used the files; it does **not** prove which process created
them at 09:11. The continuously available `com.davidbasseal.briefing` service
is another archive consumer. At the final metadata check no handles were open,
but the new sidecars remained unchanged.

The earlier removal approval applied only to the original, identity-checked
diagnostic pair. It does not authorize deleting this new pair or pausing these
separate services. Commissioning now requires a controlled window in which all
archive consumers are paused and zero open handles are proved. The code also
fails closed when any external database handle is present.

## Fresh post-remediation Aion execution

The locally committed safety correction (`56b12b7`) was commissioned again on
6 August without opening the live database or contacting a provider. The Aion
CLI and running server binary were byte-identical version 0.11.0 builds. The
clone worker passed locked Rust tests, strict Clippy, formatting, compiled AWL
contract checks, and the Node integration test. The six-step AWL document
checked cleanly and deployed at content hash `cde39e5…`; it was already the
active version, so deployment loaded and routed nothing new.

The observed positive run recorded:

- workflow ID `9898b9bb-32c6-4ae6-ba3d-5b87dae0df6c`;
- run ID `210745b9-3fb8-4a1c-b690-f181ab3a4caf`;
- 21 durable events and six activities, all completed on attempt one;
- 12 synthetic fixture messages and 11 blobs;
- two quarantined duplicates, one canonical move, and a verified second-run
  no-op;
- three reconciled accounts, nine inventory items, zero differences, clean
  integrity, foreign keys, and FTS;
- two local encrypted Restic snapshots with deduplication observed; and
- an exact restore with matching database/counts and all 11 blobs verified.

The final outcome was `commissioned_disposable`. The retained owner-only state
receipt is under
`/private/tmp/email-archive-aion-commissioning/codex-commissioning-20260806-0230/`
with SHA-256 `3a05bf1b…`. Its before/after fingerprint proves the exact live
database, WAL, and SHM metadata present at 12:29 AEST remained unchanged across
the run; `live_email_retrieved` is false.

A separate negative Aion run, workflow ID
`9f171fcf-0074-4ee4-a325-b6fabd5265e2`, supplied a non-authorized confirmation.
The first activity failed terminally, the workflow recorded the expected
`blocked_unverified` failure, and no disposable session directory was created.
The dedicated worker was then stopped and Aion reported zero connected workers
on its queue.

The SHM metadata had changed again at 12:18 AEST before this run. That does not
invalidate the run's exact before/after proof, but it confirms that external
archive consumers remain active outside the controlled commissioning window.
No sidecar was removed and no live database handle remained open at shutdown.

## Remaining approval gates

1. ~~Decide how the newly created empty SQLite sidecars should be handled.~~
   Resolved by the owner-authorized, identity-checked removal recorded above.
2. Authorize a controlled commissioning window: pause all external archive
   consumers, prove zero open handles, and separately decide whether the new
   identity-checked sidecar pair may be removed.
3. Authorize a fresh schema-preserving backup and exact restore verification.
4. Authorize live Gmail inventory retrieval before generating a new exact
   repair plan and rehearsal receipt.
5. Review that exact plan and separately authorize live Gmail repair.
6. Authorize guarded live reconciliation, which can retrieve email and modify
   the archive.
7. Verify the production backup and restore evidence after the approved repair.
8. Explicitly authorize scheduling only after the live acceptance gates pass.
9. Review and explicitly authorize any GitHub push.

No live Gmail repair, mailbox mutation, scheduling change, or GitHub push was
performed during this commissioning run.
