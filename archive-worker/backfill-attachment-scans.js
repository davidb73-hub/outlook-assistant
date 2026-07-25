const {
  filenamePolicyVerdict,
  isCacheableBlobVerdict,
  scanAttachment,
} = require('./security-gate');

/**
 * Scan attachments that were archived without a security verdict (the bulk-hydrate gap)
 * and record the result, so messages holding them become deliverable. Idempotent and
 * resumable: it only touches attachments still lacking a terminal verdict, and it scans
 * each distinct content hash once, reusing the blob-level cache for repeats.
 *
 * @returns summary counts { scanned, cached, safe, quarantined, blocked, unavailable, skipped }
 */
async function backfillAttachmentScans({
  database,
  contentStore,
  scan = scanAttachment,
  clamscanPath,
  batchSize = 500,
  onProgress = null,
}) {
  const summary = {
    scanned: 0,
    cached: 0,
    safe: 0,
    quarantined: 0,
    blocked: 0,
    unavailable: 0,
    skipped: 0,
  };

  const tally = (status) => {
    if (status === 'safe') summary.safe += 1;
    else if (status === 'quarantined') summary.quarantined += 1;
    else if (status === 'blocked') summary.blocked += 1;
    else summary.unavailable += 1;
  };

  // Process in batches. Rows with a terminal verdict drop out of the next query; rows
  // that stay non-terminal (scanner_unavailable) would otherwise be re-selected forever,
  // so a `seen` set bounds each attachment to one scan per invocation and guarantees
  // termination — those rows are simply left for a future run once the scanner is fixed.
  const seen = new Set();
  for (;;) {
    const pending = database
      .listAttachmentsPendingSecurity(batchSize)
      .filter((attachment) => !seen.has(attachment.id));
    if (pending.length === 0) break;

    for (const attachment of pending) {
      seen.add(attachment.id);
      if (!attachment.blob_hash) {
        summary.skipped += 1;
        continue;
      }

      // Filename policy belongs to this attachment occurrence. Only the expensive,
      // content-derived malware verdict is reusable by hash.
      const policyVerdict = filenamePolicyVerdict(attachment.file_name);
      const cachedCandidate = policyVerdict
        ? null
        : database.getBlobSecurity(attachment.blob_hash);
      const cached = isCacheableBlobVerdict(cachedCandidate)
        ? cachedCandidate
        : null;
      let verdict = policyVerdict || cached;
      if (cached) {
        summary.cached += 1;
      } else if (!policyVerdict) {
        verdict = await scan({
          filePath: contentStore.blobPath('attachment', attachment.blob_hash),
          fileName: attachment.file_name,
          clamscanPath,
        });
        summary.scanned += 1;
        if (isCacheableBlobVerdict(verdict)) {
          database.recordBlobSecurity(attachment.blob_hash, verdict);
        }
      }

      database.recordAttachmentSecurity(
        attachment.message_id,
        attachment.provider_attachment_id,
        verdict
      );
      tally(verdict.status);
      if (onProgress) onProgress(summary);
    }
  }

  return summary;
}

module.exports = { backfillAttachmentScans };
