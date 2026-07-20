const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  createDeliveryManifest,
} = require('../../archive-worker/delivery-contract');
const {
  buildDeliveryPackage,
} = require('../../archive-worker/delivery-package');
const {
  createFilesystemAdapter,
} = require('../../archive-worker/filesystem-adapters');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('filesystem adapter delivers once and acknowledges duplicate safely', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-adapter-'));
  const raw = Buffer.from('original');
  const rawPath = path.join(root, 'original.eml');
  await fs.writeFile(rawPath, raw);
  const manifest = createDeliveryManifest({
    message: {
      id: 10,
      accountId: 'a',
      providerMessageId: 'p',
      rawBlobHash: hash(raw),
    },
    destinations: ['vitasci-crm'],
  });
  const packageResult = await buildDeliveryPackage({
    manifest,
    rawMessagePath: rawPath,
    attachmentPaths: {},
    outputRoot: path.join(root, 'packages'),
    hashFn: hash,
  });
  const adapter = createFilesystemAdapter({
    destination: 'vitasci-crm',
    inboxPath: path.join(root, 'inbox'),
  });
  const first = await adapter.deliver({
    packageRoot: packageResult.packageRoot,
  });
  const second = await adapter.deliver({
    packageRoot: packageResult.packageRoot,
  });
  expect(first.accepted).toBe(true);
  expect(second.duplicate).toBe(true);
  expect(
    await fs.readFile(
      path.join(first.destinationRecordId, 'original.eml'),
      'utf8'
    )
  ).toBe('original');
  await fs.rm(root, { recursive: true, force: true });
});
