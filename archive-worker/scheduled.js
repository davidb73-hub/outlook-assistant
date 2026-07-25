#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const { buildArchiveConfig } = require('./config');
const { openArchive } = require('./index');
const { WorkerLock } = require('./lock');
const { notifyArchiveFailure } = require('./notifier');
const { DeliveryWorker } = require('./delivery-worker');
const { createFilesystemAdapter } = require('./filesystem-adapters');
const { routeArchivedMessageSafely } = require('./routing-orchestrator');
const { classifyWithLocalLLM } = require('./local-llm-triage');
const { sha256 } = require('./storage');

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const LOG_GENERATIONS = 4;

async function rotateLog(logPath) {
  let size = 0;
  try {
    size = (await fs.stat(logPath)).size;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (size < MAX_LOG_BYTES) return;
  for (let generation = LOG_GENERATIONS; generation >= 1; generation -= 1) {
    const source = generation === 1 ? logPath : `${logPath}.${generation - 1}`;
    const destination = `${logPath}.${generation}`;
    await fs.rm(destination, { force: true });
    await fs.rename(source, destination).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function appendOperationalLog(config, event) {
  await fs.mkdir(config.logsDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(config.logsDir, 'scheduled.jsonl');
  await rotateLog(logPath);
  await fs.appendFile(logPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  await fs.chmod(logPath, 0o600);
}

function scheduledStatus(results, reconciliations, backup) {
  if (backup.status === 'failed') return 'failed';
  if (
    results.some(
      (result) => !['completed', 'rate_limited'].includes(result.status)
    ) ||
    reconciliations.some(
      (result) => !['completed', 'rate_limited'].includes(result.status)
    )
  ) {
    return 'failed';
  }
  return [...results, ...reconciliations].some(
    (result) => result.status === 'rate_limited'
  )
    ? 'degraded'
    : 'completed';
}

async function runScheduled(env = process.env) {
  const startedAt = new Date();
  const config = buildArchiveConfig(env);
  const lock = new WorkerLock(config.root);
  let archive = null;
  try {
    await lock.acquire();
    archive = await openArchive(env);
    archive.database.interruptRunningRuns();
    const results = await archive.engine.runAll();
    const routed = [];
    for (const message of archive.database.listMessagesArchivedSince(
      startedAt.toISOString()
    )) {
      if (message.archive_state !== 'archived_complete') continue;
      const raw = archive.database.db
        .prepare('SELECT relative_path FROM blobs WHERE hash = ?')
        .get(message.raw_blob_hash);
      if (!raw) continue;
      const attachmentPaths = {};
      for (const attachment of message.attachments || []) {
        if (attachment.blob_hash) {
          attachmentPaths[attachment.id] = archive.contentStore.blobPath(
            'attachment',
            attachment.blob_hash
          );
        }
      }
      const route = await routeArchivedMessageSafely(
        {
          message: {
            ...message,
            accountId: message.account_id,
            providerMessageId: message.provider_message_id,
            providerThreadId: message.provider_thread_id,
            rawBlobHash: message.raw_blob_hash,
            bodyText: message.body_text,
            attachments: (message.attachments || []).map((attachment) => ({
              id: attachment.id,
              fileName: attachment.file_name,
              mediaType: attachment.media_type,
              blobHash: attachment.blob_hash,
              size: attachment.size,
              securityStatus:
                archive.database.db
                  .prepare(
                    'SELECT status FROM attachment_security WHERE attachment_id = ?'
                  )
                  .get(attachment.id)?.status || 'unscanned',
            })),
          },
          rawMessagePath: archive.contentStore.blobPath(
            'raw-message',
            message.raw_blob_hash
          ),
          attachmentPaths,
          database: archive.database,
          outputRoot: path.join(config.root, 'delivery-packages'),
          hashFn: sha256,
          classifier: (candidate) =>
            classifyWithLocalLLM(candidate, {
              endpoint: env.LOCAL_LLM_ENDPOINT || undefined,
              model: env.LOCAL_LLM_MODEL || undefined,
            }),
        },
        (error, failed) => {
          // Record and move on — one message must not fail the whole run.
          archive.database.recordIngestionError({
            runId: null,
            accountId: failed.accountId,
            providerMessageId: failed.providerMessageId,
            stage: 'routing',
            code: error.code || 'ROUTE_FAILED',
            message: error.message,
            retryable: true,
          });
        }
      );
      routed.push({
        messageId: message.id,
        status: route.status,
        destinations: route.triage?.destinations || [],
        error: route.error?.message || undefined,
      });
    }
    const reconciliations = [];
    for (const account of archive.config.accounts) {
      const syncResult = results.find(
        (result) => result.accountId === account.id
      );
      if (
        syncResult?.status === 'completed' &&
        archive.engine.reconciliationDue(account)
      ) {
        reconciliations.push(await archive.engine.reconcileAccount(account));
      }
    }
    const allHealthy =
      results.every((result) => result.status === 'completed') &&
      reconciliations.every((result) => result.status === 'completed');
    const adapters = Object.fromEntries(
      Object.entries(archive.config.deliveryDestinations).map(
        ([destination, inboxPath]) => [
          destination,
          createFilesystemAdapter({
            destination,
            inboxPath,
            receiptRoot:
              archive.config.deliveryReceiptRoots?.[destination] || null,
          }),
        ]
      )
    );
    const deliveries = await new DeliveryWorker({
      database: archive.database,
      adapters,
    }).processPending();
    let backup = { status: 'not_due' };
    if (allHealthy && (await archive.backup.isBackupDue())) {
      try {
        const summary = await archive.backup.backup();
        backup = {
          status: 'completed',
          snapshotId: summary.snapshotId,
          blobCount: summary.manifest.blobCount,
          dataAdded: summary.dataAdded,
        };
      } catch (error) {
        backup = {
          status: 'failed',
          errorCode: error.code || 'BACKUP_FAILED',
          errorMessage: String(error.message).slice(0, 500),
        };
      }
    }
    const event = {
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      status: scheduledStatus(results, reconciliations, backup),
      backup,
      deliveries: deliveries.map((delivery) => ({
        id: delivery.id,
        destination: delivery.destination,
        status: delivery.status,
        error: delivery.last_error || null,
      })),
      routed,
      reconciliations: reconciliations.map((result) => ({
        accountId: result.accountId,
        status: result.status,
        providerEligible: result.providerEligible,
        localEligible: result.localEligible,
        differences: result.differences,
        errors: result.errors,
      })),
      accounts: results.map((result) => ({
        accountId: result.accountId,
        status: result.status,
        discovered: result.discovered,
        archived: result.archived,
        errors: result.errors,
        errorCode: result.error?.code || null,
        retryable: result.error?.retryable ?? null,
      })),
    };
    if (event.status === 'failed') {
      event.notification = await notifyArchiveFailure();
    }
    await appendOperationalLog(config, event);
    return event;
  } catch (error) {
    const event = {
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      status: 'failed',
      errorCode: error.code || 'SCHEDULED_RUN_FAILED',
      errorMessage: String(error.message).slice(0, 500),
    };
    if (!String(error.message).includes('already running as process')) {
      event.notification = await notifyArchiveFailure();
    }
    await appendOperationalLog(config, event);
    throw error;
  } finally {
    if (archive) archive.database.close();
    await lock.release();
  }
}

function eventExitCode(event) {
  return ['completed', 'degraded'].includes(event.status) ? 0 : 1;
}

if (require.main === module) {
  runScheduled()
    .then((event) => {
      process.exitCode = eventExitCode(event);
    })
    .catch(() => {
      process.exitCode = 1;
    });
}

module.exports = {
  LOG_GENERATIONS,
  MAX_LOG_BYTES,
  appendOperationalLog,
  eventExitCode,
  rotateLog,
  runScheduled,
  scheduledStatus,
};
