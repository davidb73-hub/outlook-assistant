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
  const triage = classifier
    ? await classifier(message)
    : classifyMessage(message);
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

module.exports = { routeArchivedMessage };
