const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { ArchiveService } = require('../../archive-worker/archive-service');
const { ArchiveDatabase } = require('../../archive-worker/database');
const { ContentStore } = require('../../archive-worker/storage');
const { ArchiveSyncEngine } = require('../../archive-worker/sync-engine');
const {
  ProviderHttpError,
} = require('../../archive-worker/providers/http-client');

function message(id, subject = id, attachments = []) {
  return {
    providerMessageId: id,
    subject,
    receivedAt: '2026-07-18T00:00:00.000Z',
    bodyText: `Body for ${subject}`,
    direction: 'inbound',
    recipients: [
      { type: 'from', address: 'sender@example.test', displayName: 'Sender' },
    ],
    locations: [
      { providerLocationId: 'inbox', displayName: 'Inbox', kind: 'inbox' },
    ],
    attachments,
    hasAttachments: attachments.length > 0,
    source: { fixture: true },
  };
}

function providerFixture(events, overrides = {}) {
  return {
    assertArchiveIdentity: jest.fn(async () => ({
      logicalAccountId: 'gmail-personal',
      credentialSlot: 'ablative',
      expectedIdentityConfigured: true,
      identityMatch: true,
      verifiedAt: '2026-08-02T11:00:00.000Z',
      errorCode: null,
    })),
    refreshLocations: jest.fn(async () => {
      events.push('locations');
      return [
        {
          providerFolderId: 'inbox',
          displayName: 'Inbox',
          kind: 'inbox',
          excluded: false,
        },
      ];
    }),
    listRecent: jest.fn(async () => {
      events.push('recent-list');
      return [{ id: 'new-message' }];
    }),
    listIncrementalPage: jest.fn(async () => {
      events.push('incremental-list');
      return {
        refs: [{ id: 'changed-message' }],
        tombstones: [],
        nextCursor: 'safe-checkpoint',
        complete: true,
        reset: false,
      };
    }),
    listBackfillPage: jest.fn(async () => {
      events.push('backfill-list');
      return {
        refs: [{ id: 'old-message' }],
        nextCursor: null,
        complete: true,
        estimate: 3,
      };
    }),
    fetchBundle: jest.fn(async (ref) => {
      events.push(`fetch:${ref.id}`);
      return {
        message: message(ref.id),
        rawContent: Buffer.from(`Raw ${ref.id}`),
      };
    }),
    fetchAttachment: jest.fn(),
    ...overrides,
  };
}

function totalChanges(database) {
  return database.db.prepare('SELECT total_changes() AS count').get().count;
}

function accountArchiveRowCounts(database, accountId) {
  const counts = {
    accounts: database.db
      .prepare('SELECT COUNT(*) AS count FROM accounts WHERE id = ?')
      .get(accountId).count,
  };
  const tables = database.db
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all()
    .map((row) => row.name)
    .filter((table) => /^[a-z0-9_]+$/i.test(table));
  for (const table of tables) {
    const hasAccountId = database.db
      .pragma(`table_info("${table}")`)
      .some((column) => column.name === 'account_id');
    if (!hasAccountId) continue;
    counts[table] = database.db
      .prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE account_id = ?`)
      .get(accountId).count;
  }
  return counts;
}

describe('archive sync engine', () => {
  let root;
  let database;
  let service;
  let account;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'email-sync-test-'));
    database = new ArchiveDatabase(path.join(root, 'archive.sqlite3'));
    service = new ArchiveService({
      database,
      contentStore: new ContentStore(root),
    });
    account = {
      id: 'gmail-personal',
      provider: 'gmail',
      displayName: 'Personal Gmail',
    };
    await service.initialise([account]);
  });

  afterEach(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  function engineFor(provider) {
    return new ArchiveSyncEngine({
      database,
      service,
      config: {
        accounts: [account],
        incrementalBatchSize: 10,
        backfillBatchSize: 10,
        attachmentRetryBatchSize: 10,
      },
      providerFactory: () => provider,
    });
  }

  test('archives new mail before history and backfill, then advances checkpoints', async () => {
    const events = [];
    const provider = providerFixture(events);
    const [result] = await engineFor(provider).runAll();

    expect(result.status).toBe('completed');
    expect(events.indexOf('fetch:new-message')).toBeLessThan(
      events.indexOf('fetch:changed-message')
    );
    expect(events.indexOf('fetch:changed-message')).toBeLessThan(
      events.indexOf('fetch:old-message')
    );
    expect(database.getCursor(account.id, 'incremental').cursor).toBe(
      'safe-checkpoint'
    );
    expect(
      JSON.parse(database.getCursor(account.id, 'backfill').metadata_json)
    ).toEqual(expect.objectContaining({ complete: true }));
    expect(database.status().accounts[0].message_count).toBe(3);
  });

  test('does not advance an incremental checkpoint after a fetch failure', async () => {
    const events = [];
    const provider = providerFixture(events);
    provider.fetchBundle.mockImplementation(async (ref) => {
      if (ref.id === 'changed-message') {
        const error = new Error('temporary provider failure');
        error.code = 'TEMPORARY';
        throw error;
      }
      return {
        message: message(ref.id),
        rawContent: Buffer.from(`Raw ${ref.id}`),
      };
    });

    const [result] = await engineFor(provider).runAll();
    expect(result.status).toBe('failed');
    expect(database.getCursor(account.id, 'incremental')).toBeNull();
    expect(database.unresolvedErrors()).toEqual([
      expect.objectContaining({
        account_id: account.id,
        provider_message_id: 'changed-message',
        stage: 'message_fetch',
      }),
    ]);
  });

  test('identity mismatch writes no archive record and does not block a healthy account', async () => {
    const accounts = [
      {
        id: 'gmail-personal',
        logicalAccountId: 'gmail-personal',
        provider: 'gmail',
        displayName: 'Personal Gmail',
      },
      {
        id: 'vitasci-outlook',
        provider: 'outlook',
        displayName: 'VitaSci Outlook',
      },
    ];
    await service.initialise(accounts);
    const failing = providerFixture([]);
    const mismatch = new Error(
      'Gmail identity verification failed for gmail-personal'
    );
    mismatch.code = 'GMAIL_IDENTITY_MISMATCH';
    mismatch.retryable = false;
    failing.assertArchiveIdentity.mockRejectedValue(mismatch);
    const healthy = providerFixture([]);
    healthy.assertArchiveIdentity.mockResolvedValue({
      logicalAccountId: 'vitasci-outlook',
      credentialSlot: 'default-delegated',
      expectedIdentityConfigured: true,
      identityMatch: true,
      verifiedAt: '2026-08-02T11:00:00.000Z',
      errorCode: null,
    });
    const engine = new ArchiveSyncEngine({
      database,
      service,
      config: {
        accounts,
        incrementalBatchSize: 10,
        backfillBatchSize: 10,
        attachmentRetryBatchSize: 10,
      },
      providerFactory: (candidate) =>
        candidate.id === 'gmail-personal' ? failing : healthy,
    });

    await expect(engine.runAll()).resolves.toEqual([
      expect.objectContaining({
        accountId: 'gmail-personal',
        status: 'failed',
        error: expect.objectContaining({
          code: 'GMAIL_IDENTITY_MISMATCH',
          retryable: false,
        }),
      }),
      expect.objectContaining({
        accountId: 'vitasci-outlook',
        status: 'completed',
      }),
    ]);
    expect(failing.refreshLocations).not.toHaveBeenCalled();
    expect(failing.listRecent).not.toHaveBeenCalled();
    expect(database.getCursor('gmail-personal', 'incremental')).toBeNull();
    expect(database.listProviderMessageIds('gmail-personal')).toEqual([]);
    expect(database.listProviderMessageIds('vitasci-outlook').length).toBe(3);
    expect(database.unresolvedErrors()).toEqual([]);
  });

  test('scheduled identity mismatch performs exactly zero database writes', async () => {
    const provider = providerFixture([], {
      listInventoryPage: jest.fn(),
    });
    const mismatch = new Error('private identity text must not escape');
    mismatch.code = 'GMAIL_IDENTITY_MISMATCH';
    mismatch.retryable = false;
    provider.assertArchiveIdentity.mockRejectedValue(mismatch);
    const engine = engineFor(provider);
    const changesBefore = totalChanges(database);
    const rowsBefore = accountArchiveRowCounts(database, account.id);
    const cursorsBefore = database.db
      .prepare(
        'SELECT scope, cursor, metadata_json FROM sync_cursors WHERE account_id = ? ORDER BY scope'
      )
      .all(account.id);
    const messagesBefore = database.listProviderMessageIds(account.id);

    await expect(engine.runAccountCycle(account)).resolves.toEqual({
      accountId: account.id,
      status: 'failed',
      discovered: 0,
      archived: 0,
      errors: 1,
      error: {
        code: 'GMAIL_IDENTITY_MISMATCH',
        message: 'gmail identity verification failed for gmail-personal',
        retryable: false,
      },
    });

    expect(totalChanges(database)).toBe(changesBefore);
    expect(accountArchiveRowCounts(database, account.id)).toEqual(rowsBefore);
    expect(
      database.db
        .prepare(
          'SELECT scope, cursor, metadata_json FROM sync_cursors WHERE account_id = ? ORDER BY scope'
        )
        .all(account.id)
    ).toEqual(cursorsBefore);
    expect(database.listProviderMessageIds(account.id)).toEqual(messagesBefore);
    expect(provider.refreshLocations).not.toHaveBeenCalled();
    expect(provider.listRecent).not.toHaveBeenCalled();
  });

  test('Outlook identity mismatch writes no mail, folder, or cursor state', async () => {
    const outlookAccount = {
      id: 'vitasci-outlook',
      logicalAccountId: 'vitasci-outlook',
      provider: 'outlook',
      displayName: 'VitaSci Outlook',
    };
    await service.initialise([outlookAccount]);
    const provider = providerFixture([]);
    const mismatch = new Error(
      'Outlook identity verification failed for vitasci-outlook'
    );
    mismatch.code = 'OUTLOOK_IDENTITY_MISMATCH';
    mismatch.retryable = false;
    provider.assertArchiveIdentity.mockRejectedValue(mismatch);
    const engine = new ArchiveSyncEngine({
      database,
      service,
      config: {
        accounts: [outlookAccount],
        incrementalBatchSize: 10,
        backfillBatchSize: 10,
        attachmentRetryBatchSize: 10,
      },
      providerFactory: () => provider,
    });

    await expect(engine.runAll()).resolves.toEqual([
      expect.objectContaining({
        accountId: 'vitasci-outlook',
        status: 'failed',
        error: expect.objectContaining({
          code: 'OUTLOOK_IDENTITY_MISMATCH',
          retryable: false,
        }),
      }),
    ]);
    expect(provider.refreshLocations).not.toHaveBeenCalled();
    expect(provider.listRecent).not.toHaveBeenCalled();
    expect(database.getCursor('vitasci-outlook', 'incremental')).toBeNull();
    expect(database.listProviderMessageIds('vitasci-outlook')).toEqual([]);
    expect(
      database.db
        .prepare(
          `SELECT COUNT(*) AS count FROM folders
           WHERE account_id = 'vitasci-outlook'`
        )
        .get().count
    ).toBe(0);
  });

  test('resolves account-cycle errors only through a same-account guarded healthy run', async () => {
    await service.initialise([
      {
        id: 'gmail-ablative',
        provider: 'gmail',
        displayName: 'Ablative Gmail',
      },
    ]);
    database.recordIngestionError({
      accountId: 'gmail-personal',
      stage: 'account_cycle',
      code: 'GMAIL_AUTH',
      message: 'historical safe fixture failure',
    });
    database.recordIngestionError({
      accountId: 'gmail-ablative',
      stage: 'account_cycle',
      code: 'GMAIL_AUTH',
      message: 'other account safe fixture failure',
    });
    database.recordIngestionError({
      accountId: 'gmail-personal',
      providerMessageId: 'unrelated-message',
      stage: 'message_fetch',
      code: 'TEMPORARY',
      message: 'message-scoped safe fixture failure',
    });

    const [result] = await engineFor(providerFixture([])).runAll();
    expect(result).toEqual(
      expect.objectContaining({
        status: 'completed',
        resolvedAccountCycleErrors: 1,
      })
    );
    const resolved = database.db
      .prepare(
        `SELECT resolved_at, resolution_run_id, resolution_code
         FROM ingestion_errors
         WHERE account_id = 'gmail-personal'
           AND stage = 'account_cycle'`
      )
      .get();
    expect(resolved).toEqual(
      expect.objectContaining({
        resolved_at: expect.any(String),
        resolution_run_id: expect.any(Number),
        resolution_code: 'GMAIL_IDENTITY_VERIFIED_HEALTHY_CYCLE',
      })
    );
    expect(database.unresolvedErrors()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_id: 'gmail-ablative',
          stage: 'account_cycle',
        }),
        expect.objectContaining({
          account_id: 'gmail-personal',
          stage: 'message_fetch',
        }),
      ])
    );
  });

  test('isolates an exhausted Gmail 429 while healthy accounts still complete', async () => {
    const accounts = [
      {
        id: 'vitasci-outlook',
        provider: 'outlook',
        displayName: 'VitaSci Outlook',
      },
      {
        id: 'gmail-ablative',
        provider: 'gmail',
        displayName: 'Ablative Gmail',
      },
      {
        id: 'gmail-personal',
        provider: 'gmail',
        displayName: 'Personal Gmail',
      },
    ];
    await service.initialise(accounts);
    const providers = new Map(
      accounts.map((candidate) => [candidate.id, providerFixture([])])
    );
    providers.get('vitasci-outlook').assertArchiveIdentity.mockResolvedValue({
      logicalAccountId: 'vitasci-outlook',
      credentialSlot: 'default-delegated',
      expectedIdentityConfigured: true,
      identityMatch: true,
      verifiedAt: '2026-08-02T11:00:00.000Z',
      errorCode: null,
    });
    providers.get('gmail-ablative').assertArchiveIdentity.mockResolvedValue({
      logicalAccountId: 'gmail-ablative',
      credentialSlot: 'personal',
      expectedIdentityConfigured: true,
      identityMatch: true,
      verifiedAt: '2026-08-02T11:00:00.000Z',
      errorCode: null,
    });
    providers.get('gmail-ablative').fetchBundle.mockRejectedValue(
      new ProviderHttpError('Gmail request exhausted its retry budget', {
        status: 429,
        code: 429,
        retryable: true,
      })
    );
    const engine = new ArchiveSyncEngine({
      database,
      service,
      config: {
        accounts,
        incrementalBatchSize: 10,
        backfillBatchSize: 10,
        attachmentRetryBatchSize: 10,
      },
      providerFactory: (candidate) => providers.get(candidate.id),
    });

    await expect(engine.runAll()).resolves.toEqual([
      expect.objectContaining({
        accountId: 'vitasci-outlook',
        status: 'completed',
      }),
      expect.objectContaining({
        accountId: 'gmail-ablative',
        status: 'rate_limited',
        errors: 1,
        error: expect.objectContaining({ code: 429, retryable: true }),
      }),
      expect.objectContaining({
        accountId: 'gmail-personal',
        status: 'completed',
      }),
    ]);
    expect(
      providers.get('gmail-ablative').listIncrementalPage
    ).not.toHaveBeenCalled();
    expect(
      providers.get('gmail-personal').listIncrementalPage
    ).toHaveBeenCalled();
    expect(database.unresolvedErrors()).toEqual([
      expect.objectContaining({
        account_id: 'gmail-ablative',
        provider_message_id: 'new-message',
        error_code: expect.stringMatching(/^429/),
      }),
    ]);
  });

  test('does not let a later Gmail 429 hide an earlier real account error', async () => {
    const provider = providerFixture([]);
    provider.listRecent.mockResolvedValue([
      { id: 'ordinary-failure' },
      { id: 'rate-limit' },
    ]);
    provider.fetchBundle.mockImplementation((ref) => {
      if (ref.id === 'ordinary-failure') {
        const error = new Error('fixture parse failed');
        error.code = 'INVALID_FIXTURE';
        error.retryable = false;
        throw error;
      }
      throw new ProviderHttpError('Gmail request exhausted its retry budget', {
        status: 429,
        code: 429,
        retryable: true,
      });
    });

    const [result] = await engineFor(provider).runAll();
    expect(result).toEqual(
      expect.objectContaining({
        accountId: 'gmail-personal',
        status: 'failed',
        errors: 2,
      })
    );
    expect(provider.listIncrementalPage).not.toHaveBeenCalled();
  });

  test('stages every message before fetching a large attachment', async () => {
    const attachment = {
      providerAttachmentId: 'large-attachment',
      fileName: 'large.bin',
      mediaType: 'application/octet-stream',
    };
    const bundles = [
      {
        message: message('large-message', 'Large', [attachment]),
        rawContent: Buffer.from('large raw'),
      },
      {
        message: message('ordinary-message', 'Ordinary'),
        rawContent: Buffer.from('ordinary raw'),
      },
    ];

    const [completed] = await service.archiveBatch(
      account.id,
      bundles,
      async () => {
        expect(
          database.getMessage(account.id, 'ordinary-message')
        ).toBeTruthy();
        return Buffer.from('attachment bytes');
      }
    );
    expect(completed.archive_state).toBe('archived_complete');
    expect(database.getMessage(account.id, 'large-message').archive_state).toBe(
      'archived_complete'
    );
  });

  test('persists each provider message before fetching the next one', async () => {
    const provider = providerFixture([]);
    provider.fetchBundle.mockImplementation(async (ref) => {
      if (ref.id === 'second-message') {
        expect(database.getMessage(account.id, 'first-message')).toBeTruthy();
      }
      return {
        message: message(ref.id),
        rawContent: Buffer.from(`Raw ${ref.id}`),
      };
    });

    const result = await engineFor(provider).archiveRefs(
      account,
      provider,
      [{ id: 'first-message' }, { id: 'second-message' }],
      database.beginRun(account.id, 'test')
    );

    expect(result).toEqual({ discovered: 2, archived: 2, errors: 0 });
    expect(database.getMessage(account.id, 'second-message')).toBeTruthy();
  });

  test('stages unrelated provider messages before downloading attachments', async () => {
    const attachment = {
      providerAttachmentId: 'large-attachment',
      fileName: 'large.bin',
      mediaType: 'application/octet-stream',
    };
    const provider = providerFixture([]);
    provider.fetchBundle.mockImplementation(async (ref) => ({
      message: message(
        ref.id,
        ref.id,
        ref.id === 'first-message' ? [attachment] : []
      ),
      rawContent: Buffer.from(`Raw ${ref.id}`),
    }));
    provider.fetchAttachment.mockImplementation(async () => {
      expect(database.getMessage(account.id, 'second-message')).toBeTruthy();
      return Buffer.from('attachment bytes');
    });

    await engineFor(provider).archiveRefs(
      account,
      provider,
      [{ id: 'first-message' }, { id: 'second-message' }],
      database.beginRun(account.id, 'test')
    );

    expect(database.getMessage(account.id, 'first-message').archive_state).toBe(
      'archived_complete'
    );
  });

  test('schedules reconciliation only after backfill and records a clean result', async () => {
    const events = [];
    const provider = providerFixture(events, {
      listInventoryPage: jest.fn(async () => ({
        refs: [{ id: 'inventory-message' }],
        nextCursor: null,
        complete: true,
      })),
    });
    const engine = engineFor(provider);
    expect(engine.reconciliationDue(account)).toBe(false);
    database.setCursor(account.id, 'backfill', null, { complete: true });
    expect(engine.reconciliationDue(account)).toBe(true);

    const result = await engine.reconcileAccount(account);
    expect(result).toEqual(
      expect.objectContaining({
        status: 'completed',
        providerEligible: 1,
        localEligible: 1,
        differences: 0,
      })
    );
    expect(engine.reconciliationDue(account)).toBe(false);
    expect(
      JSON.parse(database.getCursor(account.id, 'reconciliation').metadata_json)
    ).toEqual(expect.objectContaining({ complete: true, differences: 0 }));
    expect(
      JSON.parse(database.getCursor(account.id, 'backfill').metadata_json)
    ).toEqual(
      expect.objectContaining({
        complete: true,
        estimate: 1,
        completedBy: 'full_reconciliation',
      })
    );
  });

  test('reconciliation identity mismatch performs exactly zero database writes', async () => {
    database.setCursor(account.id, 'backfill', null, { complete: true });
    const provider = providerFixture([], {
      listInventoryPage: jest.fn(),
    });
    const mismatch = new Error('private identity text must not escape');
    mismatch.code = 'GMAIL_IDENTITY_MISMATCH';
    mismatch.retryable = false;
    provider.assertArchiveIdentity.mockRejectedValue(mismatch);
    const engine = engineFor(provider);
    const changesBefore = totalChanges(database);
    const rowsBefore = accountArchiveRowCounts(database, account.id);
    const cursorsBefore = database.db
      .prepare(
        'SELECT scope, cursor, metadata_json FROM sync_cursors WHERE account_id = ? ORDER BY scope'
      )
      .all(account.id);
    const messagesBefore = database.listProviderMessageIds(account.id);

    await expect(engine.reconcileAccount(account)).resolves.toEqual({
      accountId: account.id,
      status: 'failed',
      discovered: 0,
      archived: 0,
      errors: 1,
      error: {
        code: 'GMAIL_IDENTITY_MISMATCH',
        message: 'gmail identity verification failed for gmail-personal',
        retryable: false,
      },
    });

    expect(totalChanges(database)).toBe(changesBefore);
    expect(accountArchiveRowCounts(database, account.id)).toEqual(rowsBefore);
    expect(
      database.db
        .prepare(
          'SELECT scope, cursor, metadata_json FROM sync_cursors WHERE account_id = ? ORDER BY scope'
        )
        .all(account.id)
    ).toEqual(cursorsBefore);
    expect(database.listProviderMessageIds(account.id)).toEqual(messagesBefore);
    expect(provider.refreshLocations).not.toHaveBeenCalled();
    expect(provider.listInventoryPage).not.toHaveBeenCalled();
  });

  test('full guarded reconciliation resolves only causally proved retrieval errors', async () => {
    database.recordIngestionError({
      accountId: account.id,
      stage: 'reconciliation',
      code: 'TEMPORARY',
      message: 'historical reconciliation fixture',
    });
    database.recordIngestionError({
      accountId: account.id,
      providerMessageId: 'inventory-message',
      stage: 'message_fetch',
      code: 'TEMPORARY',
      message: 'historical message fixture',
    });
    database.recordIngestionError({
      accountId: account.id,
      providerMessageId: 'inventory-message',
      stage: 'routing',
      code: 'ROUTE_FAILED',
      message: 'deferred routing fixture',
    });
    database.stageMessage(account.id, message('remote-tombstone'), null);
    database.recordTombstone(account.id, 'remote-tombstone', {
      reason: 'synthetic fixture',
    });
    database.recordIngestionError({
      accountId: account.id,
      providerMessageId: 'remote-tombstone',
      stage: 'tombstone',
      code: 'TEMPORARY',
      message: 'historical tombstone fixture',
    });
    const provider = providerFixture([], {
      listInventoryPage: jest.fn(async () => ({
        refs: [{ id: 'inventory-message' }],
        nextCursor: null,
        complete: true,
      })),
    });

    const result = await engineFor(provider).reconcileAccount(account);
    expect(result).toEqual(
      expect.objectContaining({
        status: 'completed',
        differences: 0,
        resolvedReconciliationErrors: {
          reconciliations: 1,
          // The newly archived inventory message is resolved immediately by
          // archiveRefs. The reconciliation end-phase resolves the remaining
          // proved tombstone, so this is deliberately an end-phase count.
          messageScoped: 1,
        },
      })
    );
    expect(database.unresolvedErrors()).toEqual([
      expect.objectContaining({
        account_id: account.id,
        provider_message_id: 'inventory-message',
        stage: 'routing',
      }),
    ]);
    expect(
      database.db
        .prepare(
          `SELECT stage, resolution_code
           FROM ingestion_errors
           WHERE resolved_at IS NOT NULL
             AND resolution_run_id IS NOT NULL
           ORDER BY stage`
        )
        .all()
    ).toEqual([
      {
        stage: 'message_fetch',
        resolution_code: 'MESSAGE_ARCHIVED_COMPLETE',
      },
      {
        stage: 'reconciliation',
        resolution_code: 'GMAIL_IDENTITY_VERIFIED_FULL_RECONCILIATION',
      },
      {
        stage: 'tombstone',
        resolution_code: 'GMAIL_IDENTITY_VERIFIED_FULL_RECONCILIATION',
      },
    ]);
  });

  test('reports a reconciliation 429 as rate-limited rather than failed', async () => {
    const provider = providerFixture([]);
    provider.refreshLocations.mockRejectedValue(
      new ProviderHttpError('Gmail request exhausted its retry budget', {
        status: 429,
        code: 429,
        retryable: true,
      })
    );

    await expect(
      engineFor(provider).reconcileAccount(account)
    ).resolves.toEqual(
      expect.objectContaining({
        accountId: 'gmail-personal',
        status: 'rate_limited',
        errors: 1,
        error: expect.objectContaining({ code: 429, retryable: true }),
      })
    );
    expect(database.unresolvedErrors()).toEqual([]);
  });

  test('time-boxes reconciliation between missing messages without losing progress', async () => {
    const provider = providerFixture([], {
      listInventoryPage: jest.fn(async () => ({
        refs: [{ id: 'first-missing' }, { id: 'second-missing' }],
        nextCursor: null,
        complete: true,
      })),
    });
    let clock = 0;
    provider.fetchBundle.mockImplementation(async (ref) => {
      clock += 60;
      return {
        message: message(ref.id),
        rawContent: Buffer.from(`Raw ${ref.id}`),
      };
    });

    const result = await engineFor(provider).reconcileAccount(account, {
      deadlineMs: 50,
      batchSize: 1,
      now: () => clock,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: 'deferred',
        archived: 1,
        deferredAt: 'after_missing_batch',
        differences: null,
      })
    );
    expect(database.getMessage(account.id, 'first-missing')).toBeTruthy();
    expect(database.getMessage(account.id, 'second-missing')).toBeNull();
    expect(database.getCursor(account.id, 'reconciliation')).toBeNull();
    expect(
      database.db
        .prepare(
          "SELECT status, details_json FROM ingestion_runs WHERE run_type = 'reconciliation' ORDER BY id DESC LIMIT 1"
        )
        .get()
    ).toEqual(
      expect.objectContaining({
        status: 'interrupted',
        details_json: expect.stringContaining('"outcome":"deferred"'),
      })
    );
  });

  test('time-boxed reconciliation also yields between attachments', async () => {
    const attachments = [
      {
        providerAttachmentId: 'first-attachment',
        fileName: 'first.txt',
        mediaType: 'text/plain',
      },
      {
        providerAttachmentId: 'second-attachment',
        fileName: 'second.txt',
        mediaType: 'text/plain',
      },
    ];
    let clock = 0;
    const provider = providerFixture([], {
      listInventoryPage: jest.fn(async () => ({
        refs: [{ id: 'attachment-message' }],
        nextCursor: null,
        complete: true,
      })),
      fetchBundle: jest.fn(async () => ({
        message: message(
          'attachment-message',
          'attachment-message',
          attachments
        ),
        rawContent: Buffer.from('Raw attachment-message'),
      })),
      fetchAttachment: jest.fn(async () => {
        clock += 60;
        return Buffer.from('attachment bytes');
      }),
    });

    const result = await engineFor(provider).reconcileAccount(account, {
      deadlineMs: 50,
      batchSize: 1,
      now: () => clock,
    });

    expect(result.status).toBe('deferred');
    expect(provider.fetchAttachment).toHaveBeenCalledTimes(1);
    expect(
      database.getMessage(account.id, 'attachment-message').archive_state
    ).toBe('archived_pending_attachments');
  });

  test('a clean full reconciliation safely completes a partial backfill', async () => {
    const provider = providerFixture([], {
      listInventoryPage: jest.fn(async () => ({
        refs: [{ id: 'inventory-message' }],
        nextCursor: null,
        complete: true,
      })),
    });
    const engine = engineFor(provider);
    expect(database.getCursor(account.id, 'backfill')).toBeNull();

    await expect(engine.reconcileAccount(account)).resolves.toEqual(
      expect.objectContaining({ status: 'completed', differences: 0 })
    );
    expect(
      JSON.parse(database.getCursor(account.id, 'backfill').metadata_json)
    ).toEqual(
      expect.objectContaining({
        complete: true,
        completedBy: 'full_reconciliation',
      })
    );
  });
});
