const crypto = require('crypto');
const path = require('path');

const DELIVERY_SCHEMA = 'email-assistant.delivery.v1';

// An attachment filename is attacker-controlled (it comes verbatim from the inbound
// email). It is later joined into a filesystem path when the delivery package is built,
// so anything other than a plain basename — separators, a `..` segment, an absolute
// path — could escape the package directory. A safe name is one that survives
// path.basename() unchanged and is not a relative-traversal token.
function isSafeAttachmentName(fileName) {
  if (typeof fileName !== 'string' || fileName === '') return false;
  if (fileName.includes('/') || fileName.includes('\\')) return false;
  if (fileName.includes('\0')) return false;
  if (fileName === '.' || fileName === '..') return false;
  return path.basename(fileName) === fileName;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createDeliveryManifest({
  message,
  attachments = [],
  destinations = [],
  triage,
}) {
  if (!message?.id || !message?.rawBlobHash) {
    throw new Error(
      'Delivery manifest requires archive message id and raw blob hash'
    );
  }
  return {
    schema: DELIVERY_SCHEMA,
    archive_message_id: message.id,
    source_account_id: message.accountId,
    provider_message_id: message.providerMessageId,
    provider_thread_id: message.providerThreadId || null,
    raw_message_sha256: message.rawBlobHash,
    attachments: attachments.map((attachment) => ({
      archive_attachment_id: attachment.id,
      file_name: attachment.fileName,
      media_type: attachment.mediaType || null,
      blob_sha256: attachment.blobHash || null,
      size: attachment.size ?? null,
      security_status: attachment.securityStatus || 'unscanned',
    })),
    proposed_destinations: [...new Set(destinations)].sort(),
    triage: triage || { categories: [], confidence: 0, reason: 'unclassified' },
    created_at: new Date().toISOString(),
  };
}

function validateDeliveryManifest(manifest) {
  const errors = [];
  if (manifest?.schema !== DELIVERY_SCHEMA) errors.push('unsupported-schema');
  if (!Number.isInteger(manifest?.archive_message_id)) {
    errors.push('missing-archive-message-id');
  }
  if (!/^[a-f0-9]{64}$/.test(manifest?.raw_message_sha256 || '')) {
    errors.push('invalid-raw-message-hash');
  }
  if (!Array.isArray(manifest?.attachments)) {
    errors.push('attachments-not-array');
  }
  for (const attachment of manifest?.attachments || []) {
    if (!/^[a-f0-9]{64}$/.test(attachment.blob_sha256 || '')) {
      errors.push(`invalid-attachment-hash:${attachment.file_name}`);
    }
    if (!['safe'].includes(attachment.security_status)) {
      errors.push(`attachment-not-safe:${attachment.file_name}`);
    }
    if (!isSafeAttachmentName(attachment.file_name)) {
      errors.push(`unsafe-attachment-name:${attachment.file_name}`);
    }
  }
  if (!Array.isArray(manifest?.proposed_destinations)) {
    errors.push('destinations-not-array');
  }
  return { valid: errors.length === 0, errors };
}

function manifestDigest(manifest) {
  const unsigned = { ...manifest };
  delete unsigned.manifest_digest;
  return sha256(JSON.stringify(unsigned));
}

module.exports = {
  DELIVERY_SCHEMA,
  createDeliveryManifest,
  validateDeliveryManifest,
  manifestDigest,
  isSafeAttachmentName,
};
