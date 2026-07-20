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
        accounts: [{ accountId: account.id, status: 'completed' }],
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
        accounts: [{ accountId: account.id, status: 'completed' }],
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
        completedCycles: REQUIRED_72_HOUR_CYCLES - 200,
        satisfies72HourUnattended: false,
      })
    );
  });

  test('calculates nearest-rank percentiles', () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([9, 1, 5, 3], 0.5)).toBe(3);
    expect(percentile([9, 1, 5, 3], 0.95)).toBe(9);
  });
});
