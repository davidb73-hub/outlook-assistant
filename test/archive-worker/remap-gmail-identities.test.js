const fs = require('fs');
const os = require('os');
const path = require('path');
const { ArchiveDatabase } = require('../../archive-worker/database');
const {
  remapGmailIdentityIds,
} = require('../../archive-worker/remap-gmail-identities');

describe('Gmail identity remapping', () => {
  let database;

  beforeEach(() => {
    database = new ArchiveDatabase(
      path.join(os.tmpdir(), `remap-gmail-identities-${process.pid}.sqlite3`)
    );
    database.upsertAccount({
      id: 'gmail-ablative',
      provider: 'gmail',
      displayName: 'Ablative Gmail',
    });
    database.upsertAccount({
      id: 'gmail-personal',
      provider: 'gmail',
      displayName: 'Personal Gmail',
    });
    database.upsertFolder('gmail-ablative', {
      providerFolderId: 'inbox',
      displayName: 'Inbox',
      kind: 'inbox',
    });
    database.stageMessage(
      'gmail-ablative',
      {
        providerMessageId: 'personal-message',
        subject: 'fixture',
        receivedAt: '2026-07-18T00:00:00.000Z',
        direction: 'inbound',
        locations: [{ providerLocationId: 'inbox', kind: 'inbox' }],
      },
      null
    );
    database.stageMessage(
      'gmail-personal',
      {
        providerMessageId: 'ablative-message',
        subject: 'fixture',
        receivedAt: '2026-07-18T00:00:00.000Z',
        direction: 'inbound',
        locations: [],
      },
      null
    );
  });

  afterEach(() => {
    const databasePath = database.databasePath;
    database.close();
    fs.rmSync(databasePath, { force: true });
  });

  test('swaps all account-scoped records without changing message identities', () => {
    const before = database.db
      .prepare(
        'SELECT account_id, provider_message_id FROM messages ORDER BY provider_message_id'
      )
      .all();
    const result = remapGmailIdentityIds(database);
    const after = database.db
      .prepare(
        'SELECT account_id, provider_message_id FROM messages ORDER BY provider_message_id'
      )
      .all();

    expect(result.foreignKeyProblems).toBe(0);
    expect(after).toEqual([
      { account_id: 'gmail-ablative', provider_message_id: 'ablative-message' },
      { account_id: 'gmail-personal', provider_message_id: 'personal-message' },
    ]);
    expect(before.map((row) => row.provider_message_id)).toEqual(
      after.map((row) => row.provider_message_id)
    );
    expect(database.db.pragma('integrity_check', { simple: true })).toBe('ok');
  });
});
