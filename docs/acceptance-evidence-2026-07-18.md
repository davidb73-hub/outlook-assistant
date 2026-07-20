# Phase 1 Acceptance Evidence — 18 July 2026

**Status:** deterministic archive operational; Phase 1 not complete  
**Environment:** macOS, Homebrew Node.js 22.23.1, Australia/Sydney  
**Evidence rule:** no bodies, subjects, addresses, tokens, attachment names, or
provider message IDs are recorded here.

## Verified today

| Area | Sanitized evidence | Result |
|---|---|---|
| Final credential-free clean install | New temporary repository copy; no `.env`, token, EML, database, raw-message, attachment, or corpus data copied; locked root and worker installs succeeded | Pass |
| Clean archive lifecycle | Empty external root migrated from version zero; SQLite integrity `ok`; zero-blob verification passed | Pass |
| Final source and clean-copy tests | 51 suites, 870 tests, zero failures or skips in both the working tree and corrected credential-free clean copy | Pass |
| Archive regression tests | 43 deterministic archive/provider/sync/backup/restore/operations tests within the final suite | Pass |
| Lint and formatting | ESLint: zero errors and 44 non-blocking `require-await` warnings; repository-wide Prettier check passed | Pass under the approved zero-error lint gate |
| Dependency security | Root and private worker final installs and clean copies each reported zero known npm vulnerabilities | Pass |
| Public/private package separation | `npm pack --dry-run --json`: 63 public-package entries; private archive worker, private documents, live data, tokens, and databases absent | Pass |
| Tracked secret/private-data scan | Live `.env`, Gmail token files, two EMLs, and generated memory databases are ignored; no tracked file matched access-token, refresh-token, or private-key signatures | Pass; owner cleanup decision remains open |
| FileVault | `fdesetup status` reported FileVault On | Pass |
| VitaSci Outlook inventory | Provider eligible 3,339; local eligible 3,339; 3,339 complete; zero pending, errors, or reconciliation differences | Pass |
| Ablative Gmail inventory | Provider eligible 133; local eligible 133; 133 complete; zero pending, errors, or reconciliation differences; credential profile verified as `david@ablative.com.au` | Pass |
| Personal Gmail inventory | Provider eligible 23,927; local eligible 23,927; 23,927 complete; zero pending, errors, or reconciliation differences; credential profile verified as `david.basseal@gmail.com` | Pass |
| Automated archive gate | Privacy-safe `archive:acceptance-status` report passed every automated archive criterion and explicitly excluded elapsed/owner-controlled tests | Pass |
| Folder/label inclusion | Outlook: Inbox 2,397, Sent 905, Archive 2, custom 35. Ablative: Inbox 17,143, Sent 717, custom 4,114. Personal: Inbox 125, Sent 8; no custom label was present | Pass where locations are present |
| Exclusion policy | Draft/Spam/Trash or Draft/Junk/Deleted locations discovered independently for all accounts; zero archived messages currently in excluded locations | Pass |
| Local integrity | SQLite integrity `ok`; all 34,894 of 34,894 live blobs matched recorded SHA-256 hashes after remap and incremental test ingestion | Pass |
| Attachment completion | 20,213 attachment records complete; zero pending or retryable-error attachments after live recovery | Pass |
| Account isolation and local search | Distinct credentials, cursors, records, errors, and account-scoped tests; live content-free local searches returned isolated results without provider access | Pass |
| Safe interruption recovery | Manual application interruption left zero false-complete records; next exclusive worker marked the run `interrupted`, retained verified work, and resumed without duplication | Pass for application interruption |
| Provider request bounds | Every provider request, including response-body reading, has a five-minute timeout inside bounded retry/backoff | Pass in code/tests and live extended run |
| Bounded-memory historical ingestion | Reconciliation now persists each fetched message before fetching the next and stages unrelated messages before slow attachment downloads; live RSS dropped materially after switchover | Pass in code/tests and live run |
| Zero-byte Gmail attachment recovery | Ten live Gmail attachment errors were traced to provider-declared size zero followed by HTTP 400. A tested deterministic empty-buffer rule resolved all ten; no error was administratively cleared | Pass |
| Scheduler | LaunchAgent uses pinned Homebrew Node 22, 900-second interval, owner lock, low-priority I/O, bounded logs, and content-free failure notification; corrected mapping was reconciled and the first post-remap cycle completed all three accounts with zero errors and exit code 0 | Pass for corrected installation and cycle; clean window restarted at 00:45:55Z |
| Operational logs | Owner-only JSONL, 2 MB rotation with four generations, zero malformed lines; no body/subject/address/token markers found | Pass at evidence time |
| Encrypted incremental backup | Restic encryption/keychain, consistent SQLite snapshot, deduplication, daily marker, and repository check passed | Pass |
| Gmail identity correction | Transactional swap moved all account-scoped records from the reversed IDs; post-remap reconciliation: Outlook 3,347/3,347, Ablative 133/133, Personal 23,927/23,927; all differences zero | Pass |
| Current backup | Snapshot `2a887a6e10ca…`; 27,407 messages, 20,213 attachments, 34,894 blobs; about 1.27 GB new encrypted data after the identity correction; clean restore matched database hash, counts, and all 34,894 blob hashes | Pass locally and visible through Microsoft's cloud API |
| Current clean restore | New empty target; SQLite integrity `ok`; corrected database hash and counts matched; all 34,894 restored blobs verified; temporary restore removed | Pass |
| OneDrive cloud API evidence | Microsoft cloud listing now shows the corrected encrypted snapshot `2a887a6e10ca…` in the remote `snapshots` folder, alongside older snapshots | Pass for current off-device snapshot visibility |

## Defects found and recovered

1. Outlook attachment enumeration requested a derived Graph field and produced
   13 failures. No unsafe checkpoint advanced; the query was corrected and all
   records subsequently reconciled.
2. Re-ingesting a message with already-verified attachments could return it to
   pending. A regression fix and forward-only repair migration restored zero
   pending records.
3. Blob verification used an incorrect database-field mapping on a non-empty
   archive. The mapping and regression coverage were corrected before live
   integrity passed.
4. The first clean-copy method included two ignored EMLs. Only temporary copies
   were removed; clean-copy rules now exclude EML/corpus data, while owner files
   remain preserved for an explicit cleanup decision.
5. Root dependency advisories were removed through compatible locked updates;
   final root and private-worker audits are clean.
6. A five-item Outlook continuation link was embedded in a historical cursor.
   An audited checkpoint-only reset cleared no archive content and normal
   production pagination resumed.
7. The first scheduler used an internal Codex Node runtime. It now pins stable
   Homebrew Node 22 because the system Node 25 ABI is incompatible with the
   SQLite driver.
8. Abandoned runs could remain labelled `running`. Exclusive startup now marks
   them `interrupted`, with regression and live recovery evidence.
9. Restore lacked a root convenience command. `archive:restore` was added and
   used for both clean restore drills.
10. This Mac's global npm cache contains root-owned files. The documented clean
    path uses an isolated temporary npm cache without `sudo` or global mutation.
11. Outlook backfill spent a whole scheduled cycle on each empty custom folder.
    It now skips consecutive empty folders in one call and reconciled 3,339 of
    3,339 records.
12. Provider HTTP calls had no hard timeout. A five-minute per-request abort was
    added inside bounded retries and regression tested.
13. Gmail reconciliation buffered up to 500 raw messages before persisting any,
    causing long silent pauses and unnecessary memory growth. The worker now
    streams durable message staging, keeps attachment processing two-phase, and
    safely recovered after a live switchover.
14. Gmail sometimes advertised a named, zero-size attachment ID and then
    rejected its download with HTTP 400. Ten such live records remained visible
    until the tested zero-byte rule reprocessed and resolved them all.
15. Backup database hashing read the whole SQLite snapshot into RAM. Hashing is
    now streaming so backup memory remains bounded as the archive grows.
16. The first unattended report retained historical failures but could only
    report total elapsed time, so an old event could eventually look like a
    72-hour proof. It now preserves historical totals while resetting a separate
    clean window after the latest failure; that window requires 288 completed
    cycles and a recent event before it can pass.
17. A local-only `latency-report` command now measures the owner-approved
    20-message sample without printing message content or changing mail.
18. The authorized run produced 13 measurable destination arrivals: 6 in
    VitaSci Outlook and 7 in Ablative Gmail. Their sanitized timing was median
    170 seconds, p95 230 seconds, and maximum 230 seconds. Seven messages sent
    to the Personal Gmail identity have not appeared there after propagation
    and remain unmeasured; the 20-message criterion therefore correctly fails.
19. The two Gmail account keys were discovered to be semantically reversed:
    `gmail-ablative` authenticates as `david.basseal@gmail.com`, and
    `gmail-personal` authenticates as `david@ablative.com.au`. The scheduler was
    paused before further sync; a transactional account-scoped remap was then
    applied, both providers were reconciled, and the corrected scheduler was
    restarted.

## Not yet verified — completion blockers

| Acceptance area | Why it remains open |
|---|---|
| Twenty-message latency sample | The earlier 13-message result was invalidated by the Gmail identity mapping defect. A new controlled sample must target the corrected account identities; no new 20-message result is claimed yet. |
| Approved latency target | Owner approved median ≤10 minutes, p95 ≤20 minutes, and maximum ≤30 minutes for ordinary messages while the Mac is awake and online. |
| Seventy-two-hour unattended run | The historical log is preserved. The corrected clean window began at 00:45:55Z and currently has 1 of 288 required completed cycles; it has not elapsed. |
| Sleep and machine-restart recovery | Application interruption passed; real macOS sleep and machine restart still require controlled observation. |
| Live remote deletion/move test | Synthetic tombstone tests pass, but no owner-approved live message has been deliberately deleted or moved into an excluded state. |
| Final controlled-message demonstration | Existing mail is fully archived, but the owner has not observed one purpose-created message per provider through receipt, archive, local search, idempotent rerun, backup, and status. |
| Current snapshot off-device | Older encrypted snapshots are visible through Microsoft's cloud API. The new 12.5 GB `4f519c01320a…` snapshot is still uploading and must appear remotely before it is claimed off-device. |
| Repository cleanup decision | Generated orchestration/agent material, CRM/KMS design material, runtime databases, and two ignored EML originals were preserved. Keep/move/remove requires explicit owner approval. |

## Current truthful conclusion

The smallest usable archive is operational and the automated archive gate now
passes: deterministic read-only sync for three accounts, complete historical
inventory, zero-difference reconciliation, local search/storage, resumable
checkpoints, encrypted deduplicated backup, and full clean restore are proven.

Phase 1 is **not complete**. The controlled timing/demonstration tests,
sleep/restart and 72-hour observations, live deletion/move test, latest cloud
upload confirmation, and repository cleanup decision remain mandatory under
`ACCEPTANCE.md`.
