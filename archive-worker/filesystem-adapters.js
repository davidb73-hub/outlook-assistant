const fs = require('fs/promises');
const path = require('path');
const {
  validateDeliveryManifest,
  manifestDigest,
} = require('./delivery-contract');

function createFilesystemAdapter({
  destination,
  inboxPath,
  receiptRoot = null,
}) {
  return {
    async deliver(job) {
      if (!job.packageRoot) {
        return { accepted: false, reason: 'package-root-missing' };
      }
      const manifestPath = path.join(job.packageRoot, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      const validation = validateDeliveryManifest(manifest);
      if (!validation.valid) {
        return { accepted: false, reason: validation.errors.join(',') };
      }
      if (!manifest.proposed_destinations.includes(destination)) {
        return { accepted: false, reason: 'wrong-destination' };
      }
      const digest = manifestDigest(manifest);
      const target = path.join(inboxPath, `${digest}.delivery`);
      await fs.mkdir(inboxPath, { recursive: true, mode: 0o700 });
      try {
        await fs.access(target);
        if (!receiptRoot) {
          return {
            accepted: true,
            manifestDigest: digest,
            destinationRecordId: target,
            duplicate: true,
          };
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      try {
        await fs.cp(job.packageRoot, target, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      } catch (error) {
        if (error.code === 'EEXIST') {
          if (!receiptRoot) {
            return {
              accepted: true,
              manifestDigest: digest,
              destinationRecordId: target,
              duplicate: true,
            };
          }
        }
        if (error.code !== 'EEXIST') throw error;
      }
      if (receiptRoot) {
        const receiptPaths = [
          path.join(
            receiptRoot,
            `${manifest.archive_message_id}-${digest}.receipt.json`
          ),
          path.join(receiptRoot, `${digest}.receipt.json`),
        ];
        try {
          let receipt;
          for (const receiptPath of receiptPaths) {
            try {
              receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
              break;
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
          }
          if (!receipt) {
            return {
              accepted: false,
              pending: true,
              reason: 'awaiting-destination-receipt',
            };
          }
          if (receipt.status !== 'accepted') {
            return {
              accepted: false,
              reason: receipt.reasons?.join(',') || 'destination-rejected',
            };
          }
          return {
            accepted: true,
            manifestDigest: digest,
            destinationRecordId: receipt.provenance_event_id || target,
          };
        } catch (error) {
          if (error.code === 'ENOENT') {
            return {
              accepted: false,
              pending: true,
              reason: 'awaiting-destination-receipt',
            };
          }
          throw error;
        }
      }
      return {
        accepted: true,
        manifestDigest: digest,
        destinationRecordId: target,
      };
    },
  };
}

module.exports = { createFilesystemAdapter };
