const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { ArchiveService } = require('../../archive-worker/archive-service');
const { ArchiveDatabase } = require('../../archive-worker/database');
const { ContentStore, sha256 } = require('../../archive-worker/storage');
const { inspectFtsConsistency } = require('../../archive-worker/fts-index');
const { openArchive, verifyArchive } = require('../../archive-worker');

function fixtureMessage(overrides = {}) {
  return {
    providerMessageId: 'provider-message-1',
    providerThreadId: 'thread-1',
    internetMessageId: '<fixture-1@example.test>',
    subject: 'Contract renewal deadline',
    receivedAt: '2026-07-18T00:00:00.000Z',
    direction: 'inbound',
    bodyText: 'Please approve the renewal by tomorrow.',
    bodyPreview: 'Please approve the renewal',
    isRead: false,
    hasAttachments: true,
    recipients: [
      {
        type: 'from',
        address: 'supplier@example.test',
        displayName: 'Supplier',
      },
      {
        type: 'to',
        address: 'owner@example.test',
        displayName: 'Owner',
      },
    ],
    locations: [
      {
        providerLocationId: 'inbox',
        displayName: 'Inbox',
        kind: 'inbox',
      },
    ],
    attachments: [
      {
        providerAttachmentId: 'attachment-1',
        fileName: '../../unsafe-name.pdf',
        mediaType: 'application/pdf',
        size: 12,
      },
    ],
    source: { fixture: true },
    ...overrides,
  };
}

describe('private archive foundation', () => {
  let tempRoot;
  let database;
  let contentStore;
  let service;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'email-archive-test-'));
    database = new ArchiveDatabase(path.join(tempRoot, 'archive.sqlite3'));
    contentStore = new ContentStore(tempRoot);
    service = new ArchiveService({ database, contentStore });
    await service.initialise([
      {
        id: 'vitasci-outlook',
        provider: 'outlook',
        displayName: 'VitaSci Outlook',
      },
      {
        id: 'gmail-personal',
        provider: 'gmail',
        displayName: 'Personal Gmail',
      },
    ]);
  });

  afterEach(async () => {
    database.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('creates a durable schema and account status', () => {
    const status = database.status();
    expect(status.integrity).toBe('ok');
    expect(status.accounts).toEqual([
      expect.objectContaining({
        id: 'gmail-personal',
        provider: 'gmail',
        message_count: 0,
      }),
      expect.objectContaining({
        id: 'vitasci-outlook',
        provider: 'outlook',
        message_count: 0,
      }),
    ]);
    expect(
      database.db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all()
        .map((row) => row.version)
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test('routine status omits raw run details, provider IDs, and error text', () => {
    const runDetailsMarker = 'PRIVATE_RUN_DETAILS_MARKER';
    const providerIdMarker = 'PRIVATE_PROVIDER_ID_MARKER';
    const errorMessageMarker = 'PRIVATE_ERROR_MESSAGE_MARKER';
    const runId = database.beginRun('gmail-personal', 'scheduled_cycle', {
      marker: runDetailsMarker,
    });
    database.finishRun(
      runId,
      'failed',
      { discovered: 1, archived: 0, errors: 1 },
      { marker: runDetailsMarker }
    );
    database.recordIngestionError({
      runId,
      accountId: 'gmail-personal',
      providerMessageId: providerIdMarker,
      stage: 'message_fetch',
      code: 'SYNTHETIC_FAILURE',
      message: errorMessageMarker,
      retryable: true,
    });

    expect(database.recentRuns()[0].details_json).toContain(runDetailsMarker);
    expect(database.unresolvedErrors()[0]).toEqual(
      expect.objectContaining({
        provider_message_id: providerIdMarker,
        error_message: errorMessageMarker,
      })
    );
    const routineStatus = JSON.stringify(database.status());
    expect(routineStatus).not.toContain(runDetailsMarker);
    expect(routineStatus).not.toContain(providerIdMarker);
    expect(routineStatus).not.toContain(errorMessageMarker);
    expect(database.status().unresolvedErrors).toEqual([
      expect.objectContaining({
        account_id: 'gmail-personal',
        retryable: 1,
        error_count: 1,
      }),
    ]);
  });

  test('normal archive opening defers account registration to guarded cycles', async () => {
    const guardedRoot = path.join(tempRoot, 'guarded-open');
    const archive = await openArchive({
      ...process.env,
      EMAIL_ARCHIVE_ROOT: guardedRoot,
      EMAIL_ARCHIVE_OUTLOOK_EXPECTED_IDENTITY: 'outlook@example.test',
      EMAIL_ARCHIVE_GMAIL_ABLATIVE_EXPECTED_IDENTITY: 'ablative@example.test',
      EMAIL_ARCHIVE_GMAIL_PERSONAL_EXPECTED_IDENTITY: 'personal@example.test',
    });
    try {
      expect(
        archive.database.db
          .prepare('SELECT COUNT(*) AS count FROM accounts')
          .get().count
      ).toBe(0);
    } finally {
      archive.database.close();
    }
  });

  test('re-registering an unchanged account is an exact database no-op', () => {
    const account = {
      id: 'gmail-personal',
      provider: 'gmail',
      displayName: 'Personal Gmail',
    };
    const rowBefore = database.db
      .prepare('SELECT * FROM accounts WHERE id = ?')
      .get(account.id);
    const changesBefore = database.db
      .prepare('SELECT total_changes() AS count')
      .get().count;

    expect(database.upsertAccount(account)).toBe(0);

    expect(
      database.db.prepare('SELECT total_changes() AS count').get().count
    ).toBe(changesBefore);
    expect(
      database.db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id)
    ).toEqual(rowBefore);
  });

  test('invalidates the FTS rowid cache after a staging rollback', () => {
    const originalGetMessageById = database.getMessageById.bind(database);
    jest
      .spyOn(database, 'getMessageById')
      .mockImplementationOnce(() => {
        throw new Error('synthetic post-FTS rollback');
      })
      .mockImplementation(originalGetMessageById);
    const message = fixtureMessage({
      providerMessageId: 'fts-rollback-fixture',
      attachments: [],
      hasAttachments: false,
    });

    expect(() =>
      database.stageMessage('vitasci-outlook', message, null)
    ).toThrow('synthetic post-FTS rollback');
    expect(
      database.getMessage('vitasci-outlook', 'fts-rollback-fixture')
    ).toBeNull();
    expect(inspectFtsConsistency(database).summary).toEqual(
      expect.objectContaining({ messageRows: 0, ftsRows: 0, passed: true })
    );

    expect(database.stageMessage('vitasci-outlook', message, null)).toEqual(
      expect.objectContaining({
        provider_message_id: message.providerMessageId,
      })
    );
    expect(inspectFtsConsistency(database).summary).toEqual(
      expect.objectContaining({ messageRows: 1, ftsRows: 1, passed: true })
    );
  });

  test('stages raw content, searches it, and completes attachments', async () => {
    const raw = Buffer.from('From: supplier@example.test\n\nFixture body');
    let archived = await service.stageMessage(
      'vitasci-outlook',
      fixtureMessage(),
      raw
    );

    expect(archived.archive_state).toBe('archived_pending_attachments');
    expect(archived.raw_blob_hash).toBe(sha256(raw));
    expect(database.search('renewal')).toEqual([
      expect.objectContaining({
        account_id: 'vitasci-outlook',
        provider_message_id: 'provider-message-1',
      }),
    ]);

    archived = await service.completeAttachment(
      archived.id,
      'attachment-1',
      Buffer.from('pdf-fixture!'),
      'application/pdf'
    );
    expect(archived.archive_state).toBe('archived_complete');
    expect(archived.attachments[0]).toEqual(
      expect.objectContaining({
        archive_state: 'complete',
        blob_hash: sha256(Buffer.from('pdf-fixture!')),
      })
    );
  });

  test('is idempotent and keeps attachment content deduplicated', async () => {
    const raw = Buffer.from('raw fixture');
    const first = await service.stageMessage(
      'vitasci-outlook',
      fixtureMessage(),
      raw
    );
    const second = await service.stageMessage(
      'vitasci-outlook',
      fixtureMessage({ subject: 'Updated subject' }),
      raw
    );

    expect(second.id).toBe(first.id);
    expect(second.subject).toBe('Updated subject');
    expect(database.status().accounts[1].message_count).toBe(1);

    const content = Buffer.from('shared attachment bytes');
    await service.completeAttachment(
      second.id,
      'attachment-1',
      content,
      'application/pdf'
    );
    const repeatedComplete = await service.stageMessage(
      'vitasci-outlook',
      fixtureMessage({ subject: 'Restaged after attachment completion' }),
      raw
    );
    expect(repeatedComplete.archive_state).toBe('archived_complete');

    const other = await service.stageMessage(
      'vitasci-outlook',
      fixtureMessage({
        providerMessageId: 'provider-message-2',
        attachments: [
          {
            providerAttachmentId: 'attachment-2',
            fileName: 'copy.pdf',
          },
        ],
      }),
      Buffer.from('other raw fixture')
    );
    await service.completeAttachment(
      other.id,
      'attachment-2',
      content,
      'application/pdf'
    );

    const blobCount = database.db
      .prepare("SELECT COUNT(*) AS count FROM blobs WHERE kind = 'attachment'")
      .get().count;
    expect(blobCount).toBe(1);
  });

  test('retires provider-absent incomplete metadata without deleting content', async () => {
    const raw = Buffer.from('authoritative attachment manifest fixture');
    const currentAttachment = {
      providerAttachmentId: 'attachment-current',
      fileName: 'current.pdf',
      mediaType: 'application/pdf',
      size: 7,
    };
    const staleAttachment = {
      providerAttachmentId: 'attachment-stale',
      fileName: 'stale.pdf',
      mediaType: 'application/pdf',
      size: 9,
    };
    const first = await service.stageMessage(
      'vitasci-outlook',
      fixtureMessage({ attachments: [currentAttachment, staleAttachment] }),
      raw
    );
    await service.completeAttachment(
      first.id,
      currentAttachment.providerAttachmentId,
      Buffer.from('current'),
      currentAttachment.mediaType
    );
    database.markAttachmentFailure(
      first.id,
      staleAttachment.providerAttachmentId,
      'synthetic interrupted download'
    );

    const refreshed = await service.stageMessage(
      'vitasci-outlook',
      fixtureMessage({ attachments: [currentAttachment] }),
      raw
    );
    expect(refreshed.archive_state).toBe('archived_complete');
    expect(refreshed.attachments).toEqual([
      expect.objectContaining({
        provider_attachment_id: currentAttachment.providerAttachmentId,
        archive_state: 'complete',
      }),
    ]);
    const retired = database.db
      .prepare(
        `SELECT archive_state, blob_hash, current_eligible, retired_at,
                retirement_reason, retirement_evidence_digest
         FROM attachments
         WHERE message_id = ? AND provider_attachment_id = ?`
      )
      .get(first.id, staleAttachment.providerAttachmentId);
    expect(retired).toEqual(
      expect.objectContaining({
        archive_state: 'retryable_error',
        blob_hash: null,
        current_eligible: 0,
        retirement_reason: 'absent_from_authoritative_provider_manifest',
      })
    );
    expect(retired.retired_at).toBeTruthy();
    expect(retired.retirement_evidence_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(database.pendingAttachments('vitasci-outlook')).toHaveLength(0);
    expect(
      database.db
        .prepare(
          `SELECT COUNT(*) AS count FROM message_events
           WHERE message_id = ? AND event_type = 'attachment_manifest_reconciled'`
        )
        .get(first.id).count
    ).toBe(1);

    await service.stageMessage(
      'vitasci-outlook',
      fixtureMessage({ attachments: [currentAttachment] }),
      raw
    );
    expect(
      database.db
        .prepare(
          `SELECT COUNT(*) AS count FROM message_events
           WHERE message_id = ? AND event_type = 'attachment_manifest_reconciled'`
        )
        .get(first.id).count
    ).toBe(1);

    const reappeared = await service.stageMessage(
      'vitasci-outlook',
      fixtureMessage({ attachments: [currentAttachment, staleAttachment] }),
      raw
    );
    expect(reappeared.archive_state).toBe('archived_pending_attachments');
    expect(reappeared.attachments).toHaveLength(2);
    expect(
      database.db
        .prepare(
          `SELECT current_eligible, retired_at, retirement_reason,
                  retirement_evidence_digest
           FROM attachments
           WHERE message_id = ? AND provider_attachment_id = ?`
        )
        .get(first.id, staleAttachment.providerAttachmentId)
    ).toEqual({
      current_eligible: 1,
      retired_at: null,
      retirement_reason: null,
      retirement_evidence_digest: null,
    });
  });

  test('refuses to retire an incomplete attachment that references content', async () => {
    const attachment = fixtureMessage().attachments[0];
    const archived = await service.stageMessage(
      'vitasci-outlook',
      fixtureMessage(),
      Buffer.from('raw fixture')
    );
    const content = Buffer.from('preserved attachment content');
    const blobHash = sha256(content);
    database.registerBlob({
      hash: blobHash,
      kind: 'attachment',
      relativePath: `attachments/${blobHash}`,
      size: content.length,
      mediaType: 'application/pdf',
    });
    database.db
      .prepare(
        `UPDATE attachments SET blob_hash = ?
         WHERE message_id = ? AND provider_attachment_id = ?`
      )
      .run(blobHash, archived.id, attachment.providerAttachmentId);

    expect(() =>
      database.stageMessage(
        'vitasci-outlook',
        fixtureMessage({ attachments: [], hasAttachments: false }),
        null
      )
    ).toThrow('ATTACHMENT_RETIREMENT_CONTENT_PRESENT');
    expect(
      database.db
        .prepare(
          `SELECT current_eligible, blob_hash FROM attachments
           WHERE message_id = ? AND provider_attachment_id = ?`
        )
        .get(archived.id, attachment.providerAttachmentId)
    ).toEqual({ current_eligible: 1, blob_hash: blobHash });
  });

  test('deduplicates identical bytes across raw-message and attachment roles', async () => {
    const shared = Buffer.from('identical cross-role bytes');
    const archived = await service.stageMessage(
      'vitasci-outlook',
      fixtureMessage(),
      shared
    );
    await service.completeAttachment(
      archived.id,
      'attachment-1',
      shared,
      'application/octet-stream'
    );
    expect(
      database.db.prepare('SELECT COUNT(*) AS count FROM blobs').get().count
    ).toBe(1);
    await expect(
      contentStore.verify(
        database.db
          .prepare(
            'SELECT hash, relative_path AS relativePath, size FROM blobs'
          )
          .get()
      )
    ).resolves.toBe(true);
  });

  test('retains content and records a tombstone for remote deletion', async () => {
    const archived = await service.stageMessage(
      'vitasci-outlook',
      fixtureMessage({ attachments: [], hasAttachments: false }),
      Buffer.from('raw fixture')
    );
    expect(archived.archive_state).toBe('archived_complete');

    expect(
      database.recordTombstone('vitasci-outlook', 'provider-message-1', {
        reason: 'deleted',
      })
    ).toBe(true);

    const retained = database.getMessage(
      'vitasci-outlook',
      'provider-message-1'
    );
    expect(retained.current_eligible).toBe(0);
    expect(retained.deleted_remote).toBe(1);
    expect(retained.raw_blob_hash).toBeTruthy();
  });

  test('keeps searches account-scoped when requested', async () => {
    await service.stageMessage(
      'vitasci-outlook',
      fixtureMessage({ attachments: [], hasAttachments: false }),
      Buffer.from('outlook raw')
    );
    await service.stageMessage(
      'gmail-personal',
      fixtureMessage({
        providerMessageId: 'gmail-message-1',
        attachments: [],
        hasAttachments: false,
      }),
      Buffer.from('gmail raw')
    );

    expect(database.search('renewal')).toHaveLength(2);
    expect(database.search('renewal', { accountId: 'gmail-personal' })).toEqual(
      [expect.objectContaining({ account_id: 'gmail-personal' })]
    );
    expect(database.search('supplier')).toHaveLength(2);
    expect(
      database.search('', {
        accountId: 'gmail-personal',
        after: '2026-07-17T00:00:00Z',
        before: '2026-07-19T00:00:00Z',
      })
    ).toEqual([expect.objectContaining({ account_id: 'gmail-personal' })]);
    expect(
      database.search('renewal', { after: '2026-07-19T00:00:00Z' })
    ).toEqual([]);
    expect(() => database.search('renewal', { after: 'not-a-date' })).toThrow(
      'Invalid after search date'
    );
  });

  test('rejects traversal-like blob identities and verifies stored bytes', async () => {
    await expect(
      contentStore.verify({
        hash: 'a'.repeat(64),
        relativePath: '../outside',
        size: 1,
      })
    ).resolves.toBe(false);
    expect(() => contentStore.blobPath('attachment', '../../escape')).toThrow(
      'lowercase SHA-256'
    );
  });

  test('verifies every recorded blob through the operator command path', async () => {
    await service.stageMessage(
      'vitasci-outlook',
      fixtureMessage({ attachments: [], hasAttachments: false }),
      Buffer.from('verified raw fixture')
    );
    await expect(verifyArchive({ database, contentStore })).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        blobCount: 1,
        verifiedBlobCount: 1,
        failedHashes: [],
      })
    );
  });

  test('upgrades a version-one database and repairs state without data loss', () => {
    const legacyPath = path.join(tempRoot, 'legacy.sqlite3');
    const legacy = new ArchiveDatabase(legacyPath);
    legacy.upsertAccount({
      id: 'vitasci-outlook',
      provider: 'outlook',
      displayName: 'VitaSci Outlook',
    });
    const staged = legacy.stageMessage(
      'vitasci-outlook',
      fixtureMessage(),
      null
    );
    legacy.db
      .prepare(
        "UPDATE attachments SET archive_state = 'complete' WHERE message_id = ?"
      )
      .run(staged.id);
    legacy.recordIngestionError({
      accountId: 'vitasci-outlook',
      providerMessageId: 'provider-message-1',
      stage: 'message_fetch',
      message: 'historical fixture failure',
    });
    legacy.db.prepare('DELETE FROM schema_migrations WHERE version = 2').run();
    legacy.close();

    const upgraded = new ArchiveDatabase(legacyPath);
    expect(
      upgraded.getMessage('vitasci-outlook', 'provider-message-1').archive_state
    ).toBe('archived_complete');
    expect(upgraded.unresolvedErrors()).toEqual([]);
    expect(
      upgraded.db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all()
        .map((row) => row.version)
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    upgraded.close();
  });

  test('clears only the requested resumable checkpoint without deleting mail', async () => {
    await service.stageMessage(
      'vitasci-outlook',
      fixtureMessage({ attachments: [], hasAttachments: false }),
      Buffer.from('checkpoint fixture')
    );
    database.setCursor('vitasci-outlook', 'backfill', 'opaque-page-token');
    database.setCursor('vitasci-outlook', 'incremental', 'safe-delta-token');

    expect(database.clearCursor('vitasci-outlook', 'backfill')).toBe(1);
    expect(database.getCursor('vitasci-outlook', 'backfill')).toBeNull();
    expect(database.getCursor('vitasci-outlook', 'incremental').cursor).toBe(
      'safe-delta-token'
    );
    expect(
      database.getMessage('vitasci-outlook', 'provider-message-1')
    ).toBeTruthy();
  });

  test('marks abandoned ingestion runs interrupted when an exclusive worker recovers', () => {
    const abandoned = database.beginRun('vitasci-outlook', 'scheduled_cycle');
    const completed = database.beginRun('gmail-personal', 'scheduled_cycle');
    database.finishRun(completed, 'completed');

    expect(database.interruptRunningRuns()).toBe(1);
    expect(database.interruptRunningRuns()).toBe(0);
    expect(
      database.db
        .prepare(
          'SELECT status, finished_at, details_json FROM ingestion_runs WHERE id = ?'
        )
        .get(abandoned)
    ).toEqual(
      expect.objectContaining({
        status: 'interrupted',
        finished_at: expect.any(String),
        details_json: JSON.stringify({
          reason: 'worker_recovered_after_interruption',
        }),
      })
    );
    expect(
      database.recentRuns().find((run) => run.id === completed).status
    ).toBe('completed');
  });

  test('recovers running rows only for identity-proved account scopes', () => {
    const proved = database.beginRun('vitasci-outlook', 'scheduled_cycle');
    const unproved = database.beginRun('gmail-personal', 'scheduled_cycle');

    expect(
      database.interruptRunningRuns('identity_scoped_recovery', {
        accountIds: ['vitasci-outlook'],
      })
    ).toBe(1);
    expect(
      database.db
        .prepare('SELECT status FROM ingestion_runs WHERE id = ?')
        .get(proved).status
    ).toBe('interrupted');
    expect(
      database.db
        .prepare('SELECT status FROM ingestion_runs WHERE id = ?')
        .get(unproved).status
    ).toBe('running');
    expect(
      database.interruptRunningRuns('empty_identity_scope', {
        accountIds: [],
      })
    ).toBe(0);
    expect(
      database.db
        .prepare('SELECT status FROM ingestion_runs WHERE id = ?')
        .get(unproved).status
    ).toBe('running');
  });
});
