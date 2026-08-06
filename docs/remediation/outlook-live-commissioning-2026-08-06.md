# Outlook archive controlled live commissioning — 6 August 2026

## Outcome

The deterministic archive is commissioned for unattended archive-only
operation. Five active pending messages and 128 unresolved errors were repaired
without deleting archived content or mutating a mailbox. All three accounts
then reconciled with zero differences. A new encrypted Restic snapshot was
restored into a new temporary directory and verified completely. The paused
readers were restored, the 15-minute LaunchAgent was enabled, and its first
cycle completed successfully.

This is not final Phase 1 sign-off. The clean 72-hour/288-cycle window began
with that first cycle. The separate 20-message controlled latency test requires
owner-created live mail and remains outstanding.

## Safety boundary

- Outlook and Gmail provider adapters used mailbox-read-only permissions.
- No message was sent, drafted, moved, labelled, marked read, or deleted.
- Downstream routing and delivery remained disabled.
- Both external archive readers and the archive scheduler stayed unloaded
  during repair, reconciliation, backup, and restore.
- Every live mutation followed passing identity, handle, sidecar, clone, and
  content-preservation checks.
- Disabled quarantine data was retained and excluded from active status.

## Defects and corrections

### Immutable anchor sequencing

The clone rehearsal formerly opened the verified anchor through ordinary
read-only SQLite, which created WAL/SHM sidecars and made the same anchor fail
live preflight. The rehearsal now uses the strict immutable reader and rejects
either sidecar even when empty. Synthetic WAL-mode tests prove the anchor's
inode, size, modification time, and sidecar absence remain unchanged.

### Stale incomplete attachment metadata

A clone-only retry with a 1,000-row limit fetched all five messages with zero
provider errors but left all five pending. Aggregate inspection then proved the
100 active incomplete attachment rows had no blob hash and no security record.
They were absent from the providers' newly fetched authoritative attachment
manifests. The failure was therefore stale local metadata, not an unprocessed
batch or missing archived bytes.

Migration 12 preserves such a row with `current_eligible = 0`, retirement time,
reason, manifest digest, and a content-free message event. Pending, security,
and delivery queries ignore retired rows. Reappearance of the same provider
attachment ID reverses retirement and retries normally. Retirement fails
closed if a row references content. Completed attachments and blobs are never
retired or deleted.

### Persistently disabled scheduler

The installer attempted `bootstrap` before clearing launchd's persistent
disabled state, producing launchd error 5. It now performs bootout, enable, then
bootstrap. An injected-runner regression test verifies that order. The retry
installed the same validated owner-only plist successfully.

## Disposable-clone evidence

The fresh rehearsal clone exactly matched the paused live baseline at schema
11: 52,186 messages, 52,282 attachment rows, 51,605 completed attachments, 677
incomplete rows including disabled quarantine, and 35,516 blobs. Its completed
attachment and blob inventories had the same digests as live, integrity was
`ok`, and foreign-key checks were empty.

The patched clone cycle produced:

- schema 12;
- exactly 100 retired rows across five active messages;
- zero retired rows with a blob or security record;
- five distinct manifest digests and five audit events totalling 100 rows;
- zero active pending messages;
- zero changed or missing rows among all 51,605 pre-existing completed
  attachments;
- clean SQLite integrity, foreign keys, and FTS; and
- no further retirement during a second complete cycle.

All-account clone reconciliation then reported zero provider/local differences
and status reported zero unresolved errors.

## Live repair and reconciliation evidence

Immediately before live apply, all three provider identity checks passed, all
readers and scheduling were unloaded, no archive database handle existed, and
WAL/SHM paths were absent. The rehearsed sync completed every account with zero
errors.

Live postconditions matched rehearsal:

- exactly 100 contentless rows retired across the same five messages;
- zero active pending messages;
- the digest of all 51,605 pre-existing completed attachments remained
  `869ed4830da314077bbdc0280962654a734cfdae111f167d8477fcb2d6c072eb`;
- every recorded blob verified;
- FTS had zero missing, orphan, duplicate, or account-mismatched rows;
- SQLite integrity was `ok` and foreign-key checks were empty; and
- the first sync causally resolved 102 of the 128 historical errors.

Sequential live reconciliation discovered 3,508 eligible Outlook messages,
177 Ablative Gmail messages, and 24,282 Personal Gmail messages. Each account
finished with zero errors and zero differences. It archived six missing Outlook
records and causally resolved the remaining one reconciliation error plus 25
message-scoped errors. Final active counts were 3,514/178/24,282 complete
messages, zero pending messages, and zero unresolved errors.

## Encrypted backup and restore

The post-reconciliation backup created Restic snapshot `e60a977a…`. Its
manifest recorded:

- database digest `7c45a421…`;
- 4 accounts, 52,202 messages, 52,392 attachment rows, and 35,538 blobs; and
- blob inventory digest `36c9f685…`.

Restoring the immediately latest snapshot into a new temporary target took
about 31 minutes. The restored database hash and all table counts matched the
manifest, SQLite integrity was `ok`, all 35,538 blobs matched their hashes, FTS
passed, foreign-key checks were empty, and restored status retained schema 12,
100 retired rows, zero pending messages, and zero unresolved errors.

## Operations and acceptance startup

The briefing reader resumed and remained running. The interval-based draft
reader was loaded and enabled without an immediate run, matching its prior
configuration. The archive scheduler was enabled and installed at 15-minute
intervals.

The first archive cycle completed in 43.9 seconds with all three identities
verified, zero account errors, downstream delivery gated, no routing or
delivery, and backup correctly `not_due`. The operational event contained no
forbidden content keys, email-like strings, or detected secrets. The automated
archive acceptance gate passed with no active cross-account overlap,
reconciliation differences, pending messages, unresolved errors, or messages
in excluded folders.

The clean window started at `2026-08-06T06:00:00.026Z` with 1 completed cycle
of 288 required. Its 72-hour result remains pending by definition.

## Release evidence

- Final full repository tests: 78 suites and 1,112 tests passed, including the
  immutable-anchor, attachment-retirement, restore, and scheduler regressions.
- Prettier passed; ESLint reported zero errors and 85 existing warnings.
- The credential-free clean-install fixture passed at schema 12 without network
  access to a provider.
- Root and archive-worker production audits each reported zero vulnerabilities.
- The npm package dry-run contained 63 public files and excluded archive code,
  remediation evidence, tokens, raw mail, and live data.
- Gitleaks found zero findings in Git history. Nine broad working-tree findings
  were confined to three ignored local private files; none was tracked or
  packaged. The scheduled operational log also had zero findings.

## Remaining acceptance work

1. Accumulate at least 72 clean elapsed hours and 288 completed 15-minute
   cycles, with a recent final cycle and bounded well-formed logs.
2. The owner must create exactly 20 controlled ordinary messages across the
   three providers before the approved latency report can be produced.

Neither result can be fabricated, inferred from passive historical mail, or
completed through archive-only authority.
