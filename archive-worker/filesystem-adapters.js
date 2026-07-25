const fs = require('fs/promises');
const path = require('path');
const {
  validateDeliveryManifest,
  manifestDigest,
} = require('./delivery-contract');

// Node reports an existing target from fs.cp as ERR_FS_CP_EEXIST — the bare 'EEXIST'
// string appears only in the message, never in error.code. Guarding on 'EEXIST' alone
// therefore matched nothing: every redelivery rethrew instead of falling through to the
// receipt lookup, and 28 VitaSci jobs walked their retry limit into 'review'.
function isAlreadyExists(error) {
  return error?.code === 'ERR_FS_CP_EEXIST' || error?.code === 'EEXIST';
}

// Destinations disagree on shape: VitaSci's ack schema writes a single `reason`
// string, Ruvocal writes a `reasons` array. Reading only the array silently threw
// away every VitaSci explanation and logged the generic 'destination-rejected',
// leaving no way to tell routine triage from a real contract failure.
function rejectionReason(receipt) {
  const raw = receipt?.reasons ?? receipt?.reason;
  let joined = '';
  if (Array.isArray(raw)) {
    joined = raw.filter(Boolean).join(',');
  } else if (typeof raw === 'string') {
    joined = raw.trim();
  }
  return joined || 'destination-rejected';
}

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

      let alreadyPresent = false;
      try {
        await fs.access(target);
        alreadyPresent = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      const duplicateAck = () => ({
        accepted: true,
        manifestDigest: digest,
        destinationRecordId: target,
        duplicate: true,
      });

      if (alreadyPresent && !receiptRoot) return duplicateAck();

      // Copy only when the package isn't already there. Re-copying a directory the
      // destination may be mid-read is pointless work at best.
      if (!alreadyPresent) {
        try {
          await fs.cp(job.packageRoot, target, {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
        } catch (error) {
          // A concurrent delivery won the race. The package is present either way,
          // so carry on to the receipt lookup rather than failing the job.
          if (!isAlreadyExists(error)) throw error;
          if (!receiptRoot) return duplicateAck();
        }
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
              reason: rejectionReason(receipt),
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
