const fs = require('fs/promises');

const DEFAULT_TARGET_SECONDS = Object.freeze({
  median: 10 * 60,
  p95: 20 * 60,
  maximum: 30 * 60,
});

function percentile(values, ratio) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)];
}

function sanitiseSamples(input) {
  const samples = Array.isArray(input) ? input : input?.samples;
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('Latency input must contain a non-empty samples array');
  }
  return samples.map((sample) => {
    if (!sample?.accountId || !sample?.providerMessageId) {
      throw new Error(
        'Each latency sample requires accountId and providerMessageId'
      );
    }
    return {
      accountId: String(sample.accountId),
      providerMessageId: String(sample.providerMessageId),
    };
  });
}

function buildControlledLatencyReport({
  database,
  samples: rawSamples,
  target = DEFAULT_TARGET_SECONDS,
}) {
  const samples = sanitiseSamples(rawSamples);
  const findMessage = database.db.prepare(
    `SELECT account_id, provider_message_id, received_at, first_archived_at,
            archive_state
       FROM messages
      WHERE account_id = ? AND provider_message_id = ?`
  );
  const seen = new Set();
  const seconds = [];
  let duplicateCount = 0;
  let missingCount = 0;
  let incompleteCount = 0;
  const byAccount = new Map();

  for (const sample of samples) {
    const key = `${sample.accountId}\u0000${sample.providerMessageId}`;
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    const account = byAccount.get(sample.accountId) || {
      sampleCount: 0,
      completeCount: 0,
    };
    account.sampleCount += 1;
    const message = findMessage.get(sample.accountId, sample.providerMessageId);
    if (!message) {
      missingCount += 1;
      byAccount.set(sample.accountId, account);
      continue;
    }
    const receivedMs = Date.parse(message.received_at);
    const archivedMs = Date.parse(message.first_archived_at);
    if (
      message.archive_state !== 'archived_complete' ||
      !Number.isFinite(receivedMs) ||
      !Number.isFinite(archivedMs) ||
      archivedMs < receivedMs
    ) {
      incompleteCount += 1;
      byAccount.set(sample.accountId, account);
      continue;
    }
    account.completeCount += 1;
    seconds.push(Math.floor((archivedMs - receivedMs) / 1000));
    byAccount.set(sample.accountId, account);
  }

  const measured = {
    sampleCount: seen.size,
    completeCount: seconds.length,
    missingCount,
    incompleteCount,
    duplicateCount,
    medianSeconds: percentile(seconds, 0.5),
    p95Seconds: percentile(seconds, 0.95),
    maximumSeconds: seconds.length ? Math.max(...seconds) : null,
  };
  const passes =
    measured.sampleCount === 20 &&
    measured.completeCount === 20 &&
    measured.missingCount === 0 &&
    measured.incompleteCount === 0 &&
    measured.duplicateCount === 0 &&
    measured.medianSeconds <= target.median &&
    measured.p95Seconds <= target.p95 &&
    measured.maximumSeconds <= target.maximum;

  return {
    targetSeconds: target,
    measured,
    byAccount: Object.fromEntries(byAccount),
    passes,
  };
}

async function readLatencySamples(inputPath) {
  const text = await fs.readFile(inputPath, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Latency input is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
}

module.exports = {
  DEFAULT_TARGET_SECONDS,
  buildControlledLatencyReport,
  readLatencySamples,
  sanitiseSamples,
};
