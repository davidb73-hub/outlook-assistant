const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  routeArchivedMessage,
} = require('../../archive-worker/routing-orchestrator');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('classifies, packages, and enqueues a multi-destination archived message', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'routing-orchestrator-')
  );
  const raw = Buffer.from('VitaSci invoice project update');
  const rawPath = path.join(root, 'message.eml');
  await fs.writeFile(rawPath, raw);
  const database = { enqueueDelivery: jest.fn(() => [1, 2, 3]) };
  const result = await routeArchivedMessage({
    message: {
      id: 9,
      accountId: 'vitasci-outlook',
      providerMessageId: 'p9',
      rawBlobHash: hash(raw),
      subject: 'VitaSci invoice project update',
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
