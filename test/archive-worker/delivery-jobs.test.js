const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { ArchiveDatabase } = require('../../archive-worker/database');

test('delivery jobs are durable, deduplicated, and auditable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-jobs-'));
  const db = new ArchiveDatabase(path.join(dir, 'archive.sqlite3'));
  db.db
    .prepare(
      `INSERT INTO accounts(id, provider, display_name, created_at, updated_at) VALUES ('a', 'gmail', 'A', datetime('now'), datetime('now'))`
    )
    .run();
  db.db
    .prepare(
      `INSERT INTO messages(account_id, provider_message_id, archive_state, first_archived_at, last_seen_at, updated_at) VALUES ('a', 'm', 'archived_complete', datetime('now'), datetime('now'), datetime('now'))`
    )
    .run();
  const message = db.db.prepare('SELECT id FROM messages').get();
  expect(
    db.enqueueDelivery(message.id, ['financial-assistant', 'vitasci-crm'])
  ).toHaveLength(2);
  expect(db.enqueueDelivery(message.id, ['financial-assistant'])).toHaveLength(
    1
  );
  expect(db.listDeliveryJobs()).toHaveLength(2);
  expect(
    db.db.prepare('SELECT COUNT(*) AS count FROM delivery_events').get().count
  ).toBe(3);
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});
