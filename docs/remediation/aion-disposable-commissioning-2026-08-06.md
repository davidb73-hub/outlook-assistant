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

## Remaining approval gates

1. ~~Decide how the newly created empty SQLite sidecars should be handled.~~
   Resolved by the owner-authorized, identity-checked removal recorded above.
2. Authorize fresh live Gmail inventory retrieval before generating a new exact
   repair plan and rehearsal receipt.
3. Review that exact plan and separately authorize live Gmail repair.
4. Authorize guarded live reconciliation, which can retrieve email and modify
   the archive.
5. Verify the production backup and restore evidence after the approved repair.
6. Explicitly authorize scheduling only after the live acceptance gates pass.
7. Review and explicitly authorize any GitHub push.

No live Gmail repair, mailbox mutation, scheduling change, or GitHub push was
performed during this commissioning run.
