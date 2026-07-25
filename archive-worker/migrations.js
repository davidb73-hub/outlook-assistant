const MIGRATIONS = [
  {
    version: 1,
    name: 'initial-archive-schema',
    sql: `
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('outlook', 'gmail')),
        display_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE folders (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider_folder_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        kind TEXT,
        excluded INTEGER NOT NULL DEFAULT 0 CHECK (excluded IN (0, 1)),
        raw_json TEXT,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (account_id, provider_folder_id)
      );

      CREATE TABLE blobs (
        hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('raw-message', 'attachment')),
        relative_path TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL CHECK (size >= 0),
        media_type TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider_message_id TEXT NOT NULL,
        provider_thread_id TEXT,
        internet_message_id TEXT,
        subject TEXT NOT NULL DEFAULT '',
        sent_at TEXT,
        received_at TEXT,
        provider_created_at TEXT,
        provider_modified_at TEXT,
        direction TEXT CHECK (direction IN ('inbound', 'outbound', 'unknown')),
        body_text TEXT NOT NULL DEFAULT '',
        body_html TEXT NOT NULL DEFAULT '',
        body_content_type TEXT,
        body_preview TEXT NOT NULL DEFAULT '',
        importance TEXT,
        is_read INTEGER CHECK (is_read IN (0, 1) OR is_read IS NULL),
        has_attachments INTEGER NOT NULL DEFAULT 0 CHECK (has_attachments IN (0, 1)),
        raw_blob_hash TEXT REFERENCES blobs(hash),
        source_json TEXT,
        archive_state TEXT NOT NULL CHECK (
          archive_state IN ('archived_pending_attachments', 'archived_complete', 'archived_error')
        ),
        current_eligible INTEGER NOT NULL DEFAULT 1 CHECK (current_eligible IN (0, 1)),
        deleted_remote INTEGER NOT NULL DEFAULT 0 CHECK (deleted_remote IN (0, 1)),
        first_archived_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (account_id, provider_message_id)
      );

      CREATE INDEX messages_account_received_idx
        ON messages(account_id, received_at DESC);
      CREATE INDEX messages_thread_idx
        ON messages(account_id, provider_thread_id);
      CREATE INDEX messages_state_idx
        ON messages(archive_state, account_id);

      CREATE TABLE recipients (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        recipient_type TEXT NOT NULL CHECK (recipient_type IN ('from', 'sender', 'to', 'cc', 'bcc', 'reply-to')),
        ordinal INTEGER NOT NULL DEFAULT 0,
        address TEXT NOT NULL DEFAULT '',
        display_name TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (message_id, recipient_type, ordinal)
      );

      CREATE TABLE message_locations (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        provider_location_id TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        kind TEXT,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (message_id, provider_location_id)
      );

      CREATE TABLE attachments (
        id INTEGER PRIMARY KEY,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        provider_attachment_id TEXT NOT NULL,
        file_name TEXT NOT NULL DEFAULT '',
        media_type TEXT,
        size INTEGER CHECK (size >= 0 OR size IS NULL),
        content_id TEXT,
        is_inline INTEGER NOT NULL DEFAULT 0 CHECK (is_inline IN (0, 1)),
        blob_hash TEXT REFERENCES blobs(hash),
        archive_state TEXT NOT NULL DEFAULT 'pending' CHECK (
          archive_state IN ('pending', 'complete', 'retryable_error')
        ),
        last_error TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (message_id, provider_attachment_id)
      );

      CREATE INDEX attachments_state_idx
        ON attachments(archive_state, message_id);

      CREATE TABLE sync_cursors (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        cursor TEXT,
        status TEXT NOT NULL DEFAULT 'ready',
        metadata_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, scope)
      );

      CREATE TABLE ingestion_runs (
        id INTEGER PRIMARY KEY,
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        run_type TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
        discovered_count INTEGER NOT NULL DEFAULT 0,
        archived_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        details_json TEXT
      );

      CREATE TABLE ingestion_errors (
        id INTEGER PRIMARY KEY,
        run_id INTEGER REFERENCES ingestion_runs(id) ON DELETE SET NULL,
        account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
        provider_message_id TEXT,
        stage TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT NOT NULL,
        retryable INTEGER NOT NULL DEFAULT 1 CHECK (retryable IN (0, 1)),
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE message_events (
        id INTEGER PRIMARY KEY,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        details_json TEXT
      );

      CREATE TABLE processing_queue (
        id INTEGER PRIMARY KEY,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'deferred' CHECK (
          status IN ('deferred', 'pending', 'running', 'completed', 'failed')
        ),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (message_id, task_type)
      );

      CREATE VIRTUAL TABLE messages_fts USING fts5(
        message_id UNINDEXED,
        account_id UNINDEXED,
        subject,
        body,
        participants,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `,
  },
  {
    version: 2,
    name: 'repair-completed-attachment-state',
    sql: `
      UPDATE messages
      SET archive_state = CASE
        WHEN EXISTS (
          SELECT 1 FROM attachments
          WHERE attachments.message_id = messages.id
            AND attachments.archive_state != 'complete'
        ) THEN 'archived_pending_attachments'
        ELSE 'archived_complete'
      END;

      UPDATE ingestion_errors
      SET resolved_at = COALESCE(
        resolved_at,
        (
          SELECT messages.updated_at
          FROM messages
          WHERE messages.account_id = ingestion_errors.account_id
            AND messages.provider_message_id = ingestion_errors.provider_message_id
            AND messages.archive_state = 'archived_complete'
        )
      )
      WHERE resolved_at IS NULL
        AND EXISTS (
          SELECT 1 FROM messages
          WHERE messages.account_id = ingestion_errors.account_id
            AND messages.provider_message_id = ingestion_errors.provider_message_id
            AND messages.archive_state = 'archived_complete'
        );
    `,
  },
  {
    version: 3,
    name: 'attachment-security-gate',
    sql: `
      CREATE TABLE attachment_security (
        attachment_id INTEGER PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'safe', 'quarantined', 'blocked', 'scanner_unavailable')),
        scanner TEXT NOT NULL,
        scanner_version TEXT,
        reason TEXT,
        scanned_at TEXT NOT NULL,
        UNIQUE (attachment_id)
      );

      CREATE INDEX attachment_security_status_idx
        ON attachment_security(status);

      CREATE TABLE security_events (
        id INTEGER PRIMARY KEY,
        message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        details_json TEXT,
        occurred_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 4,
    name: 'durable-delivery-jobs',
    sql: `
      CREATE TABLE delivery_jobs (
        id INTEGER PRIMARY KEY,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        destination TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'delivered', 'rejected', 'failed', 'review')),
        attempts INTEGER NOT NULL DEFAULT 0,
        manifest_digest TEXT,
        destination_record_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(message_id, destination)
      );
      CREATE INDEX delivery_jobs_status_idx ON delivery_jobs(status, updated_at);
      CREATE TABLE delivery_events (
        id INTEGER PRIMARY KEY,
        delivery_job_id INTEGER NOT NULL REFERENCES delivery_jobs(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        details_json TEXT,
        occurred_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 5,
    name: 'delivery-package-paths',
    sql: `ALTER TABLE delivery_jobs ADD COLUMN package_root TEXT;`,
  },
  {
    version: 6,
    name: 'attachment-security-by-content-hash',
    // Verdicts were keyed to attachment_id, so identical content was rescanned for
    // every message it appeared in — one signature image occurred 369 times. Keying
    // the verdict to the content hash means each distinct file is scanned once, ever.
    // Measured on the live archive at migration time: 20,358 attachment rows resolve
    // to 7,494 distinct blobs (inline images: 10,563 rows, 2,187 blobs).
    sql: `
      CREATE TABLE attachment_security_blob (
        blob_hash TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending', 'safe', 'quarantined', 'blocked', 'scanner_unavailable')),
        scanner TEXT NOT NULL,
        scanner_version TEXT,
        reason TEXT,
        scanned_at TEXT NOT NULL
      );
      CREATE INDEX attachment_security_blob_status_idx
        ON attachment_security_blob(status);
    `,
  },
  {
    version: 7,
    name: 'taint-provenance-columns',
    // Taint provenance (command-centre/docs/design-1-taint-provenance.md), step 2.
    //
    // taint_tier is a stored FLOOR, not a verdict: every consumer takes
    // max(stored_tier, classify_now), so NULL is safe — it simply falls back to fresh
    // classification, i.e. today's behaviour. The classifier lives in Python
    // (command-centre/tiering.py); porting its patterns to JS would create a second,
    // divergent copy — the exact "signal that looks like coverage" the audit flagged.
    // So these columns are written by a Python stamping pass, not by JS ingest, which
    // leaves them NULL. Origin is deliberately NOT stored: `direction` already encodes
    // it (inbound → external, outbound → operator).
    //
    // taint_account carries the CRM account attributed from the structured sender/
    // recipient domain at stamp time — the signal is strongest here and lost later,
    // and it repairs the weak substring account-floor matching in tiering.py.
    sql: `
      ALTER TABLE messages ADD COLUMN taint_tier TEXT
        CHECK (taint_tier IN ('GREEN','AMBER','RED') OR taint_tier IS NULL);
      ALTER TABLE messages ADD COLUMN taint_rule_version INTEGER;
      ALTER TABLE messages ADD COLUMN taint_account TEXT;
      CREATE INDEX messages_taint_tier_idx ON messages(taint_tier);
    `,
  },
];

module.exports = {
  MIGRATIONS,
};
