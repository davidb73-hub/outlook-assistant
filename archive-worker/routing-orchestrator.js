const { classifyMessage } = require('./triage-router');
const { createDeliveryManifest } = require('./delivery-contract');
const { buildDeliveryPackage } = require('./delivery-package');

async function routeArchivedMessage({
  message,
  rawMessagePath,
  attachmentPaths,
  database,
  outputRoot,
  hashFn,
  classifier = null,
}) {
  // Supply the known-correspondent signal the classifier expects. Without this
  // `message.knownDomains` was always undefined, so isKnownCorrespondent returned null,
  // the veto never fired, and every message ate the unknown-sender penalty — the
  // precision fix was built, commented and tested, but disconnected in production.
  //
  // NOTE: looksLikeBulk's List-Unsubscribe/List-Id veto is still inert. The archive
  // does not capture internet message headers (0 of 27,469 rows have them), so only
  // the from-address half of that check can work until headers are captured at sync
  // time. Stated here rather than left to look complete.
  const enriched =
    message.knownDomains || !database?.getKnownDomains
      ? message
      : { ...message, knownDomains: database.getKnownDomains() };
  const triage = classifier
    ? await classifier(enriched)
    : classifyMessage(enriched);
  if (triage.disposition !== 'proposed') {
    return { status: 'review', triage, jobs: [] };
  }
  const manifest = createDeliveryManifest({
    message,
    attachments: message.attachments || [],
    destinations: triage.destinations,
    triage,
  });
  const packageResult = await buildDeliveryPackage({
    manifest,
    rawMessagePath,
    attachmentPaths,
    outputRoot,
    hashFn,
  });
  const jobs = database.enqueueDelivery(
    message.id,
    triage.destinations,
    packageResult.packageRoot
  );
  return { status: 'proposed', triage, manifest, packageResult, jobs };
}

// Routing one message must never fail the whole scheduled run. A single message with an
// unscanned or quarantined attachment makes buildDeliveryPackage throw (the delivery
// contract refuses anything not marked 'safe'); before this wrapper that exception
// propagated out of the per-message loop and failed sync, reconciliation and backup for
// every account, firing a "archive needs attention" notification for what is usually a
// benign signature image. Here the failure is isolated to its own message and reported
// via onError, and the loop continues.
async function routeArchivedMessageSafely(opts, onError = null) {
  try {
    return await routeArchivedMessage(opts);
  } catch (error) {
    if (onError) await onError(error, opts.message);
    return {
      status: 'error',
      error: { code: error.code || 'ROUTE_FAILED', message: error.message },
      triage: null,
      jobs: [],
    };
  }
}

module.exports = { routeArchivedMessage, routeArchivedMessageSafely };
