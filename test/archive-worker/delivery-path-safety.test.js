const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  buildDeliveryPackage,
} = require('../../archive-worker/delivery-package');
const {
  createDeliveryManifest,
  validateDeliveryManifest,
} = require('../../archive-worker/delivery-contract');

// An email attachment filename is attacker-controlled. It flows unsanitized from the
// provider through the archive DB into buildDeliveryPackage's path.join sink. A filename
// containing traversal segments would escape packageRoot and plant an attacker-controlled
// file anywhere the worker can write — including the vault's Email Briefs folder that
// downstream agents treat as trusted. The manifest validator and the package builder must
// both refuse it.

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

const TRAVERSAL_NAMES = [
  '../../../../Assistant-Vault/Business/Email Briefs/evil.md',
  '..\\..\\evil.md',
  '/etc/cron.d/evil',
  'sub/dir/evil.md',
];

describe('delivery manifest rejects attachment filenames that are not plain basenames', () => {
  test.each(TRAVERSAL_NAMES)('rejects %s', (fileName) => {
    const manifest = createDeliveryManifest({
      message: {
        id: 1,
        accountId: 'vitasci-outlook',
        providerMessageId: 'p1',
        rawBlobHash: hash('raw'),
      },
      attachments: [
        {
          id: 2,
          fileName,
          blobHash: hash('bytes'),
          securityStatus: 'safe',
        },
      ],
      destinations: ['hannibal-briefs'],
    });
    const result = validateDeliveryManifest(manifest);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.startsWith('unsafe-attachment-name'))
    ).toBe(true);
  });

  test('accepts a plain filename', () => {
    const manifest = createDeliveryManifest({
      message: {
        id: 1,
        accountId: 'vitasci-outlook',
        providerMessageId: 'p1',
        rawBlobHash: hash('raw'),
      },
      attachments: [
        {
          id: 2,
          fileName: 'invoice.pdf',
          blobHash: hash('bytes'),
          securityStatus: 'safe',
        },
      ],
      destinations: ['financial-assistant'],
    });
    expect(validateDeliveryManifest(manifest).valid).toBe(true);
  });
});

describe('buildDeliveryPackage never writes outside the package root', () => {
  test('a traversal filename that reaches the builder throws instead of escaping', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'email-delivery-esc-')
    );
    try {
      const raw = Buffer.from('raw');
      const attachment = Buffer.from('bytes');
      const rawPath = path.join(root, 'raw.eml');
      const attachmentPath = path.join(root, 'blob');
      await fs.writeFile(rawPath, raw);
      await fs.writeFile(attachmentPath, attachment);
      // Build a valid manifest, then tamper the filename after validation so we exercise
      // the builder's own containment guard (defence in depth, not only the validator).
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
            fileName: 'ok.pdf',
            blobHash: hash(attachment),
            securityStatus: 'safe',
          },
        ],
        destinations: ['financial-assistant'],
      });
      manifest.attachments[0].file_name = `../../../../escaped-${Date.now()}.md`;
      const escapedDir = path.dirname(
        path.resolve(root, 'out', manifest.attachments[0].file_name)
      );
      await expect(
        buildDeliveryPackage({
          manifest,
          rawMessagePath: rawPath,
          attachmentPaths: { 2: attachmentPath },
          outputRoot: path.join(root, 'out'),
          hashFn: hash,
        })
      ).rejects.toThrow(/attachment|path|outside|unsafe/i);
      // Nothing was planted outside the package root.
      const planted = path
        .basename(manifest.attachments[0].file_name)
        .replace(/^\.\.[\\/]/g, '');
      await expect(fs.access(path.join(escapedDir, planted))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
