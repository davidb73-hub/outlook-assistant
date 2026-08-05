const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  buildAcceptanceStatus,
  percentile,
  REQUIRED_72_HOUR_CYCLES,
} = require('../../archive-worker/acceptance-status');
const { ArchiveDatabase } = require('../../archive-worker/database');

describe('privacy-safe acceptance status', () => {
  let root;
  let database;
  const account = {
    id: 'gmail-personal',
    provider: 'gmail',
    displayName: 'Personal Gmail',
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-status-test-'));
    database = new ArchiveDatabase(path.join(root, 'archive.sqlite3'));
    database.upsertAccount(account);
    database.upsertFolder(account.id, {
      providerFolderId: 'custom',
      displayName: 'Clients',
      kind: 'custom',
      excluded: false,
    });
    database.upsertFolder(account.id, {
      providerFolderId: 'trash',
      displayName: 'Trash',
      kind: 'trash',
      excluded: true,
    });
    const archived = database.stageMessage(
      account.id,
      {
        providerMessageId: 'message-1',
        subject: 'Private fixture',
        receivedAt: '2026-07-18T00:00:00.000Z',
        direction: 'inbound',
        locations: [
          {
            providerLocationId: 'custom',
            displayName: 'Clients',
            kind: 'custom',
          },
        ],
      },
      null
    );
    database.db
      .prepare(
        `UPDATE messages
         SET first_archived_at = '2026-07-18T00:01:00.000Z'
         WHERE id = ?`
      )
      .run(archived.id);
    database.setCursor(account.id, 'backfill', null, { complete: true });
    database.setCursor(account.id, 'reconciliation', null, {
      complete: true,
      differences: 0,
    });
    await fs.mkdir(path.join(root, 'logs'));
    await fs.writeFile(
      path.join(root, 'logs', 'scheduled.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-07-18T00:00:00.000Z',
        status: 'completed',
        downstream: { enabled: false, status: 'gated' },
        accounts: [
          {
            accountId: account.id,
            status: 'completed',
            identityVerified: true,
            identityVerifiedAt: '2026-07-18T00:00:00.000Z',
          },
        ],
      })}\n`
    );
  });

  afterEach(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  test('reports automated evidence without message content', async () => {
    const report = await buildAcceptanceStatus({
      config: { accounts: [account], logsDir: path.join(root, 'logs') },
      database,
      now: Date.parse('2026-07-18T01:00:00.000Z'),
    });

    expect(report.integrity).toBe('ok');
    expect(report.activeCrossAccountProviderIdOverlap).toBe(0);
    expect(report.accounts[0]).toEqual(
      expect.objectContaining({
        messages: 1,
        backfillComplete: true,
        reconciliationComplete: true,
        reconciliationDifferences: 0,
        locations: expect.objectContaining({
          customMessages: 1,
          excludedFoldersDiscovered: 1,
          messagesInExcludedFolders: 0,
        }),
        passiveLatency: expect.objectContaining({
          sampleCount: 1,
          medianSeconds: 60,
          satisfiesControlledSample: false,
        }),
      })
    );
    expect(report.automatedArchiveGate.passed).toBe(true);
    expect(report.unattended.completedCycles).toBe(1);
    expect(report.unattended.currentCleanWindow).toEqual(
      expect.objectContaining({
        startedAt: '2026-07-18T00:00:00.000Z',
        completedCycles: 1,
        requiredCompletedCycles: 288,
        logBytesWithinBound: true,
        satisfies72HourUnattended: false,
      })
    );
    expect(JSON.stringify(report)).not.toContain('Private fixture');
  });

  test('measures a clean unattended window after the most recent failure', async () => {
    const firstAt = Date.parse('2026-07-18T00:00:00.000Z');
    const events = [];
    for (let index = 0; index < REQUIRED_72_HOUR_CYCLES; index += 1) {
      events.push({
        timestamp: new Date(firstAt + index * 15 * 60 * 1000).toISOString(),
        status: 'completed',
        downstream: { enabled: false, status: 'gated' },
        accounts: [
          {
            accountId: account.id,
            status: 'completed',
            identityVerified: true,
            identityVerifiedAt: new Date(
              firstAt + index * 15 * 60 * 1000
            ).toISOString(),
          },
        ],
      });
    }
    await fs.writeFile(
      path.join(root, 'logs', 'scheduled.jsonl'),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
    );

    const cleanReport = await buildAcceptanceStatus({
      config: { accounts: [account], logsDir: path.join(root, 'logs') },
      database,
      now: firstAt + 72 * 60 * 60 * 1000,
    });
    expect(
      cleanReport.unattended.currentCleanWindow.satisfies72HourUnattended
    ).toBe(true);

    events.splice(200, 0, {
      timestamp: new Date(firstAt + 200 * 15 * 60 * 1000 - 1).toISOString(),
      status: 'failed',
      errorCode: 'SCHEDULED_RUN_FAILED',
    });
    await fs.writeFile(
      path.join(root, 'logs', 'scheduled.jsonl'),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
    );

    const resetReport = await buildAcceptanceStatus({
      config: { accounts: [account], logsDir: path.join(root, 'logs') },
      database,
      now: firstAt + 72 * 60 * 60 * 1000,
    });
    expect(resetReport.unattended.currentCleanWindow).toEqual(
      expect.objectContaining({
        resetByFailureAt: new Date(
          firstAt + 200 * 15 * 60 * 1000 - 1
        ).toISOString(),
        resetReason: 'SCHEDULED_RUN_FAILED',
        completedCycles: REQUIRED_72_HOUR_CYCLES - 200,
        satisfies72HourUnattended: false,
      })
    );
  });

  test('a completed event without identity proof cannot start the clean window', async () => {
    await fs.writeFile(
      path.join(root, 'logs', 'scheduled.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-07-18T00:00:00.000Z',
        status: 'completed',
        downstream: { enabled: false, status: 'gated' },
        accounts: [{ accountId: account.id, status: 'completed' }],
      })}\n`
    );

    const report = await buildAcceptanceStatus({
      config: { accounts: [account], logsDir: path.join(root, 'logs') },
      database,
      now: Date.parse('2026-07-18T01:00:00.000Z'),
    });

    expect(report.unattended.currentCleanWindow).toEqual(
      expect.objectContaining({
        resetByFailureAt: '2026-07-18T00:00:00.000Z',
        resetReason: 'IDENTITY_OR_ACCOUNT_CYCLE_UNVERIFIED',
        startedAt: null,
        completedCycles: 0,
        satisfies72HourUnattended: false,
      })
    );
  });

  test('an empty operational log never manufactures 72 elapsed hours', async () => {
    await fs.writeFile(path.join(root, 'logs', 'scheduled.jsonl'), '');

    const report = await buildAcceptanceStatus({
      config: { accounts: [account], logsDir: path.join(root, 'logs') },
      database,
      now: Date.parse('2026-07-21T00:00:00.000Z'),
    });

    expect(report.unattended.firstEventAt).toBeNull();
    expect(report.unattended.elapsedHoursSinceFirstEvent).toBe(0);
    expect(report.unattended.satisfies72HourElapsed).toBe(false);
    expect(report.unattended.currentCleanWindow).toEqual(
      expect.objectContaining({
        startedAt: null,
        completedCycles: 0,
        satisfies72HourUnattended: false,
      })
    );
  });

  test('non-cycle events cannot extend a verified clean window', async () => {
    const events = [
      {
        timestamp: '2026-07-18T00:00:00.000Z',
        status: 'completed',
      },
      {
        timestamp: '2026-07-18T00:15:00.000Z',
        status: 'completed',
        downstream: { enabled: false, status: 'gated' },
        accounts: [
          {
            accountId: account.id,
            status: 'completed',
            identityVerified: true,
            identityVerifiedAt: '2026-07-18T00:15:00.000Z',
          },
        ],
      },
      {
        timestamp: '2026-07-18T00:30:00.000Z',
        status: 'completed',
      },
    ];
    await fs.writeFile(
      path.join(root, 'logs', 'scheduled.jsonl'),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
    );

    const report = await buildAcceptanceStatus({
      config: { accounts: [account], logsDir: path.join(root, 'logs') },
      database,
      now: Date.parse('2026-07-18T01:00:00.000Z'),
    });

    expect(report.unattended.currentCleanWindow).toEqual(
      expect.objectContaining({
        startedAt: '2026-07-18T00:15:00.000Z',
        lastEventAt: '2026-07-18T00:15:00.000Z',
        completedCycles: 1,
      })
    );
  });

  test.each([
    {
      label: 'degraded provider cycle',
      event: {
        timestamp: '2026-07-18T00:15:00.000Z',
        status: 'degraded',
        errorCode: 'PROVIDER_RATE_LIMITED',
      },
      reason: 'PROVIDER_RATE_LIMITED',
    },
    {
      label: 'downstream-enabled cycle',
      event: {
        timestamp: '2026-07-18T00:15:00.000Z',
        status: 'completed',
        downstream: { enabled: true, status: 'enabled' },
        accounts: [
          {
            accountId: account.id,
            status: 'completed',
            identityVerified: true,
            identityVerifiedAt: '2026-07-18T00:15:00.000Z',
          },
        ],
      },
      reason: 'DOWNSTREAM_NOT_GATED',
    },
  ])('$label resets the clean window', async ({ event, reason }) => {
    await fs.appendFile(
      path.join(root, 'logs', 'scheduled.jsonl'),
      `${JSON.stringify(event)}\n`
    );

    const report = await buildAcceptanceStatus({
      config: { accounts: [account], logsDir: path.join(root, 'logs') },
      database,
      now: Date.parse('2026-07-18T01:00:00.000Z'),
    });

    expect(report.unattended.currentCleanWindow).toEqual(
      expect.objectContaining({
        resetByFailureAt: event.timestamp,
        resetReason: reason,
        startedAt: null,
        completedCycles: 0,
        satisfies72HourUnattended: false,
      })
    );
  });

  test('active Gmail provider-ID overlap blocks automated acceptance', async () => {
    const otherAccount = {
      id: 'gmail-ablative',
      provider: 'gmail',
      displayName: 'Ablative Gmail',
    };
    database.upsertAccount(otherAccount);
    database.stageMessage(
      otherAccount.id,
      {
        providerMessageId: 'message-1',
        subject: 'Synthetic duplicate fixture',
        direction: 'inbound',
        locations: [],
        attachments: [],
      },
      null
    );

    const report = await buildAcceptanceStatus({
      config: { accounts: [account], logsDir: path.join(root, 'logs') },
      database,
      now: Date.parse('2026-07-18T01:00:00.000Z'),
    });

    expect(report.activeCrossAccountProviderIdOverlap).toBe(1);
    expect(report.automatedArchiveGate.passed).toBe(false);
    expect(report.unattended.currentCleanWindow.satisfies72HourUnattended).toBe(
      false
    );
  });

  test('calculates nearest-rank percentiles', () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([9, 1, 5, 3], 0.5)).toBe(3);
    expect(percentile([9, 1, 5, 3], 0.95)).toBe(9);
  });
});
