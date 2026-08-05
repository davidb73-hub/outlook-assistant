const path = require('path');
const { createRequire } = require('module');
const archiveRequire = createRequire(
  path.resolve(__dirname, '../../archive-worker/fts-index-test-loader.js')
);
const Database = archiveRequire('better-sqlite3');
const {
  FTS_ACCOUNT_UPDATE_SQL,
  inspectFtsConsistency,
  messageKey,
} = require('../../archive-worker/fts-index');

describe('linear FTS ownership index', () => {
  test('checks a realistic row set with two exact linear scans', () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE messages(id INTEGER PRIMARY KEY, account_id TEXT NOT NULL);
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        message_id UNINDEXED,
        account_id UNINDEXED,
        subject,
        body,
        participants
      );
    `);
    const insertMessage = database.prepare(
      'INSERT INTO messages(id, account_id) VALUES (?, ?)'
    );
    const insertFts = database.prepare(
      `INSERT INTO messages_fts(
         message_id, account_id, subject, body, participants
       ) VALUES (?, ?, '', '', '')`
    );
    database.transaction(() => {
      for (let id = 1; id <= 10_000; id += 1) {
        insertMessage.run(id, id % 2 ? 'gmail-ablative' : 'gmail-personal');
      }
      // Reverse insertion proves that FTS rowid must never be assumed to equal
      // the stable messages.id value.
      for (let id = 10_000; id >= 1; id -= 1) {
        insertFts.run(id, id % 2 ? 'gmail-ablative' : 'gmail-personal');
      }
    })();
    const prepare = jest.spyOn(database, 'prepare');
    const startedAt = Date.now();

    const inspected = inspectFtsConsistency(database);

    expect(inspected.summary).toEqual({
      accountMismatches: 0,
      missingRows: 0,
      orphanRows: 0,
      duplicateRows: 0,
      messageRows: 10_000,
      ftsRows: 10_000,
      passed: true,
    });
    expect(inspected.rowsByMessageId.size).toBe(10_000);
    expect(inspected.rowsByMessageId.get(messageKey(1)).fts_rowid).not.toBe(1);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls.every(([sql]) => !/JOIN/i.test(sql))).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    database.close();
  });

  test('targets account repair through the indexed FTS rowid constraint', () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE messages(id INTEGER PRIMARY KEY, account_id TEXT NOT NULL);
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        message_id UNINDEXED,
        account_id UNINDEXED,
        subject,
        body,
        participants
      );
      INSERT INTO messages VALUES (41, 'gmail-personal');
      INSERT INTO messages_fts(
        message_id, account_id, subject, body, participants
      ) VALUES (41, 'gmail-ablative', '', '', '');
    `);
    const inspected = inspectFtsConsistency(database);
    const row = inspected.rowsByMessageId.get(messageKey(41));
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${FTS_ACCOUNT_UPDATE_SQL}`)
      .all('gmail-personal', row.fts_rowid, 41, 'gmail-ablative');

    expect(plan.map((step) => step.detail).join(' ')).toContain(
      'VIRTUAL TABLE INDEX 0:='
    );
    expect(
      database
        .prepare(FTS_ACCOUNT_UPDATE_SQL)
        .run('gmail-personal', row.fts_rowid, 41, 'gmail-ablative').changes
    ).toBe(1);
    expect(inspectFtsConsistency(database).summary.passed).toBe(true);
    database.close();
  });
});
