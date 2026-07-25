const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { ArchiveDatabase } = require('../../archive-worker/database');
const {
  routeArchivedMessage,
} = require('../../archive-worker/routing-orchestrator');
const { DeliveryWorker } = require('../../archive-worker/delivery-worker');
const {
  createFilesystemAdapter,
} = require('../../archive-worker/filesystem-adapters');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('end-to-end: archive, triage, package, three destinations, acknowledgement', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'email-e2e-'));
  const raw = Buffer.from(
    'From: sender@example.com\nSubject: VitaSci invoice — deadline for the signed contract\n\nOriginal email'
  );
  const rawPath = path.join(root, 'original.eml');
  await fs.writeFile(rawPath, raw);
  const database = new ArchiveDatabase(path.join(root, 'archive.sqlite3'));
  database.db
    .prepare(
      `INSERT INTO blobs(hash, kind, relative_path, size, created_at) VALUES (?, 'raw-message', 'raw-messages/e2e', ?, datetime('now'))`
    )
    .run(hash(raw), raw.length);
  database.db
    .prepare(
      `INSERT INTO accounts(id, provider, display_name, created_at, updated_at) VALUES ('vitasci-outlook', 'outlook', 'VitaSci', datetime('now'), datetime('now'))`
    )
    .run();
  database.db
    .prepare(
      `INSERT INTO messages(account_id, provider_message_id, subject, body_text, archive_state, first_archived_at, last_seen_at, updated_at, raw_blob_hash) VALUES ('vitasci-outlook', 'e2e-1', 'VitaSci invoice — deadline for the signed contract', '', 'archived_complete', datetime('now'), datetime('now'), datetime('now'), ?)`
    )
    .run(hash(raw));
  const messageId = database.db.prepare('SELECT id FROM messages').get().id;
  const message = {
    id: messageId,
    accountId: 'vitasci-outlook',
    providerMessageId: 'e2e-1',
    rawBlobHash: hash(raw),
    subject: 'VitaSci invoice — deadline for the signed contract',
    bodyText: '',
    attachments: [],
  };
  const proposed = await routeArchivedMessage({
    message,
    rawMessagePath: rawPath,
    attachmentPaths: {},
    database,
    outputRoot: path.join(root, 'packages'),
    hashFn: hash,
  });
  const destinations = [
    'financial-assistant',
    'vitasci-crm',
    'hannibal-briefs',
  ];
  const adapters = Object.fromEntries(
    destinations.map((destination) => [
      destination,
      createFilesystemAdapter({
        destination,
        inboxPath: path.join(root, destination),
      }),
    ])
  );
  const deliveries = await new DeliveryWorker({
    database,
    adapters,
  }).processPending();
  expect(proposed.status).toBe('proposed');
  expect(deliveries).toHaveLength(3);
  expect(deliveries.every((delivery) => delivery.status === 'delivered')).toBe(
    true
  );
  for (const destination of destinations) {
    const files = await fs.readdir(path.join(root, destination));
    expect(files).toHaveLength(1);
    expect(
      await fs.readFile(path.join(root, destination, files[0], 'original.eml'))
    ).toEqual(raw);
  }
  expect(database.listDeliveryJobs('delivered')).toHaveLength(3);
  database.close();
  await fs.rm(root, { recursive: true, force: true });
});
