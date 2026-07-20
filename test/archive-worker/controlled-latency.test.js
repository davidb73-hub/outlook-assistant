const { ArchiveDatabase } = require('../../archive-worker/database');
const {
  buildControlledLatencyReport,
  DEFAULT_TARGET_SECONDS,
} = require('../../archive-worker/controlled-latency');

describe('controlled latency report', () => {
  let database;
  const account = {
    id: 'gmail-personal',
    provider: 'gmail',
    displayName: 'Personal Gmail',
  };

  beforeEach(() => {
    database = new ArchiveDatabase(':memory:');
    database.upsertAccount(account);
  });

  afterEach(() => database.close());

  function addMessage(providerMessageId, seconds, state = 'archived_complete') {
    const message = database.stageMessage(
      account.id,
      {
        providerMessageId,
        subject: 'fixture',
        receivedAt: '2026-07-18T00:00:00.000Z',
        direction: 'inbound',
        locations: [],
      },
      null
    );
    database.db
      .prepare(
        `UPDATE messages
            SET first_archived_at = ?, archive_state = ?
          WHERE id = ?`
      )
      .run(
        new Date(
          Date.parse('2026-07-18T00:00:00.000Z') + seconds * 1000
        ).toISOString(),
        state,
        message.id
      );
  }

  test('reports sanitized metrics and applies the approved target', () => {
    for (let index = 0; index < 20; index += 1) {
      addMessage(`message-${index + 1}`, 60 + index);
    }
    const report = buildControlledLatencyReport({
      database,
      samples: Array.from({ length: 20 }, (_, index) => ({
        accountId: account.id,
        providerMessageId: `message-${index + 1}`,
      })),
    });

    expect(report.passes).toBe(true);
    expect(report.measured).toEqual(
      expect.objectContaining({
        sampleCount: 20,
        completeCount: 20,
        missingCount: 0,
        incompleteCount: 0,
        duplicateCount: 0,
        medianSeconds: 69,
        p95Seconds: 78,
        maximumSeconds: 79,
      })
    );
    expect(report.targetSeconds).toEqual(DEFAULT_TARGET_SECONDS);
    expect(JSON.stringify(report)).not.toContain('fixture');
  });

  test('does not pass missing, duplicate, or incomplete samples', () => {
    addMessage('complete', 60);
    addMessage('pending', 0, 'archived_pending_attachments');
    const report = buildControlledLatencyReport({
      database,
      samples: [
        { accountId: account.id, providerMessageId: 'complete' },
        { accountId: account.id, providerMessageId: 'complete' },
        { accountId: account.id, providerMessageId: 'pending' },
        { accountId: account.id, providerMessageId: 'missing' },
      ],
    });

    expect(report.passes).toBe(false);
    expect(report.measured).toEqual(
      expect.objectContaining({
        sampleCount: 3,
        completeCount: 1,
        missingCount: 1,
        incompleteCount: 1,
        duplicateCount: 1,
      })
    );
  });
});
