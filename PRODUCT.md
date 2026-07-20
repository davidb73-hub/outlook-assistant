# Email Assistant Product Definition

**Status:** Approved for implementation on 2026-07-18  
**Scope:** Phase 1 — deterministic local email archive  
**Owner:** David Basseal  
**Last updated:** 2026-07-18

## Product statement

Email Assistant is a private, local-first system that creates a complete, verifiable archive of eligible email and attachments from David Basseal's three mailboxes. The archive becomes the reliable foundation for later local-LLM processing, Obsidian memory briefs, and routing to specialist repositories.

The first delivery is an archival system, not an AI triage system. Mail retrieval, deduplication, hashing, storage, reconciliation, and backup must be deterministic and must work without an LLM.

## User

The initial and only required user is David Basseal.

This is not currently a public SaaS product, a multi-user service, or a replacement for Outlook or Gmail.

## Problem

Important correspondence is spread across three accounts and cannot yet be searched, processed, backed up, or routed through one reliable local system. The existing repository can access Outlook and contains an early Outlook/Gmail triage prototype, but it does not maintain a complete archival database.

Without a verified archive:

- later AI processing can silently miss messages;
- deleted or moved remote messages can disappear from local context;
- attachments cannot be reliably deduplicated or routed;
- Obsidian briefs cannot be traced back to preserved source records;
- recovery depends entirely on provider availability and mailbox state.

## Accounts

The archive must support these distinct account profiles:

1. VitaSci Outlook
2. Ablative Gmail
3. Personal Gmail

Credentials, sync cursors, errors, progress, and reconciliation results must remain isolated per account.

## External and local sources of truth

- Outlook and Gmail are the external sources of truth.
- The local archive is the durable local record of everything successfully observed and verified.
- A downstream system may receive a traceable copy or derived record, but it never becomes the email archive.
- If a previously archived email is deleted remotely, the archive retains it and records a deletion tombstone.

## Required outcomes

### O1. Complete eligible history

Import all available eligible historical email for all three accounts. Personal Gmail may take multiple days and must backfill newest-first in resumable batches.

### O2. Prompt incremental archival

After backfill begins, new email must take priority over historical work. The
polling target is every 15 minutes. For ordinary messages while the Mac is
awake and online, the approved acceptance target is median archival within 10
minutes, p95 within 20 minutes, and maximum within 30 minutes. This target does
not apply to large attachments, provider outages, or a sleeping Mac.

### O3. Original source preservation

Preserve the original message representation where supported, normalised searchable content, provider identifiers, account, folder/label state, thread relationships, timestamps, sender, recipients, and source traceability.

### O4. Attachment preservation

Download eligible attachments, hash them, store identical content once, and retain message-to-attachment relationships. A message is not `archived_complete` until every eligible attachment is either verified or recorded as an explicit retryable failure.

### O5. Idempotent and resumable operation

Repeated runs must not duplicate messages or attachment content. Crashes, token expiry, throttling, and network failures must resume from a safe checkpoint without losing already verified work.

### O6. Local search and auditability

Provide structured queries and SQLite full-text search across archived email. Every record must be traceable to its account and provider identifiers. Every ingestion run and failure must be auditable without logging message bodies in routine logs.

### O7. Secure local storage

Store live data outside Git at:

```text
/Users/davidbasseal/Library/Application Support/Email Assistant Archive/
```

Use owner-only permissions, macOS FileVault, Keychain-held credentials, untrusted-content handling, and no automatic attachment execution.

### O8. Independent encrypted backup

Create transactionally consistent, encrypted, deduplicated backups in VitaSci OneDrive. The live SQLite database must never run from a synchronised cloud folder. Restore tests must prove the backup is usable.

## Included mailbox content

- Inbox
- Sent
- Archive
- custom folders and labels
- attachments
- all available eligible history
- future eligible changes

## Excluded mailbox content

- Drafts
- Spam/Junk
- Trash/Deleted Items

Excluded folders are not imported during initial backfill or incremental sync. A message archived while eligible is retained if it is later moved to an excluded or deleted state.

## Technical boundaries

- Reuse the existing JavaScript/Node.js Outlook authentication and Graph integration where safe.
- Use deterministic provider connectors for Microsoft Graph and Gmail API access.
- Do not use an LLM or MCP agent to decide what to retrieve, commit, retry, or delete.
- Keep the public Outlook MCP package and the private archival application logically separate. Private archive data and functionality must not accidentally enter the published npm package.
- Store structured state in SQLite with versioned migrations and full-text search.
- Store raw messages and content-addressed attachments in managed filesystem storage, referenced by hashes and paths in SQLite.

## Deferred outcomes

The following are desired later but are not part of Phase 1 completion:

- local-LLM classification, summarisation, entity extraction, and routing;
- integration with `PROJECT-Local-LLM`;
- Obsidian account-memory updates at 7:00 am and 7:00 pm Australia/Sydney;
- financial routing to Financial-Assistant;
- VitaSci routing to the separate VitaSci CRM/KMS;
- additional downstream destinations;
- automated drafting, sending, moving, labelling, marking read, or deleting;
- webhooks or cloud push-notification infrastructure;
- public, hosted, or multi-user operation.

## Smallest usable increment

The smallest usable increment archives one new VitaSci Outlook message and its attachments into the local store, finds it through a local query, reruns without duplication, and restores it from an encrypted backup.

That increment proves the architecture but is not the completed product. Phase 1 is complete only after all three accounts pass incremental sync, historical reconciliation, integrity, backup, and clean-install acceptance tests.

## Completion rule

No implementation may be called complete merely because unit tests pass. Completion requires every applicable test in `ACCEPTANCE.md` to pass and the system to be demonstrated from a clean installation.
