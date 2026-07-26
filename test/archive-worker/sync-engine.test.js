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
