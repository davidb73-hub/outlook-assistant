const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  buildDeliveryPackage,
} = require('../../archive-worker/delivery-package');
const {
  createDeliveryManifest,
} = require('../../archive-worker/delivery-contract');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('builds an immutable full-fidelity package and verifies hashes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'email-delivery-'));
  const raw = Buffer.from('raw email bytes');
  const attachment = Buffer.from('attachment bytes');
  const rawPath = path.join(root, 'raw.eml');
  const attachmentPath = path.join(root, 'invoice.pdf');
  await fs.writeFile(rawPath, raw);
  await fs.writeFile(attachmentPath, attachment);
  const manifest = createDeliveryManifest({
    message: {
      id: 1,
      accountId: 'vitasci-outlook',
      providerMessageId: 'p1',
      rawBlobHash: hash(raw),
    },
    attachments: [
      {
        id: 2,
        fileName: 'invoice.pdf',
        blobHash: hash(attachment),
        securityStatus: 'safe',
      },
    ],
    destinations: ['financial-assistant'],
  });
  const result = await buildDeliveryPackage({
    manifest,
    rawMessagePath: rawPath,
    attachmentPaths: { 2: attachmentPath },
    outputRoot: path.join(root, 'out'),
    hashFn: hash,
  });
  expect(
    await fs.readFile(path.join(result.packageRoot, 'original.eml'), 'utf8')
  ).toBe('raw email bytes');
  expect(
    await fs.readFile(
      path.join(result.packageRoot, 'attachments', 'invoice.pdf'),
      'utf8'
    )
  ).toBe('attachment bytes');
  expect(
    JSON.parse(
      await fs.readFile(path.join(result.packageRoot, 'manifest.json'))
    ).manifest_digest
  ).toBe(result.manifestDigest);
  await fs.rm(root, { recursive: true, force: true });
});
