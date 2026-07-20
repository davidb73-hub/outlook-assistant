#!/usr/bin/env node
const { ArchiveService } = require('./archive-service');
const { buildArchiveConfig } = require('./config');
const { ArchiveDatabase } = require('./database');
const { ContentStore } = require('./storage');
const { ArchiveSyncEngine } = require('./sync-engine');
const { createProvider } = require('./providers');
const { WorkerLock } = require('./lock');
const { BackupManager } = require('./backup');
const { buildAcceptanceStatus } = require('./acceptance-status');
const {
  buildControlledLatencyReport,
  DEFAULT_TARGET_SECONDS,
  readLatencySamples,
} = require('./controlled-latency');
const { remapGmailIdentityIds } = require('./remap-gmail-identities');
const { buildDeliveryPackage } = require('./delivery-package');
const { sha256 } = require('./storage');
const { DeliveryWorker } = require('./delivery-worker');
const { createFilesystemAdapter } = require('./filesystem-adapters');

async function openArchive(env = process.env) {
  const config = buildArchiveConfig(env);
  const database = new ArchiveDatabase(config.databasePath);
  const contentStore = new ContentStore(config.root);
  const service = new ArchiveService({
    database,
    contentStore,
    security: { clamScanPath: config.clamScanPath },
  });
  await service.initialise(config.accounts);
  const engine = new ArchiveSyncEngine({
    database,
    service,
    config,
    providerFactory: createProvider,
  });
  const backup = new BackupManager({ config, database });
  return { config, database, contentStore, service, engine, backup };
}

function parseArguments(argv) {
  const result = { command: argv[2] || 'status', values: [], flags: {} };
  for (let index = 3; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith('--')) {
      const name = value.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) result.flags[name] = true;
      else {
        result.flags[name] = next;
        index += 1;
      }
    } else result.values.push(value);
  }
  return result;
}

function selectedAccounts(config, accountId = null) {
  if (!accountId) return config.accounts;
  const account = config.accounts.find(
    (candidate) => candidate.id === accountId
  );
  if (!account) {
    throw new Error(
      `Unknown account '${accountId}'. Choose: ${config.accounts
        .map((candidate) => candidate.id)
        .join(', ')}`
    );
  }
  return [account];
}

async function verifyArchive(archive) {
  const blobs = archive.database.listBlobs();
  const failed = [];
  for (const blob of blobs) {
    if (
      !(await archive.contentStore.verify({
        hash: blob.hash,
        relativePath: blob.relative_path,
        size: blob.size,
      }))
    ) {
      failed.push(blob.hash);
    }
  }
  return {
    integrity: archive.database.db.pragma('integrity_check', { simple: true }),
    blobCount: blobs.length,
    verifiedBlobCount: blobs.length - failed.length,
    failedHashes: failed,
    ok:
      failed.length === 0 &&
      archive.database.db.pragma('integrity_check', { simple: true }) === 'ok',
  };
}

async function main() {
  const args = parseArguments(process.argv);
  const env = { ...process.env };
  if (args.flags.root) env.EMAIL_ARCHIVE_ROOT = args.flags.root;
  const archive = await openArchive(env);
  try {
    if (args.command === 'init') {
      console.log(`Archive initialised: ${archive.config.root}`);
      return;
    }
    if (args.command === 'status') {
      console.log(JSON.stringify(archive.database.status(), null, 2));
      return;
    }
    if (args.command === 'acceptance-status') {
      console.log(
        JSON.stringify(
          await buildAcceptanceStatus({
            config: archive.config,
            database: archive.database,
          }),
          null,
          2
        )
      );
      return;
    }
    if (args.command === 'latency-report') {
      if (!args.flags.input || typeof args.flags.input !== 'string') {
        throw new Error(
          'Latency report requires --input pointing to a temporary JSON sample file'
        );
      }
      const samples = await readLatencySamples(args.flags.input);
      console.log(
        JSON.stringify(
          buildControlledLatencyReport({
            database: archive.database,
            samples,
            target: DEFAULT_TARGET_SECONDS,
          }),
          null,
          2
        )
      );
      return;
    }
    if (args.command === 'build-delivery-package') {
      if (!args.flags.manifest || !args.flags.raw || !args.flags.output) {
        throw new Error(
          'build-delivery-package requires --manifest, --raw, and --output'
        );
      }
      const manifest = JSON.parse(
        await require('fs/promises').readFile(args.flags.manifest, 'utf8')
      );
      const attachmentPaths = {};
      for (const item of manifest.attachments || []) {
        const flag = `attachment-${item.archive_attachment_id}`;
        if (!args.flags[flag]) throw new Error(`Missing --${flag}`);
        attachmentPaths[item.archive_attachment_id] = args.flags[flag];
      }
      const result = await buildDeliveryPackage({
        manifest,
        rawMessagePath: args.flags.raw,
        attachmentPaths,
        outputRoot: args.flags.output,
        hashFn: sha256,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (args.command === 'delivery-run') {
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
      const results = await new DeliveryWorker({
        database: archive.database,
        adapters,
      }).processPending();
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    if (args.command === 'remap-gmail-identities') {
      console.log(
        JSON.stringify(remapGmailIdentityIds(archive.database), null, 2)
      );
      return;
    }
    if (args.command === 'search') {
      const query = args.values.join(' ');
      if (!query && !args.flags.after && !args.flags.before) {
        throw new Error('Search requires text, --after, or --before');
      }
      console.log(
        JSON.stringify(
          archive.database.search(query, {
            accountId: args.flags.account || null,
            limit: args.flags.limit || 50,
            after: args.flags.after || null,
            before: args.flags.before || null,
          }),
          null,
          2
        )
      );
      return;
    }
    if (args.command === 'verify') {
      const verification = await verifyArchive(archive);
      console.log(JSON.stringify(verification, null, 2));
      if (!verification.ok) process.exitCode = 1;
      return;
    }
    if (args.command === 'backfill-reset') {
      const [account] = selectedAccounts(
        archive.config,
        args.flags.account || null
      );
      if (!args.flags.account) {
        throw new Error('Backfill reset requires an explicit --account');
      }
      const runId = archive.database.beginRun(account.id, 'backfill_reset', {
        reason: args.flags.reason || 'operator_requested',
      });
      const cleared = archive.database.clearCursor(account.id, 'backfill');
      archive.database.finishRun(
        runId,
        'completed',
        {},
        {
          cleared,
          reason: args.flags.reason || 'operator_requested',
        }
      );
      console.log(
        JSON.stringify(
          {
            accountId: account.id,
            backfillCheckpointCleared: cleared === 1,
            archivedContentDeleted: false,
          },
          null,
          2
        )
      );
      return;
    }
    if (args.command === 'backup-status') {
      console.log(JSON.stringify(await archive.backup.snapshots(), null, 2));
      return;
    }
    if (args.command === 'backup' || args.command === 'restore') {
      if (args.command === 'restore' && !args.values[0] && !args.flags.target) {
        throw new Error('Restore requires a new empty target directory');
      }
      const lock = new WorkerLock(archive.config.root);
      await lock.acquire();
      try {
        const result =
          args.command === 'backup'
            ? await archive.backup.backup()
            : await archive.backup.restore(
                args.values[0] || args.flags.target || ''
              );
        console.log(JSON.stringify(result, null, 2));
        if (result.ok === false) process.exitCode = 1;
      } finally {
        await lock.release();
      }
      return;
    }
    if (args.command === 'sync' || args.command === 'reconcile') {
      const lock = new WorkerLock(archive.config.root);
      await lock.acquire();
      try {
        archive.database.interruptRunningRuns();
        const accounts = selectedAccounts(
          archive.config,
          args.flags.account || null
        );
        const results =
          args.command === 'sync'
            ? await archive.engine.runAll(accounts)
            : await Promise.all(
                accounts.map((account) =>
                  archive.engine.reconcileAccount(account)
                )
              );
        console.log(JSON.stringify(results, null, 2));
        if (results.some((result) => result.status !== 'completed')) {
          process.exitCode = 1;
        }
      } finally {
        await lock.release();
      }
      return;
    }
    throw new Error(`Unknown archive command: ${args.command}`);
  } finally {
    archive.database.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Archive command failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  openArchive,
  parseArguments,
  selectedAccounts,
  verifyArchive,
};
