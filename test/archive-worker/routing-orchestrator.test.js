const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  routeArchivedMessage,
  routeArchivedMessageSafely,
} = require('../../archive-worker/routing-orchestrator');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('classifies, packages, and enqueues a multi-destination archived message', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'routing-orchestrator-')
  );
  const raw = Buffer.from('VitaSci invoice — deadline for the signed contract');
  const rawPath = path.join(root, 'message.eml');
  await fs.writeFile(rawPath, raw);
  const database = { enqueueDelivery: jest.fn(() => [1, 2, 3]) };
  const result = await routeArchivedMessage({
    message: {
      id: 9,
      accountId: 'vitasci-outlook',
      providerMessageId: 'p9',
      rawBlobHash: hash(raw),
      subject: 'VitaSci invoice — deadline for the signed contract',
      bodyText: '',
      attachments: [],
    },
    rawMessagePath: rawPath,
    attachmentPaths: {},
    database,
    outputRoot: path.join(root, 'packages'),
    hashFn: hash,
  });
  expect(result.status).toBe('proposed');
  expect(database.enqueueDelivery).toHaveBeenCalledWith(
    9,
    ['financial-assistant', 'vitasci-crm', 'hannibal-briefs'],
    expect.any(String)
  );
  await fs.rm(root, { recursive: true, force: true });
});

test('routeArchivedMessageSafely isolates a message whose attachment is unsafe, and does not throw', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-safe-'));
  const raw = Buffer.from('VitaSci invoice — deadline for the signed contract');
  const rawPath = path.join(root, 'message.eml');
  const attachmentBytes = Buffer.from('signature image bytes');
  const attachmentPath = path.join(root, 'image001.png');
  await fs.writeFile(rawPath, raw);
  await fs.writeFile(attachmentPath, attachmentBytes);
  const database = { enqueueDelivery: jest.fn(() => [1]) };
  const onError = jest.fn();

  const result = await routeArchivedMessageSafely(
    {
      message: {
        id: 42,
        accountId: 'vitasci-outlook',
        providerMessageId: 'p42',
        rawBlobHash: hash(raw),
        subject: 'VitaSci invoice — deadline for the signed contract',
        bodyText: '',
        attachments: [
          {
            id: 7,
            fileName: 'image001.png',
            blobHash: hash(attachmentBytes),
            size: attachmentBytes.length,
            securityStatus: 'unscanned', // never passed the security gate
          },
        ],
      },
      rawMessagePath: rawPath,
      attachmentPaths: { 7: attachmentPath },
      database,
      outputRoot: path.join(root, 'packages'),
      hashFn: hash,
    },
    onError
  );

  // The message is skipped, not fatal — and delivery was never enqueued.
  expect(result.status).toBe('error');
  expect(result.error.message).toMatch(/attachment-not-safe/);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(database.enqueueDelivery).not.toHaveBeenCalled();
  await fs.rm(root, { recursive: true, force: true });
});

test('routeArchivedMessageSafely returns the normal result when routing succeeds', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-safe-ok-'));
  const raw = Buffer.from('VitaSci invoice — deadline for the signed contract');
  const rawPath = path.join(root, 'message.eml');
  await fs.writeFile(rawPath, raw);
  const database = { enqueueDelivery: jest.fn(() => [1, 2, 3]) };
  const result = await routeArchivedMessageSafely({
    message: {
      id: 9,
      accountId: 'vitasci-outlook',
      providerMessageId: 'p9',
      rawBlobHash: hash(raw),
      subject: 'VitaSci invoice — deadline for the signed contract',
      bodyText: '',
      attachments: [],
    },
    rawMessagePath: rawPath,
    attachmentPaths: {},
    database,
    outputRoot: path.join(root, 'packages'),
    hashFn: hash,
  });
  expect(result.status).toBe('proposed');
  expect(database.enqueueDelivery).toHaveBeenCalled();
  await fs.rm(root, { recursive: true, force: true });
});
