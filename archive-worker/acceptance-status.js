const fs = require('fs/promises');
const path = require('path');

const SCHEDULE_INTERVAL_MS = 15 * 60 * 1000;
const UNATTENDED_ACCEPTANCE_MS = 72 * 60 * 60 * 1000;
const REQUIRED_72_HOUR_CYCLES = UNATTENDED_ACCEPTANCE_MS / SCHEDULE_INTERVAL_MS;

function metadata(row) {
  try {
    return row?.metadata_json ? JSON.parse(row.metadata_json) : {};
  } catch {
    return {};
  }
}

function percentile(values, ratio) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)];
}

async function readOperationalEvents(logsDir) {
  const paths = [4, 3, 2, 1]
    .map((generation) => path.join(logsDir, `scheduled.jsonl.${generation}`))
    .concat(path.join(logsDir, 'scheduled.jsonl'));
  const events = [];
  let bytes = 0;
  let malformedLines = 0;
  for (const logPath of paths) {
    let content;
    try {
      const [stat, text] = await Promise.all([
        fs.stat(logPath),
        fs.readFile(logPath, 'utf8'),
      ]);
      bytes += stat.size;
      content = text;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const line of content.split('\n').filter(Boolean)) {
      try {
        events.push(JSON.parse(line));
      } catch {
        malformedLines += 1;
      }
    }
  }
  return { bytes, events, malformedLines };
}

async function buildAcceptanceStatus({ config, database, now = Date.now() }) {
  const operational = await readOperationalEvents(config.logsDir);
  const datedEvents = operational.events
    .map((event) => ({
      event,
      timestampMs: new Date(event.timestamp).getTime(),
    }))
    .filter(({ timestampMs }) => Number.isFinite(timestampMs))
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const validTimes = datedEvents.map(({ timestampMs }) => timestampMs);
  const firstEventMs = validTimes[0] || now - 72 * 60 * 60 * 1000;
  const lastEventMs = validTimes.at(-1) || null;
  const since = new Date(firstEventMs).toISOString();

  const accountRows = new Map(
    database.status().accounts.map((row) => [row.id, row])
  );
  const unresolved = new Map(
    database.db
      .prepare(
        `SELECT account_id, COUNT(*) AS count
         FROM ingestion_errors WHERE resolved_at IS NULL
         GROUP BY account_id`
      )
      .all()
      .map((row) => [row.account_id, row.count])
  );
  const coverage = new Map(
    database.db
      .prepare(
        `SELECT m.account_id,
                COUNT(DISTINCT CASE WHEN ml.kind = 'inbox' THEN m.id END) AS inbox_messages,
                COUNT(DISTINCT CASE WHEN ml.kind = 'sent' THEN m.id END) AS sent_messages,
                COUNT(DISTINCT CASE WHEN ml.kind = 'archive' THEN m.id END) AS archive_messages,
                COUNT(DISTINCT CASE WHEN ml.kind = 'custom' THEN m.id END) AS custom_messages
         FROM messages m
         LEFT JOIN message_locations ml ON ml.message_id = m.id
         GROUP BY m.account_id`
      )
      .all()
      .map((row) => [row.account_id, row])
  );
  const excludedFolderCounts = new Map(
    database.db
      .prepare(
        `SELECT account_id, COUNT(*) AS count
         FROM folders WHERE excluded = 1 GROUP BY account_id`
      )
      .all()
      .map((row) => [row.account_id, row.count])
  );
  const excludedMessageCounts = new Map(
    database.db
      .prepare(
        `SELECT m.account_id, COUNT(DISTINCT m.id) AS count
         FROM messages m
         JOIN message_locations ml ON ml.message_id = m.id
         JOIN folders f
           ON f.account_id = m.account_id
          AND f.provider_folder_id = ml.provider_location_id
         WHERE f.excluded = 1
         GROUP BY m.account_id`
      )
      .all()
      .map((row) => [row.account_id, row.count])
  );
  const latencyByAccount = new Map();
  for (const row of database.db
    .prepare(
      `SELECT account_id,
              unixepoch(first_archived_at) - unixepoch(received_at) AS seconds
       FROM messages
       WHERE received_at >= ?
         AND first_archived_at >= received_at
         AND archive_state = 'archived_complete'`
    )
    .all(since)) {
    if (!latencyByAccount.has(row.account_id)) {
      latencyByAccount.set(row.account_id, []);
    }
    latencyByAccount.get(row.account_id).push(Number(row.seconds));
  }

  const accounts = config.accounts.map((account) => {
    const summary = accountRows.get(account.id) || {};
    const backfill = database.getCursor(account.id, 'backfill');
    const reconciliation = database.getCursor(account.id, 'reconciliation');
    const backfillMetadata = metadata(backfill);
    const reconciliationMetadata = metadata(reconciliation);
    const locations = coverage.get(account.id) || {};
    const latencies = latencyByAccount.get(account.id) || [];
    return {
      accountId: account.id,
      messages: Number(summary.message_count || 0),
      completeMessages: Number(summary.complete_count || 0),
      pendingMessages: Number(summary.pending_count || 0),
      tombstones: Number(summary.tombstone_count || 0),
      unresolvedErrors: Number(unresolved.get(account.id) || 0),
      backfillComplete: backfillMetadata.complete === true,
      reconciliationComplete: reconciliationMetadata.complete === true,
      reconciliationDifferences: reconciliationMetadata.differences ?? null,
      locations: {
        inboxMessages: Number(locations.inbox_messages || 0),
        sentMessages: Number(locations.sent_messages || 0),
        archiveMessages: Number(locations.archive_messages || 0),
        customMessages: Number(locations.custom_messages || 0),
        excludedFoldersDiscovered: Number(
          excludedFolderCounts.get(account.id) || 0
        ),
        messagesInExcludedFolders: Number(
          excludedMessageCounts.get(account.id) || 0
        ),
      },
      passiveLatency: {
        since,
        sampleCount: latencies.length,
        medianSeconds: percentile(latencies, 0.5),
        p95Seconds: percentile(latencies, 0.95),
        maximumSeconds: latencies.length ? Math.max(...latencies) : null,
        satisfiesControlledSample: false,
      },
    };
  });

  const scheduledCycles = operational.events.filter((event) =>
    Array.isArray(event.accounts)
  );
  const completedCycles = scheduledCycles.filter(
    (event) => event.status === 'completed'
  );
  const overlapRejections = operational.events.filter(
    (event) =>
      event.status === 'failed' &&
      String(event.errorMessage || '').includes('already running as process')
  ).length;
  const lastFailureIndex = datedEvents.findLastIndex(
    ({ event }) => event.status === 'failed'
  );
  const lastFailureMs =
    lastFailureIndex >= 0 ? datedEvents[lastFailureIndex].timestampMs : null;
  const cleanEvents = datedEvents.slice(lastFailureIndex + 1);
  const cleanScheduledCycles = cleanEvents.filter(({ event }) =>
    Array.isArray(event.accounts)
  );
  const cleanCompletedCycles = cleanScheduledCycles.filter(
    ({ event }) => event.status === 'completed'
  );
  const cleanStartMs = cleanEvents[0]?.timestampMs || null;
  const cleanLastEventMs = cleanEvents.at(-1)?.timestampMs || null;
  const cleanElapsedMs = cleanStartMs === null ? 0 : now - cleanStartMs;
  const cleanLastEventAgeMs =
    cleanLastEventMs === null ? null : now - cleanLastEventMs;
  const integrity = database.db.pragma('integrity_check', { simple: true });

  return {
    generatedAt: new Date(now).toISOString(),
    integrity,
    accounts,
    automatedArchiveGate: {
      passed:
        integrity === 'ok' &&
        accounts.every(
          (account) =>
            account.backfillComplete &&
            account.reconciliationComplete &&
            account.reconciliationDifferences === 0 &&
            account.pendingMessages === 0 &&
            account.unresolvedErrors === 0 &&
            account.locations.messagesInExcludedFolders === 0
        ),
      excludesElapsedAndOwnerControlledTests: true,
    },
    unattended: {
      firstEventAt: validTimes.length
        ? new Date(firstEventMs).toISOString()
        : null,
      lastEventAt: lastEventMs ? new Date(lastEventMs).toISOString() : null,
      elapsedHoursSinceFirstEvent: validTimes.length
        ? Math.floor(((now - firstEventMs) / 3_600_000) * 100) / 100
        : 0,
      eventSpanHours:
        validTimes.length > 1
          ? Math.floor(((lastEventMs - firstEventMs) / 3_600_000) * 100) / 100
          : 0,
      scheduledCycles: scheduledCycles.length,
      completedCycles: completedCycles.length,
      failedEvents: operational.events.filter(
        (event) => event.status === 'failed'
      ).length,
      overlapRejections,
      logBytes: operational.bytes,
      malformedLogLines: operational.malformedLines,
      satisfies72HourElapsed: now - firstEventMs >= UNATTENDED_ACCEPTANCE_MS,
      currentCleanWindow: {
        resetByFailureAt: lastFailureMs
          ? new Date(lastFailureMs).toISOString()
          : null,
        startedAt: cleanStartMs ? new Date(cleanStartMs).toISOString() : null,
        lastEventAt: cleanLastEventMs
          ? new Date(cleanLastEventMs).toISOString()
          : null,
        elapsedHours:
          cleanStartMs === null
            ? 0
            : Math.floor((cleanElapsedMs / 3_600_000) * 100) / 100,
        scheduledCycles: cleanScheduledCycles.length,
        completedCycles: cleanCompletedCycles.length,
        requiredCompletedCycles: REQUIRED_72_HOUR_CYCLES,
        lastEventAgeMinutes:
          cleanLastEventAgeMs === null
            ? null
            : Math.floor((cleanLastEventAgeMs / 60_000) * 100) / 100,
        satisfies72HourUnattended:
          operational.malformedLines === 0 &&
          cleanElapsedMs >= UNATTENDED_ACCEPTANCE_MS &&
          cleanCompletedCycles.length >= REQUIRED_72_HOUR_CYCLES &&
          cleanLastEventAgeMs !== null &&
          cleanLastEventAgeMs <= 2 * SCHEDULE_INTERVAL_MS,
      },
    },
  };
}

module.exports = {
  buildAcceptanceStatus,
  metadata,
  percentile,
  readOperationalEvents,
  REQUIRED_72_HOUR_CYCLES,
};
