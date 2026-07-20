# Local Email Archive Pipeline

**Status:** Operational archive; automated gates pass, owner-controlled and elapsed acceptance tests remain  
**Decision date:** 2026-07-18  
**Owner:** David Basseal

## Purpose

Build a private, cost-neutral local archive of email from three accounts:

- VitaSci Outlook
- Ablative Gmail
- Personal Gmail

Outlook and Gmail remain the external sources of truth. The local archive preserves a complete, searchable copy of eligible email and attachments for later local-LLM processing, Obsidian briefs, and routing into specialist repositories.

The archival path must be deterministic. A local LLM must never control authentication, mailbox synchronisation, deduplication, integrity checking, or database commits.

## System schematic

```text
OUTLOOK                         GMAIL
Microsoft Graph API             Gmail API
        |                           |
        +---- deterministic Node.js connectors ----+
                                                    |
                                      15-minute scheduler
                                                    |
                                                    v
                                    Check sync checkpoints
                                  "What changed since last run?"
                                                    |
                                                    v
                                  Download original email data
                                + eligible attachment content
                                                    |
                                                    v
                            Validate -> hash -> deduplicate -> commit
                                                    |
                         +--------------------------+-------------+
                         v                                        v
                 Raw MIME/EML files                         SQLite database
                 Attachment files                           Metadata, bodies,
                                                           threads, recipients,
                                                           folders, hashes,
                                                           sync checkpoints
                         |                                        |
                         +------------------+---------------------+
                                            |
                                   ARCHIVAL COMPLETE
                                            |
                               LLM is not involved above
                                            |
                                            v
                                  Processing job queue
                                            |
                                            v
                              Local LLM processing -- later
                           classification, summary, entities,
                             obligations, routing recommendation
                                            |
                         +------------------+--------------------+
                         v                  v                    v
                    Obsidian           Financial          VitaSci CRM/KMS
                  7 am / 7 pm          Assistant              later
```

## Retrieval responsibility

The LLM does not retrieve email.

- Outlook retrieval is performed by deterministic Node.js code calling Microsoft Graph with the existing Outlook authentication components.
- Gmail retrieval is performed by deterministic Node.js code calling the Gmail API with read-only OAuth credentials.
- Archive code validates, hashes, deduplicates, and writes the result to SQLite and managed filesystem storage.
- Local LLMs receive only already-archived records for later interpretation.

The prototype local worker accesses Outlook through MCP. MCP is useful as an AI tool interface, but it should not be the archival foundation. The archive should call reusable Graph connector and authentication code directly. The MCP server can remain available for conversational mailbox operations.

## Archive contents

### Included

- Inbox
- Sent
- Archive
- custom folders and labels
- attachments
- all available eligible history
- future changes

### Excluded initially

- Drafts
- Spam/Junk
- Trash/Deleted Items

If an archived message is later deleted remotely, its content remains in the local archive and a deletion tombstone records the remote change. Archived content is never automatically purged.

## Local storage

Live data belongs outside Git at:

```text
/Users/davidbasseal/Library/Application Support/Email Assistant Archive/
```

Recommended layout:

```text
Email Assistant Archive/
  archive.sqlite3
  raw-messages/
  attachments/
  manifests/
  logs/
```

- SQLite stores accounts, folders, labels, messages, threads, recipients, bodies, sync checkpoints, processing state, attachment metadata, hashes, and audit records.
- SQLite FTS5 provides local full-text search.
- Original messages are retained in raw MIME/EML form where the provider supports it.
- Attachments are stored as content-addressed files using SHA-256 hashes, with paths and metadata in SQLite.
- Duplicate attachment content is stored once.

## Incremental timing model

These are engineering estimates, not measured service guarantees. They must be validated against the three live accounts.

| Stage | Typical estimate |
|---|---:|
| Scheduler notices it is due | 0-15 minutes after arrival |
| Authentication or token refresh | under 1-3 seconds |
| Request provider changes | roughly 1-5 seconds |
| Download an ordinary email | roughly 0.5-3 seconds each |
| Hash and write a message | usually under 1 second |
| Download attachments | seconds to minutes, depending on size |
| Commit SQLite transaction | normally under 0.1 seconds |
| Mark message archived | immediately after verified commit |
| Later local-LLM processing | roughly 10 seconds to several minutes per message |

For an ordinary message without large attachments:

```text
Arrival -> archived: usually within 15 minutes and several seconds
Normal worst case: approximately 15-20 minutes
```

LLM processing is asynchronous and cannot block or roll back archival.

For messages with attachments, store the message first with an explicit state such as `archived_pending_attachments`. Change it to `archived_complete` only after every eligible attachment is downloaded and hash-verified. Failed attachments remain retryable without losing the email record.

## Historical backfill

The first historical import is separate from ongoing incremental ingestion:

```text
New mail queue: always highest priority
Historical backfill: uses spare capacity in resumable batches
```

The first live backfill completed on 18 July 2026 with 27,365 eligible messages
and 20,149 attachment records. After the verified Gmail identity correction and
authorized test-mail ingestion, the live archive contains 27,407 messages and
20,213 attachment records with zero provider-to-archive differences. The
following estimates remain useful for a fresh installation but are not service
guarantees:

- VitaSci Outlook: hours, depending on history and attachments.
- Ablative Gmail: hours to possibly a day.
- Personal Gmail: potentially multiple days.

Before promising completion times for a future rebuild, inventory
provider-reported counts and sample attachment volumes. Gmail imports newest
messages first, checkpoints each durable unit of work, respects provider
throttling, and continues progressively until all eligible history is archived.
Messages are staged durably before slow attachment downloads, so a large
attachment cannot prevent unrelated messages in the same provider page from
being preserved.

## Security and backup

- Use macOS FileVault and owner-only permissions for live local data.
- Store OAuth credentials and backup secrets in macOS Keychain.
- Never store credentials, email content, databases, raw messages, or attachments in Git.
- Treat raw email and attachments as untrusted input; never execute attachments automatically.
- Keep routine logs free of email bodies.
- Use transactionally consistent SQLite snapshots for backup.
- Send encrypted, deduplicated backups to VitaSci OneDrive using Restic. The
  existing OneDrive desktop mount performs transfer, so adding Rclone would
  duplicate the transfer layer without improving recoverability.
- Do not run the live SQLite database from a OneDrive-synchronised directory.
- Perform scheduled integrity checks and periodic restore tests.

VitaSci OneDrive mount:

```text
/Users/davidbasseal/Library/CloudStorage/OneDrive-VitaSciConsulting
```

## Deferred stages

The following are explicitly later work and must not delay reliable archival:

1. Integrating the `PROJECT-Local-LLM` gateway and evidence-backed email lane.
2. Classifying priority and extracting summaries, entities, obligations, and routing recommendations.
3. Updating separate Obsidian account memory at 7:00 am and 7:00 pm Australia/Sydney time.
4. Routing financial material to Financial-Assistant.
5. Routing VitaSci material to the separate VitaSci CRM/KMS.
6. Defining additional downstream destinations.

Downstream systems receive traceable copies or derived records. They do not replace the email archive.
