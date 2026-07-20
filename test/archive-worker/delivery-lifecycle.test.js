const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { ArchiveDatabase } = require('../../archive-worker/database');

test('delivery lifecycle records running, rejection, and retry evidence', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-lifecycle-'));
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
  const id = db.db.prepare('SELECT id FROM messages').get().id;
  const job = db.enqueueDelivery(id, ['financial-assistant'])[0];
  expect(db.updateDeliveryJob(job, 'running').attempts).toBe(1);
  expect(
    db.updateDeliveryJob(job, 'rejected', { error: 'not financially relevant' })
      .status
  ).toBe('rejected');
  expect(db.updateDeliveryJob(job, 'pending', { error: null }).status).toBe(
    'pending'
  );
  expect(
    db.db.prepare('SELECT COUNT(*) AS count FROM delivery_events').get().count
  ).toBe(4);
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});
