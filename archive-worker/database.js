const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { MIGRATIONS } = require('./migrations');
const { FTS_ROW_DELETE_SQL, messageKey, scanFtsIndex } = require('./fts-index');

function nowIso() {
  return new Date().toISOString();
}

function json(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function bool(value) {
  if (value === undefined || value === null) return null;
  return value ? 1 : 0;
}

function assertAccount(account) {
  if (!account?.id || !account?.displayName) {
    throw new Error('Archive account id and displayName are required');
  }
  if (!['outlook', 'gmail'].includes(account.provider)) {
    throw new Error(`Unsupported archive provider: ${account.provider}`);
  }
}

function assertMessage(message) {
  if (!message?.providerMessageId) {
    throw new Error('providerMessageId is required');
  }
}

class ArchiveDatabase {
  constructor(databasePath) {
    // ':memory:' is a SQLite sentinel, not a path. Resolving it created a real
    // 180KB database file at the repo root and made the in-memory tests measure
    // disk I/O, which matters most for the controlled-latency benchmark.
    const inMemory = databasePath === ':memory:';
    this.databasePath = inMemory ? databasePath : path.resolve(databasePath);
    if (!inMemory) {
      fs.mkdirSync(path.dirname(this.databasePath), {
        recursive: true,
        mode: 0o700,
      });
    }
    this.db = new Database(this.databasePath);
    if (!inMemory) fs.chmodSync(this.databasePath, 0o600);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
    this.ftsRowsByMessageId = null;
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = new Set(
      this.db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all()
        .map((row) => row.version)
    );

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare(
            'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)'
          )
          .run(migration.version, migration.name, nowIso());
      })();
    }
  }

  upsertAccount(account) {
    assertAccount(account);
    const timestamp = nowIso();
    return this.db
      .prepare(
        `INSERT INTO accounts(id, provider, display_name, enabled, created_at, updated_at)
         VALUES (@id, @provider, @displayName, 1, @timestamp, @timestamp)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           display_name = excluded.display_name,
           updated_at = excluded.updated_at
         WHERE accounts.provider IS NOT excluded.provider
            OR accounts.display_name IS NOT excluded.display_name`
      )
      .run({ ...account, timestamp }).changes;
  }

  upsertFolder(accountId, folder) {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO folders(
           account_id, provider_folder_id, display_name, kind, excluded, raw_json, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, provider_folder_id) DO UPDATE SET
           display_name = excluded.display_name,
           kind = excluded.kind,
           excluded = excluded.excluded,
           raw_json = excluded.raw_json,
           last_seen_at = excluded.last_seen_at`
      )
      .run(
        accountId,
        folder.providerFolderId,
        folder.displayName || '',
        folder.kind || null,
        bool(folder.excluded) || 0,
        json(folder.raw),
        timestamp
      );
  }

  registerBlob(blob) {
    this.db
      .prepare(
        `INSERT INTO blobs(hash, kind, relative_path, size, media_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET
           size = excluded.size,
           media_type = COALESCE(excluded.media_type, blobs.media_type)`
      )
      .run(
        blob.hash,
        blob.kind,
        blob.relativePath,
        blob.size,
        blob.mediaType || null,
        nowIso()
      );
  }

  stageMessage(accountId, message, rawBlob) {
    assertMessage(message);
    const timestamp = nowIso();
    const attachments = message.attachments || [];
    const archiveState =
      attachments.length > 0
        ? 'archived_pending_attachments'
        : 'archived_complete';

    const stage = this.db.transaction(() => {
      if (rawBlob) this.registerBlob(rawBlob);

      const result = this.db
        .prepare(
          `INSERT INTO messages(
             account_id, provider_message_id, provider_thread_id, internet_message_id,
             subject, sent_at, received_at, provider_created_at, provider_modified_at,
             direction, body_text, body_html, body_content_type, body_preview,
             importance, is_read, has_attachments, raw_blob_hash, source_json,
             archive_state, current_eligible, deleted_remote,
             first_archived_at, last_seen_at, updated_at
           ) VALUES (
             @accountId, @providerMessageId, @providerThreadId, @internetMessageId,
             @subject, @sentAt, @receivedAt, @providerCreatedAt, @providerModifiedAt,
             @direction, @bodyText, @bodyHtml, @bodyContentType, @bodyPreview,
             @importance, @isRead, @hasAttachments, @rawBlobHash, @sourceJson,
             @archiveState, @currentEligible, 0,
             @timestamp, @timestamp, @timestamp
           )
           ON CONFLICT(account_id, provider_message_id) DO UPDATE SET
             provider_thread_id = excluded.provider_thread_id,
             internet_message_id = excluded.internet_message_id,
             subject = excluded.subject,
             sent_at = excluded.sent_at,
             received_at = excluded.received_at,
             provider_created_at = excluded.provider_created_at,
             provider_modified_at = excluded.provider_modified_at,
             direction = excluded.direction,
             body_text = excluded.body_text,
             body_html = excluded.body_html,
             body_content_type = excluded.body_content_type,
             body_preview = excluded.body_preview,
             importance = excluded.importance,
             is_read = excluded.is_read,
             has_attachments = excluded.has_attachments,
             raw_blob_hash = COALESCE(excluded.raw_blob_hash, messages.raw_blob_hash),
             source_json = excluded.source_json,
             current_eligible = excluded.current_eligible,
             deleted_remote = 0,
             last_seen_at = excluded.last_seen_at,
             updated_at = excluded.updated_at
           RETURNING id`
        )
        .get({
          accountId,
          providerMessageId: message.providerMessageId,
          providerThreadId: message.providerThreadId || null,
          internetMessageId: message.internetMessageId || null,
          subject: message.subject || '',
          sentAt: message.sentAt || null,
          receivedAt: message.receivedAt || null,
          providerCreatedAt: message.providerCreatedAt || null,
          providerModifiedAt: message.providerModifiedAt || null,
          direction: message.direction || 'unknown',
          bodyText: message.bodyText || '',
          bodyHtml: message.bodyHtml || '',
          bodyContentType: message.bodyContentType || null,
          bodyPreview: message.bodyPreview || '',
          importance: message.importance || null,
          isRead: bool(message.isRead),
          hasAttachments: bool(
            message.hasAttachments || attachments.length > 0
          ),
          rawBlobHash: rawBlob?.hash || null,
          sourceJson: json(message.source),
          archiveState,
          currentEligible: message.currentEligible === false ? 0 : 1,
          timestamp,
        });

      const messageId = result.id;
      this.replaceRecipients(messageId, message.recipients || []);
      this.replaceLocations(messageId, message.locations || [], timestamp);
      this.retireAbsentIncompleteAttachments(messageId, attachments, timestamp);
      this.upsertAttachments(messageId, attachments, timestamp);
      this.refreshMessageState(messageId);
      this.refreshFts(messageId, accountId, message);

      return this.getMessageById(messageId);
    });
    try {
      return stage();
    } catch (error) {
      // refreshFts maintains an in-memory rowid map. A surrounding transaction
      // rollback invalidates any cache update made before the failure.
      this.ftsRowsByMessageId = null;
      throw error;
    }
  }

  replaceRecipients(messageId, recipients) {
    this.db
      .prepare('DELETE FROM recipients WHERE message_id = ?')
      .run(messageId);
    const insert = this.db.prepare(
      `INSERT INTO recipients(
         message_id, recipient_type, ordinal, address, display_name
       ) VALUES (?, ?, ?, ?, ?)`
    );
    recipients.forEach((recipient, index) => {
      insert.run(
        messageId,
        recipient.type,
        recipient.ordinal ?? index,
        recipient.address || '',
        recipient.displayName || ''
      );
    });
  }

  replaceLocations(messageId, locations, timestamp) {
    this.db
      .prepare('DELETE FROM message_locations WHERE message_id = ?')
      .run(messageId);
    const insert = this.db.prepare(
      `INSERT INTO message_locations(
         message_id, provider_location_id, display_name, kind, last_seen_at
       ) VALUES (?, ?, ?, ?, ?)`
    );
    for (const location of locations) {
      insert.run(
        messageId,
        location.providerLocationId,
        location.displayName || '',
        location.kind || null,
        timestamp
      );
    }
  }

  upsertAttachments(messageId, attachments, timestamp) {
    const statement = this.db.prepare(
      `INSERT INTO attachments(
         message_id, provider_attachment_id, file_name, media_type, size,
         content_id, is_inline, archive_state, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(message_id, provider_attachment_id) DO UPDATE SET
         file_name = excluded.file_name,
         media_type = excluded.media_type,
         size = excluded.size,
         content_id = excluded.content_id,
         is_inline = excluded.is_inline,
         current_eligible = 1,
         retired_at = NULL,
         retirement_reason = NULL,
         retirement_evidence_digest = NULL,
         updated_at = excluded.updated_at`
    );
    for (const attachment of attachments) {
      statement.run(
        messageId,
        attachment.providerAttachmentId,
        attachment.fileName || '',
        attachment.mediaType || null,
        attachment.size ?? null,
        attachment.contentId || null,
        bool(attachment.isInline) || 0,
        timestamp
      );
    }
  }

  retireAbsentIncompleteAttachments(messageId, attachments, timestamp) {
    const providerAttachmentIds = attachments.map(
      (attachment) => attachment.providerAttachmentId
    );
    if (
      providerAttachmentIds.some(
        (providerAttachmentId) =>
          typeof providerAttachmentId !== 'string' || !providerAttachmentId
      )
    ) {
      throw new Error('Provider attachment IDs must be non-empty strings');
    }
    const currentIds = new Set(providerAttachmentIds);
    if (currentIds.size !== providerAttachmentIds.length) {
      throw new Error('Provider attachment manifest contains duplicate IDs');
    }
    const absent = this.db
      .prepare(
        `SELECT id, provider_attachment_id, archive_state, blob_hash
         FROM attachments
         WHERE message_id = ?
           AND current_eligible = 1
           AND archive_state != 'complete'
         ORDER BY provider_attachment_id`
      )
      .all(messageId)
      .filter((row) => !currentIds.has(row.provider_attachment_id));
    if (absent.length === 0) return 0;
    if (absent.some((row) => row.blob_hash !== null)) {
      throw new Error(
        'ATTACHMENT_RETIREMENT_CONTENT_PRESENT: refusing to retire attachment content'
      );
    }
    const evidenceDigest = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          schema: 'authoritative-attachment-manifest.v1',
          messageId,
          providerAttachmentIds: [...currentIds].sort(),
        })
      )
      .digest('hex');
    const retire = this.db.prepare(
      `UPDATE attachments
       SET current_eligible = 0,
           retired_at = ?,
           retirement_reason = 'absent_from_authoritative_provider_manifest',
           retirement_evidence_digest = ?,
           updated_at = ?
       WHERE id = ?
         AND current_eligible = 1
         AND archive_state != 'complete'
         AND blob_hash IS NULL`
    );
    let retired = 0;
    for (const row of absent) {
      retired += retire.run(
        timestamp,
        evidenceDigest,
        timestamp,
        row.id
      ).changes;
    }
    if (retired !== absent.length) {
      throw new Error(
        'ATTACHMENT_RETIREMENT_PRECONDITION_CHANGED: attachment state changed during reconciliation'
      );
    }
    this.db
      .prepare(
        `INSERT INTO message_events(
           message_id, event_type, occurred_at, details_json
         ) VALUES (?, 'attachment_manifest_reconciled', ?, ?)`
      )
      .run(
        messageId,
        timestamp,
        json({
          retiredIncompleteAttachments: retired,
          reason: 'absent_from_authoritative_provider_manifest',
          evidenceDigest,
        })
      );
    return retired;
  }

  refreshFts(messageId, accountId, message) {
    if (!this.ftsRowsByMessageId) {
      const index = scanFtsIndex(this.db);
      if (index.duplicateRows !== 0) {
        throw new Error('FTS message index contains duplicate rows');
      }
      this.ftsRowsByMessageId = index.rowsByMessageId;
    }
    const key = messageKey(messageId);
    const existing = this.ftsRowsByMessageId.get(key);
    if (
      existing &&
      this.db.prepare(FTS_ROW_DELETE_SQL).run(existing.fts_rowid, messageId)
        .changes !== 1
    ) {
      this.ftsRowsByMessageId = null;
      throw new Error('FTS message index changed during refresh');
    }
    this.ftsRowsByMessageId.delete(key);
    const participants = (message.recipients || [])
      .flatMap((recipient) => [recipient.displayName, recipient.address])
      .filter(Boolean)
      .join(' ');
    const inserted = this.db
      .prepare(
        `INSERT INTO messages_fts(message_id, account_id, subject, body, participants)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        messageId,
        accountId,
        message.subject || '',
        [message.bodyText, message.bodyPreview].filter(Boolean).join('\n'),
        participants
      );
    this.ftsRowsByMessageId.set(key, {
      fts_rowid: inserted.lastInsertRowid,
      message_id: messageId,
      account_id: accountId,
    });
  }

  completeAttachment(messageId, providerAttachmentId, blob) {
    return this.db.transaction(() => {
      this.registerBlob(blob);
      const result = this.db
        .prepare(
          `UPDATE attachments
           SET blob_hash = ?, archive_state = 'complete', last_error = NULL, updated_at = ?
           WHERE message_id = ? AND provider_attachment_id = ?`
        )
        .run(blob.hash, nowIso(), messageId, providerAttachmentId);
      if (result.changes !== 1) {
        throw new Error('Attachment record was not found');
      }
      this.refreshMessageState(messageId);
      return this.getMessageById(messageId);
    })();
  }

  /**
   * Domains you have actually sent mail to — the known-correspondent signal.
   *
   * The triage router's known-correspondent veto read `message.knownDomains`, which no
   * production caller ever supplied, so the veto never fired and every message took an
   * unconditional confidence penalty. The comment claimed "the CRM already knows every
   * client domain, so this needs no new data" — true, and never wired to anything.
   *
   * Outbound mail is a better source than the CRM anyway, and it is already here: you
   * do not send email to marketing lists, so a domain in your Sent items is a genuine
   * correspondent. Derived from ~1.7k outbound messages, ~155 distinct domains.
   *
   * Cached for the process lifetime — this is a slow-moving set and the classifier runs
   * once per archived message.
   */
  getKnownDomains() {
    if (this._knownDomains) return this._knownDomains;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT lower(substr(r.address, instr(r.address, '@') + 1)) AS domain
           FROM recipients r
           JOIN messages m ON m.id = r.message_id
          WHERE m.direction = 'outbound'
            AND r.recipient_type IN ('to', 'cc')
            AND instr(r.address, '@') > 0`
      )
      .all();
    this._knownDomains = rows.map((r) => r.domain).filter(Boolean);
    return this._knownDomains;
  }

  /**
   * Look up a security verdict by CONTENT hash.
   *
   * Identical bytes have an identical verdict, so a signature image that appears in
   * 369 messages is scanned once rather than 369 times. Returns null when this
   * content has never been scanned.
   */
  getBlobSecurity(blobHash) {
    if (!blobHash) return null;
    const row = this.db
      .prepare(
        'SELECT status, scanner, scanner_version, reason FROM attachment_security_blob WHERE blob_hash = ?'
      )
      .get(blobHash);
    if (!row) return null;
    return {
      status: row.status,
      scanner: row.scanner,
      scannerVersion: row.scanner_version,
      reason: row.reason,
      fromCache: true,
    };
  }

  /** Record a verdict against content, so every future occurrence reuses it. */
  recordBlobSecurity(blobHash, result) {
    if (!blobHash) return;
    this.db
      .prepare(
        `INSERT INTO attachment_security_blob(blob_hash, status, scanner, scanner_version, reason, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(blob_hash) DO UPDATE SET status = excluded.status,
         scanner = excluded.scanner, scanner_version = excluded.scanner_version,
         reason = excluded.reason, scanned_at = excluded.scanned_at`
      )
      .run(
        blobHash,
        result.status,
        result.scanner,
        result.scannerVersion ?? null,
        result.reason ?? null,
        nowIso()
      );
  }

  recordAttachmentSecurity(messageId, providerAttachmentId, result) {
    const attachment = this.db
      .prepare(
        'SELECT id FROM attachments WHERE message_id = ? AND provider_attachment_id = ?'
      )
      .get(messageId, providerAttachmentId);
    if (!attachment) throw new Error('Attachment record was not found');
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO attachment_security(attachment_id, status, scanner, scanner_version, reason, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(attachment_id) DO UPDATE SET status = excluded.status,
         scanner = excluded.scanner, scanner_version = excluded.scanner_version,
         reason = excluded.reason, scanned_at = excluded.scanned_at`
      )
      .run(
        attachment.id,
        result.status,
        result.scanner,
        result.scannerVersion || null,
        result.reason || null,
        timestamp
      );
    this.db
      .prepare(
        `INSERT INTO security_events(message_id, attachment_id, event_type, status, details_json, occurred_at)
       VALUES (?, ?, 'attachment_scan', ?, ?, ?)`
      )
      .run(
        messageId,
        attachment.id,
        result.status,
        JSON.stringify(result),
        timestamp
      );
    return result;
  }

  markAttachmentFailure(messageId, providerAttachmentId, errorMessage) {
    this.db
      .prepare(
        `UPDATE attachments
         SET archive_state = 'retryable_error', last_error = ?, updated_at = ?
         WHERE message_id = ? AND provider_attachment_id = ?`
      )
      .run(
        String(errorMessage).slice(0, 1000),
        nowIso(),
        messageId,
        providerAttachmentId
      );
    this.refreshMessageState(messageId);
  }

  refreshMessageState(messageId) {
    const pending = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM attachments
         WHERE message_id = ?
           AND current_eligible = 1
           AND archive_state != 'complete'`
      )
      .get(messageId).count;
    const archiveState =
      pending > 0 ? 'archived_pending_attachments' : 'archived_complete';
    this.db
      .prepare(
        'UPDATE messages SET archive_state = ?, updated_at = ? WHERE id = ?'
      )
      .run(archiveState, nowIso(), messageId);
  }

  enqueueDelivery(messageId, destinations, packageRoot = null) {
    const enabled = this.db
      .prepare(
        `SELECT a.enabled
         FROM messages m
         JOIN accounts a ON a.id = m.account_id
         WHERE m.id = ?`
      )
      .get(messageId)?.enabled;
    if (enabled !== 1) {
      throw new Error('DELIVERY_ACCOUNT_DISABLED');
    }
    const timestamp = nowIso();
    const insert = this.db.prepare(
      `INSERT INTO delivery_jobs(message_id, destination, package_root, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(message_id, destination) DO UPDATE SET package_root = COALESCE(excluded.package_root, delivery_jobs.package_root)`
    );
    const event = this.db.prepare(
      `INSERT INTO delivery_events(delivery_job_id, event_type, details_json, occurred_at)
       VALUES (?, 'enqueued', ?, ?)`
    );
    return this.db.transaction(() =>
      destinations.map((destination) => {
        insert.run(messageId, destination, packageRoot, timestamp, timestamp);
        const job = this.db
          .prepare(
            'SELECT id FROM delivery_jobs WHERE message_id = ? AND destination = ?'
          )
          .get(messageId, destination);
        event.run(job.id, JSON.stringify({ destination }), timestamp);
        return job.id;
      })
    )();
  }

  listDeliveryJobs(status = null) {
    if (status) {
      return this.db
        .prepare(
          `SELECT dj.*
           FROM delivery_jobs dj
           JOIN messages m ON m.id = dj.message_id
           JOIN accounts a ON a.id = m.account_id AND a.enabled = 1
           WHERE dj.status = ?
           ORDER BY dj.updated_at`
        )
        .all(status);
    }
    return this.db
      .prepare(
        `SELECT dj.*
         FROM delivery_jobs dj
         JOIN messages m ON m.id = dj.message_id
         JOIN accounts a ON a.id = m.account_id AND a.enabled = 1
         ORDER BY dj.updated_at`
      )
      .all();
  }

  listMessagesArchivedSince(timestamp) {
    return this.db
      .prepare(
        `SELECT m.id
         FROM messages m
         JOIN accounts a ON a.id = m.account_id AND a.enabled = 1
         WHERE m.first_archived_at >= ?
         ORDER BY m.id`
      )
      .all(timestamp)
      .map((row) => this.getMessageById(row.id));
  }

  /**
   * Attachments that are fully archived but hold no terminal security verdict — the
   * backfill scanner's work list. Covers rows never scanned (bulk hydrate/backfill left
   * ~20k with no attachment_security row) and rows stuck on the non-terminal
   * 'scanner_unavailable' from a past ClamAV outage.
   */
  listAttachmentsPendingSecurity(limit = 500) {
    return this.db
      .prepare(
        `SELECT a.id, a.message_id, a.provider_attachment_id, a.file_name, a.blob_hash
           FROM attachments a
           JOIN messages m ON m.id = a.message_id
           JOIN accounts account
             ON account.id = m.account_id AND account.enabled = 1
           LEFT JOIN attachment_security s ON s.attachment_id = a.id
          WHERE a.archive_state = 'complete'
            AND a.current_eligible = 1
            AND a.blob_hash IS NOT NULL
            AND (s.attachment_id IS NULL
                 OR s.status NOT IN ('safe', 'quarantined', 'blocked'))
          ORDER BY a.id
          LIMIT ?`
      )
      .all(limit);
  }

  proposeDeliveries(messageId, triage) {
    const enabled = this.db
      .prepare(
        `SELECT account.enabled
         FROM messages m
         JOIN accounts account ON account.id = m.account_id
         WHERE m.id = ?`
      )
      .get(messageId)?.enabled;
    if (enabled !== 1) {
      return {
        status: 'review',
        reason: 'account-disabled',
        jobs: [],
      };
    }
    const unsafe = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM attachments a
       LEFT JOIN attachment_security s ON s.attachment_id = a.id
       WHERE a.message_id = ?
         AND a.current_eligible = 1
         AND (a.archive_state != 'complete' OR s.status != 'safe')`
      )
      .get(messageId).count;
    if (unsafe > 0) {
      return {
        status: 'review',
        reason: 'attachments-not-security-approved',
        jobs: [],
      };
    }
    if (triage.disposition !== 'proposed' || !triage.destinations?.length) {
      return {
        status: 'review',
        reason: triage.reason || 'triage-review-required',
        jobs: [],
      };
    }
    return {
      status: 'proposed',
      reason: triage.reason,
      jobs: this.enqueueDelivery(messageId, triage.destinations),
    };
  }

  updateDeliveryJob(jobId, status, details = {}) {
    const allowed = new Set([
      'pending',
      'running',
      'delivered',
      'rejected',
      'failed',
      'review',
    ]);
    if (!allowed.has(status)) {
      throw new Error(`Unsupported delivery status: ${status}`);
    }
    const timestamp = nowIso();
    const result = this.db
      .prepare(
        `UPDATE delivery_jobs SET status = ?, attempts = attempts + ?,
         manifest_digest = COALESCE(?, manifest_digest),
         destination_record_id = COALESCE(?, destination_record_id),
         last_error = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        status,
        status === 'running' ? 1 : 0,
        details.manifestDigest || null,
        details.destinationRecordId || null,
        details.error || null,
        timestamp,
        jobId
      );
    if (result.changes !== 1) {
      throw new Error(`Delivery job not found: ${jobId}`);
    }
    this.db
      .prepare(
        `INSERT INTO delivery_events(delivery_job_id, event_type, details_json, occurred_at)
       VALUES (?, ?, ?, ?)`
      )
      .run(jobId, status, JSON.stringify(details), timestamp);
    return this.db
      .prepare('SELECT * FROM delivery_jobs WHERE id = ?')
      .get(jobId);
  }

  recordTombstone(accountId, providerMessageId, details = {}) {
    return this.db.transaction(() => {
      const message = this.db
        .prepare(
          `SELECT id FROM messages
           WHERE account_id = ? AND provider_message_id = ?`
        )
        .get(accountId, providerMessageId);
      if (!message) return false;
      const timestamp = nowIso();
      this.db
        .prepare(
          `UPDATE messages
           SET current_eligible = 0, deleted_remote = 1, last_seen_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(timestamp, timestamp, message.id);
      this.db
        .prepare(
          `INSERT INTO message_events(message_id, event_type, occurred_at, details_json)
           VALUES (?, 'remote_deletion', ?, ?)`
        )
        .run(message.id, timestamp, json(details));
      return true;
    })();
  }

  getMessageById(messageId) {
    const message = this.db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(messageId);
    if (!message) return null;
    message.recipients = this.db
      .prepare(
        `SELECT recipient_type, ordinal, address, display_name
         FROM recipients WHERE message_id = ? ORDER BY recipient_type, ordinal`
      )
      .all(messageId);
    message.locations = this.db
      .prepare(
        `SELECT provider_location_id, display_name, kind
         FROM message_locations WHERE message_id = ? ORDER BY provider_location_id`
      )
      .all(messageId);
    message.attachments = this.db
      .prepare(
        `SELECT provider_attachment_id, file_name, media_type, size, content_id,
                is_inline, blob_hash, archive_state, last_error
         FROM attachments
         WHERE message_id = ? AND current_eligible = 1
         ORDER BY provider_attachment_id`
      )
      .all(messageId);
    return message;
  }

  getMessage(accountId, providerMessageId) {
    const row = this.db
      .prepare(
        `SELECT id FROM messages
         WHERE account_id = ? AND provider_message_id = ?`
      )
      .get(accountId, providerMessageId);
    return row ? this.getMessageById(row.id) : null;
  }

  search(
    query,
    {
      accountId = null,
      limit = 50,
      after = null,
      before = null,
      includeDisabled = false,
    } = {}
  ) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
    const afterIso = after ? this.normalizedSearchDate(after, 'after') : null;
    const beforeIso = before
      ? this.normalizedSearchDate(before, 'before')
      : null;
    if (!query || !query.trim()) {
      if (!afterIso && !beforeIso) return [];
      return this.db
        .prepare(
          `SELECT m.id, m.account_id, m.provider_message_id, m.subject,
                  m.received_at, m.sent_at, m.archive_state, m.current_eligible,
                  NULL AS rank
           FROM messages m
           JOIN accounts a ON a.id = m.account_id
           WHERE (? = 1 OR a.enabled = 1)
             AND (? IS NULL OR m.account_id = ?)
             AND (? IS NULL OR COALESCE(m.received_at, m.sent_at) >= ?)
             AND (? IS NULL OR COALESCE(m.received_at, m.sent_at) < ?)
           ORDER BY COALESCE(m.received_at, m.sent_at) DESC
           LIMIT ?`
        )
        .all(
          includeDisabled ? 1 : 0,
          accountId,
          accountId,
          afterIso,
          afterIso,
          beforeIso,
          beforeIso,
          safeLimit
        );
    }
    return this.db
      .prepare(
        `SELECT m.id, m.account_id, m.provider_message_id, m.subject,
                m.received_at, m.sent_at, m.archive_state, m.current_eligible,
                bm25(messages_fts) AS rank
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.message_id
         JOIN accounts a ON a.id = m.account_id
         WHERE messages_fts MATCH ?
           AND (? = 1 OR a.enabled = 1)
           AND (? IS NULL OR m.account_id = ?)
           AND (? IS NULL OR COALESCE(m.received_at, m.sent_at) >= ?)
           AND (? IS NULL OR COALESCE(m.received_at, m.sent_at) < ?)
         ORDER BY rank, COALESCE(m.received_at, m.sent_at) DESC
         LIMIT ?`
      )
      .all(
        query,
        includeDisabled ? 1 : 0,
        accountId,
        accountId,
        afterIso,
        afterIso,
        beforeIso,
        beforeIso,
        safeLimit
      );
  }

  normalizedSearchDate(value, label) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid ${label} search date: ${value}`);
    }
    return date.toISOString();
  }

  setCursor(accountId, scope, cursor, metadata = null) {
    this.db
      .prepare(
        `INSERT INTO sync_cursors(account_id, scope, cursor, status, metadata_json, updated_at)
         VALUES (?, ?, ?, 'ready', ?, ?)
         ON CONFLICT(account_id, scope) DO UPDATE SET
           cursor = excluded.cursor,
           status = excluded.status,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`
      )
      .run(accountId, scope, cursor, json(metadata), nowIso());
  }

  getCursor(accountId, scope) {
    return (
      this.db
        .prepare(
          `SELECT cursor, status, metadata_json, updated_at
           FROM sync_cursors WHERE account_id = ? AND scope = ?`
        )
        .get(accountId, scope) || null
    );
  }

  clearCursor(accountId, scope) {
    return this.db
      .prepare('DELETE FROM sync_cursors WHERE account_id = ? AND scope = ?')
      .run(accountId, scope).changes;
  }

  beginRun(accountId, runType, details = null) {
    return this.db
      .prepare(
        `INSERT INTO ingestion_runs(
           account_id, run_type, started_at, status, details_json
         ) VALUES (?, ?, ?, 'running', ?)`
      )
      .run(accountId || null, runType, nowIso(), json(details)).lastInsertRowid;
  }

  finishRun(runId, status, counts = {}, details = null) {
    if (!['completed', 'failed', 'interrupted'].includes(status)) {
      throw new Error(`Invalid ingestion run status: ${status}`);
    }
    this.db
      .prepare(
        `UPDATE ingestion_runs
         SET finished_at = ?, status = ?, discovered_count = ?,
             archived_count = ?, error_count = ?, details_json = ?
         WHERE id = ?`
      )
      .run(
        nowIso(),
        status,
        counts.discovered || 0,
        counts.archived || 0,
        counts.errors || 0,
        json(details),
        runId
      );
  }

  interruptRunningRuns(
    reason = 'worker_recovered_after_interruption',
    { accountIds = null } = {}
  ) {
    const scopedAccountIds =
      accountIds === null
        ? null
        : [...new Set(accountIds.filter((accountId) => accountId))];
    if (scopedAccountIds?.length === 0) return 0;
    const accountScope = scopedAccountIds
      ? ` AND account_id IN (${scopedAccountIds.map(() => '?').join(',')})`
      : '';
    return this.db
      .prepare(
        `UPDATE ingestion_runs
         SET finished_at = ?, status = 'interrupted',
             details_json = COALESCE(details_json, ?)
         WHERE status = 'running'${accountScope}`
      )
      .run(nowIso(), json({ reason }), ...(scopedAccountIds || [])).changes;
  }

  recordIngestionError({
    runId = null,
    accountId = null,
    providerMessageId = null,
    stage,
    code = null,
    message,
    retryable = true,
  }) {
    this.db
      .prepare(
        `INSERT INTO ingestion_errors(
           run_id, account_id, provider_message_id, stage, error_code,
           error_message, retryable, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        runId,
        accountId,
        providerMessageId,
        stage,
        code,
        String(message || 'Unknown ingestion error').slice(0, 1000),
        retryable ? 1 : 0,
        nowIso()
      );
  }

  resolveIngestionErrors(
    accountId,
    providerMessageId,
    { runId = null, resolutionCode = 'MESSAGE_ARCHIVED_COMPLETE' } = {}
  ) {
    return this.db
      .prepare(
        `UPDATE ingestion_errors
         SET resolved_at = ?, resolution_run_id = ?, resolution_code = ?
         WHERE account_id = ?
           AND provider_message_id = ?
           AND stage IN ('message', 'message_fetch', 'attachment', 'tombstone')
           AND resolved_at IS NULL`
      )
      .run(nowIso(), runId, resolutionCode, accountId, providerMessageId)
      .changes;
  }

  resolveAccountCycleErrors({ accountId, successfulRunId, resolutionCode }) {
    if (
      ![
        'GMAIL_IDENTITY_VERIFIED_HEALTHY_CYCLE',
        'OUTLOOK_IDENTITY_VERIFIED_HEALTHY_CYCLE',
        'PROVIDER_HEALTHY_CYCLE',
      ].includes(resolutionCode)
    ) {
      throw new Error(
        'A deterministic account-cycle resolution code is required'
      );
    }
    const run = this.db
      .prepare(
        `SELECT id, account_id, run_type, status, error_count, finished_at
         FROM ingestion_runs WHERE id = ?`
      )
      .get(successfulRunId);
    if (
      !run ||
      run.account_id !== accountId ||
      run.run_type !== 'scheduled_cycle' ||
      run.status !== 'completed' ||
      run.error_count !== 0 ||
      !run.finished_at
    ) {
      throw new Error(
        'Account-cycle errors require a completed zero-error run for the same account'
      );
    }
    return this.db
      .prepare(
        `UPDATE ingestion_errors
         SET resolved_at = ?, resolution_run_id = ?, resolution_code = ?
         WHERE account_id = ?
           AND provider_message_id IS NULL
           AND stage = 'account_cycle'
           AND resolved_at IS NULL
           AND created_at <= ?`
      )
      .run(
        nowIso(),
        successfulRunId,
        resolutionCode,
        accountId,
        run.finished_at
      ).changes;
  }

  resolveReconciledIngestionErrors({
    accountId,
    successfulRunId,
    resolutionCode,
  }) {
    if (
      ![
        'GMAIL_IDENTITY_VERIFIED_FULL_RECONCILIATION',
        'OUTLOOK_IDENTITY_VERIFIED_FULL_RECONCILIATION',
        'PROVIDER_FULL_RECONCILIATION',
      ].includes(resolutionCode)
    ) {
      throw new Error(
        'A deterministic reconciliation resolution code is required'
      );
    }
    const run = this.db
      .prepare(
        `SELECT id, account_id, run_type, status, error_count, finished_at,
                details_json
         FROM ingestion_runs WHERE id = ?`
      )
      .get(successfulRunId);
    const details = (() => {
      try {
        return JSON.parse(run?.details_json || '{}');
      } catch {
        return {};
      }
    })();
    if (
      !run ||
      run.account_id !== accountId ||
      run.run_type !== 'reconciliation' ||
      run.status !== 'completed' ||
      run.error_count !== 0 ||
      !run.finished_at ||
      details.differences !== 0
    ) {
      throw new Error(
        'Reconciliation errors require a zero-difference completed run for the same account'
      );
    }
    return this.db.transaction(() => {
      const reconciliations = this.db
        .prepare(
          `UPDATE ingestion_errors
           SET resolved_at = ?, resolution_run_id = ?, resolution_code = ?
           WHERE account_id = ?
             AND provider_message_id IS NULL
             AND stage = 'reconciliation'
             AND resolved_at IS NULL
             AND created_at <= ?`
        )
        .run(
          nowIso(),
          successfulRunId,
          resolutionCode,
          accountId,
          run.finished_at
        ).changes;
      const messageScoped = this.db
        .prepare(
          `UPDATE ingestion_errors
           SET resolved_at = ?, resolution_run_id = ?, resolution_code = ?
           WHERE account_id = ?
             AND provider_message_id IS NOT NULL
             AND stage IN ('message', 'message_fetch', 'attachment', 'tombstone')
             AND resolved_at IS NULL
             AND created_at <= ?
             AND EXISTS (
               SELECT 1 FROM messages
               WHERE messages.account_id = ingestion_errors.account_id
                 AND messages.provider_message_id = ingestion_errors.provider_message_id
                 AND (
                   messages.archive_state = 'archived_complete'
                   OR (
                     messages.current_eligible = 0
                     AND messages.deleted_remote = 1
                   )
                 )
             )`
        )
        .run(
          nowIso(),
          successfulRunId,
          resolutionCode,
          accountId,
          run.finished_at
        ).changes;
      return { reconciliations, messageScoped };
    })();
  }

  listProviderMessageIds(accountId, { currentEligible = null } = {}) {
    return this.db
      .prepare(
        `SELECT provider_message_id
         FROM messages
         WHERE account_id = ?
           AND (? IS NULL OR current_eligible = ?)
         ORDER BY provider_message_id`
      )
      .all(accountId, currentEligible, currentEligible)
      .map((row) => row.provider_message_id);
  }

  pendingAttachments(accountId, limit = 100) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
    return this.db
      .prepare(
        `SELECT a.*, m.provider_message_id, m.account_id
         FROM attachments a
         JOIN messages m ON m.id = a.message_id
         WHERE m.account_id = ?
           AND a.current_eligible = 1
           AND a.archive_state != 'complete'
         ORDER BY a.updated_at, a.id
         LIMIT ?`
      )
      .all(accountId, safeLimit);
  }

  recentRuns(limit = 20, { includeDisabled = false } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 200));
    return this.db
      .prepare(
        `SELECT ir.id, ir.account_id, ir.run_type, ir.started_at,
                ir.finished_at, ir.status, ir.discovered_count,
                ir.archived_count, ir.error_count, ir.details_json
         FROM ingestion_runs ir
         LEFT JOIN accounts a ON a.id = ir.account_id
         WHERE ? = 1 OR ir.account_id IS NULL OR a.enabled = 1
         ORDER BY ir.id DESC LIMIT ?`
      )
      .all(includeDisabled ? 1 : 0, safeLimit);
  }

  unresolvedErrors(limit = 50, { includeDisabled = false } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
    return this.db
      .prepare(
        `SELECT ie.id, ie.run_id, ie.account_id, ie.provider_message_id,
                ie.stage, ie.error_code, ie.error_message, ie.retryable,
                ie.created_at
         FROM ingestion_errors ie
         LEFT JOIN accounts a ON a.id = ie.account_id
         WHERE ie.resolved_at IS NULL
           AND (? = 1 OR ie.account_id IS NULL OR a.enabled = 1)
         ORDER BY ie.id DESC LIMIT ?`
      )
      .all(includeDisabled ? 1 : 0, safeLimit);
  }

  listBlobs() {
    return this.db
      .prepare(
        `SELECT hash, kind, relative_path, size, media_type
         FROM blobs ORDER BY kind, hash`
      )
      .all();
  }

  status() {
    // The CLI serialises this object directly. Keep the richer operational
    // methods available to deterministic internals, but never place provider
    // message IDs, exception text, or arbitrary details JSON in routine status
    // output.
    const recentRuns = this.recentRuns(10).map(
      ({
        account_id,
        run_type,
        started_at,
        finished_at,
        status,
        discovered_count,
        archived_count,
        error_count,
      }) => ({
        account_id,
        run_type,
        started_at,
        finished_at,
        status,
        discovered_count,
        archived_count,
        error_count,
      })
    );
    const unresolvedErrors = this.db
      .prepare(
        `SELECT ie.account_id, ie.retryable,
                COUNT(*) AS error_count,
                MIN(ie.created_at) AS oldest_at,
                MAX(ie.created_at) AS newest_at
         FROM ingestion_errors ie
         LEFT JOIN accounts a ON a.id = ie.account_id
         WHERE ie.resolved_at IS NULL
           AND (ie.account_id IS NULL OR a.enabled = 1)
         GROUP BY ie.account_id, ie.retryable
         ORDER BY ie.account_id, ie.retryable`
      )
      .all();
    return {
      integrity: this.db.pragma('integrity_check', { simple: true }),
      accounts: this.db
        .prepare(
          `SELECT a.id, a.provider, a.display_name,
                  COUNT(m.id) AS message_count,
                  COALESCE(SUM(CASE WHEN m.archive_state = 'archived_complete' THEN 1 ELSE 0 END), 0) AS complete_count,
                  COALESCE(SUM(CASE WHEN m.archive_state = 'archived_pending_attachments' THEN 1 ELSE 0 END), 0) AS pending_count,
                  COALESCE(SUM(CASE WHEN m.deleted_remote = 1 THEN 1 ELSE 0 END), 0) AS tombstone_count
           FROM accounts a
           LEFT JOIN messages m ON m.account_id = a.id
           WHERE a.enabled = 1
           GROUP BY a.id
           ORDER BY a.id`
        )
        .all(),
      disabledAccounts: this.db
        .prepare(
          `SELECT a.id, a.provider, COUNT(m.id) AS message_count
           FROM accounts a
           LEFT JOIN messages m ON m.account_id = a.id
           WHERE a.enabled = 0
           GROUP BY a.id
           ORDER BY a.id`
        )
        .all(),
      recentRuns,
      unresolvedErrors,
    };
  }

  checkpoint() {
    return this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  close() {
    this.db.close();
  }
}

module.exports = {
  ArchiveDatabase,
  assertAccount,
  assertMessage,
  nowIso,
};
