const fs = require('fs/promises');
const path = require('path');
const {
  validateDeliveryManifest,
  manifestDigest,
} = require('./delivery-contract');

async function copyVerified(source, destination, expectedHash, hashFn) {
  const content = await fs.readFile(source);
  if (hashFn(content) !== expectedHash) {
    throw new Error(`Source hash mismatch: ${source}`);
  }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs
    .writeFile(destination, content, { mode: 0o600, flag: 'wx' })
    .catch(async (error) => {
      if (error.code !== 'EEXIST') throw error;
      const existing = await fs.readFile(destination);
      if (hashFn(existing) !== expectedHash) {
        throw new Error(`Destination hash mismatch: ${destination}`);
      }
    });
}

async function buildDeliveryPackage({
  manifest,
  rawMessagePath,
  attachmentPaths,
  outputRoot,
  hashFn,
}) {
  const validation = validateDeliveryManifest(manifest);
  if (!validation.valid) {
    throw new Error(
      `Invalid delivery manifest: ${validation.errors.join(', ')}`
    );
  }
  const digest = manifestDigest(manifest);
  const packageRoot = path.join(
    outputRoot,
    `message-${manifest.archive_message_id}-${digest.slice(0, 12)}`
  );
  await fs.mkdir(packageRoot, { recursive: true, mode: 0o700 });
  await copyVerified(
    rawMessagePath,
    path.join(packageRoot, 'original.eml'),
    manifest.raw_message_sha256,
    hashFn
  );
  for (const attachment of manifest.attachments) {
    const source = attachmentPaths[attachment.archive_attachment_id];
    if (!source) {
      throw new Error(
        `Missing attachment path: ${attachment.archive_attachment_id}`
      );
    }
    await copyVerified(
      source,
      path.join(packageRoot, 'attachments', attachment.file_name),
      attachment.blob_sha256,
      hashFn
    );
  }
  await fs.writeFile(
    path.join(packageRoot, 'manifest.json'),
    `${JSON.stringify({ ...manifest, manifest_digest: digest }, null, 2)}\n`,
    { mode: 0o600 }
  );
  return { packageRoot, manifestDigest: digest };
}

module.exports = { buildDeliveryPackage };
