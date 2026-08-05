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
const { buildIdentityStatus } = require('./identity-status');
const {
  IDENTITY_SEED_CONFIRMATION,
  seedArchiveIdentities,
} = require('./seed-archive-identities');
const {
  CLONE_REHEARSAL_CONFIRMATION,
  DEFAULT_CONTAMINATION_WINDOW,
  runGmailPartitionCloneRehearsal,
} = require('./rehearse-gmail-partition-repair');
const {
  OWNER_APPROVAL_CONFIRMATION,
  applyLiveGmailPartitionRepair,
  buildLiveGmailPartitionRepairPlan,
  createLiveRepairOwnerApproval,
} = require('./live-gmail-partition-repair');
const {
  PRE_REPAIR_BACKUP_CONFIRMATION,
  createSchemaPreservingPreRepairBackup,
} = require('./pre-repair-backup');
const {
  buildControlledLatencyReport,
  DEFAULT_TARGET_SECONDS,
  readLatencySamples,
} = require('./controlled-latency');
const {
  GMAIL_IDENTITY_REMAP_CONFIRMATION,
  remapGmailIdentityIds,
} = require('./remap-gmail-identities');
const { backfillAttachmentScans } = require('./backfill-attachment-scans');
const { buildDeliveryPackage } = require('./delivery-package');
const { sha256 } = require('./storage');
const { DeliveryWorker } = require('./delivery-worker');
const { createFilesystemAdapter } = require('./filesystem-adapters');
const SqliteDatabase = require('better-sqlite3');
const fs = require('fs/promises');
const path = require('path');

async function openArchive(
  env = process.env,
  { initialiseAccounts = [] } = {}
) {
  const config = buildArchiveConfig(env);
  const database = new ArchiveDatabase(config.databasePath);
  const contentStore = new ContentStore(config.root);
  const service = new ArchiveService({
    database,
    contentStore,
    security: { clamScanPath: config.clamScanPath },
  });
  await service.initialise(initialiseAccounts);
  const engine = new ArchiveSyncEngine({
    database,
    service,
    config,
    providerFactory: (account) => createProvider(account, { gmail: { env } }),
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

function requireStringFlags(args, names, code) {
  for (const name of names) {
    if (!args.flags[name] || typeof args.flags[name] !== 'string') {
      throw new Error(`${code}: --${name} is required`);
    }
  }
}

async function reconcileAccountsSequentially(engine, accounts) {
  const results = [];
  for (const account of accounts) {
    results.push(await engine.reconcileAccount(account));
  }
  return results;
}

function liveRepairModeArguments(args) {
  const apply = args.flags.apply === true;
  requireStringFlags(
    args,
    apply
      ? ['plan-input', 'owner-approval', 'live-confirmation']
      : ['plan-output'],
    'GMAIL_LIVE_REPAIR_ARGUMENT_MISSING'
  );
  return { apply };
}

function assertCliSchemaMigrationSafe(existingSchemaVersion) {
  if (existingSchemaVersion > 0 && existingSchemaVersion < 11) {
    throw new Error(
      'ARCHIVE_SCHEMA_MIGRATION_REQUIRES_EXPLICIT_WORKFLOW: no ordinary command, including archive:init, may migrate an existing pre-repair archive; use the reviewed owner-gated repair workflow'
    );
  }
  return true;
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

async function runGmailRemapCommand({
  args,
  env,
  identityStatusBuilder = buildIdentityStatus,
  DatabaseImpl = SqliteDatabase,
}) {
  const config = buildArchiveConfig(env);
  const apply = args.flags.apply === true;
  const lock = apply ? new WorkerLock(config.root) : null;
  let db = null;
  try {
    if (lock) await lock.acquire();
    const identityProof = await identityStatusBuilder({ config, env });
    if (!identityProof.passed) {
      throw new Error(
        'GMAIL_REMAP_IDENTITY_UNPROVED: the privacy-safe identity audit did not pass'
      );
    }
    const ownershipManifest = args.flags['ownership-manifest']
      ? JSON.parse(await fs.readFile(args.flags['ownership-manifest'], 'utf8'))
      : null;
    db = new DatabaseImpl(config.databasePath, {
      readonly: !apply,
      fileMustExist: true,
    });
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    if (!apply) db.pragma('query_only = ON');
    else {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
    }
    return remapGmailIdentityIds(db, {
      apply,
      confirmation:
        args.flags['confirm-state-c'] === true
          ? GMAIL_IDENTITY_REMAP_CONFIRMATION
          : null,
      identityProof,
      ownershipManifest,
      ownershipPlanDigest: args.flags['ownership-plan-digest'] || null,
      preconditionDigest: args.flags['precondition-digest'] || null,
    });
  } finally {
    if (db) db.close();
    if (lock) await lock.release();
  }
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

function readExistingSchemaVersion(
  databasePath,
  DatabaseImpl = SqliteDatabase
) {
  if (!require('fs').existsSync(databasePath)) return 0;
  const database = new DatabaseImpl(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const exists = database
      .prepare(
        `SELECT 1 FROM sqlite_schema
         WHERE type = 'table' AND name = 'schema_migrations'`
      )
      .get();
    if (!exists) return 0;
    return (
      database
        .prepare('SELECT MAX(version) AS version FROM schema_migrations')
        .get().version || 0
    );
  } finally {
    database.close();
  }
}

async function main() {
  const args = parseArguments(process.argv);
  const env = { ...process.env };
  if (args.flags.root) env.EMAIL_ARCHIVE_ROOT = args.flags.root;
  // identity-status must remain a provider-only read. In particular, do not
  // call openArchive first: ArchiveDatabase migrations and service.initialise
  // are intentionally writable operations.
  if (args.command === 'identity-status') {
    const report = await buildIdentityStatus({
      config: buildArchiveConfig(env),
      env,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
    return;
  }
  // Bootstrap explicit semantic identities without opening or migrating the
  // archive. Both evidence databases are opened read-only by the command.
  if (args.command === 'seed-archive-identities') {
    if (!args.flags['anchor-db']) {
      throw new Error(
        'IDENTITY_SEED_EVIDENCE_PATH_MISSING: --anchor-db is required'
      );
    }
    const config = buildArchiveConfig(env);
    const report = await seedArchiveIdentities({
      envPath: args.flags['env-file'] || path.join(__dirname, '..', '.env'),
      archiveDatabasePath: config.databasePath,
      anchorDatabasePath: args.flags['anchor-db'],
      apply: args.flags.apply === true,
      confirmation:
        args.flags['confirm-verified-bindings'] === true
          ? IDENTITY_SEED_CONFIRMATION
          : null,
      processEnv: env,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (args.command === 'rehearse-gmail-partition-repair') {
    for (const required of ['clone-root', 'content-root', 'anchor-db']) {
      if (!args.flags[required] || typeof args.flags[required] !== 'string') {
        throw new Error(
          `GMAIL_REHEARSAL_ARGUMENT_MISSING: --${required} is required`
        );
      }
    }
    const config = buildArchiveConfig(env);
    const anchorManifestPath =
      args.flags['anchor-manifest'] ||
      path.join(path.dirname(args.flags['anchor-db']), 'manifest.json');
    const applyRehearsal = args.flags['apply-rehearsal'] === true;
    const report = await runGmailPartitionCloneRehearsal({
      cloneRoot: args.flags['clone-root'],
      contentRoot: args.flags['content-root'],
      anchorDatabasePath: args.flags['anchor-db'],
      anchorManifestPath,
      liveArchiveRoot: config.root,
      envPath: args.flags['env-file'] || path.join(__dirname, '..', '.env'),
      planOutputPath: args.flags['plan-output'] || null,
      planInputPath: args.flags['plan-input'] || null,
      applyRehearsal,
      confirmation:
        args.flags['confirm-clone-rehearsal'] === true
          ? CLONE_REHEARSAL_CONFIRMATION
          : null,
      contaminationWindow: {
        startedAt:
          args.flags['contamination-start'] ||
          DEFAULT_CONTAMINATION_WINDOW.startedAt,
        endedAt:
          args.flags['contamination-end'] ||
          DEFAULT_CONTAMINATION_WINDOW.endedAt,
      },
      processEnv: env,
      onProgress: (event) =>
        process.stderr.write(
          `${JSON.stringify({ event: 'GMAIL_REHEARSAL_PROGRESS', ...event })}\n`
        ),
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (args.command === 'live-gmail-partition-repair') {
    if (args.flags.root) {
      throw new Error(
        'GMAIL_LIVE_REPAIR_ROOT_AMBIGUOUS: --root overrides are prohibited for the live repair command'
      );
    }
    for (const required of [
      'live-root',
      'anchor-db',
      'source-snapshot-db',
      'pre-repair-restore-receipt',
    ]) {
      if (!args.flags[required] || typeof args.flags[required] !== 'string') {
        throw new Error(
          `GMAIL_LIVE_REPAIR_ARGUMENT_MISSING: --${required} is required`
        );
      }
    }
    const config = buildArchiveConfig(env);
    const { apply: applyLiveRepair } = liveRepairModeArguments(args);
    const common = {
      config,
      env,
      liveArchiveRoot: args.flags['live-root'],
      anchorDatabasePath: args.flags['anchor-db'],
      anchorManifestPath:
        args.flags['anchor-manifest'] ||
        path.join(path.dirname(args.flags['anchor-db']), 'manifest.json'),
      snapshotDatabasePath: args.flags['source-snapshot-db'],
      snapshotManifestPath:
        args.flags['source-snapshot-manifest'] ||
        path.join(
          path.dirname(args.flags['source-snapshot-db']),
          'manifest.json'
        ),
      backupMarkerPath:
        args.flags['backup-marker'] ||
        path.join(config.root, 'manifests', 'last-backup.json'),
      preRepairRestoreReceiptPath: args.flags['pre-repair-restore-receipt'],
      contaminationWindow: {
        startedAt:
          args.flags['contamination-start'] ||
          DEFAULT_CONTAMINATION_WINDOW.startedAt,
        endedAt:
          args.flags['contamination-end'] ||
          DEFAULT_CONTAMINATION_WINDOW.endedAt,
      },
      onProgress: (event) =>
        process.stderr.write(
          `${JSON.stringify({ event: 'GMAIL_LIVE_REPAIR_PROGRESS', ...event })}\n`
        ),
    };
    const report = applyLiveRepair
      ? await applyLiveGmailPartitionRepair({
          ...common,
          planInputPath: args.flags['plan-input'],
          ownerApprovalPath: args.flags['owner-approval'],
          typedConfirmation: args.flags['live-confirmation'],
        })
      : await buildLiveGmailPartitionRepairPlan({
          ...common,
          planOutputPath: args.flags['plan-output'],
        });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (args.command === 'approve-live-gmail-partition-repair') {
    if (args.flags.root) {
      throw new Error(
        'GMAIL_LIVE_REPAIR_ROOT_AMBIGUOUS: --root overrides are prohibited for owner approval'
      );
    }
    for (const required of [
      'live-root',
      'plan-input',
      'clone-rehearsal-db',
      'approval-output',
      'approved-plan-digest',
    ]) {
      if (!args.flags[required] || typeof args.flags[required] !== 'string') {
        throw new Error(
          `GMAIL_LIVE_REPAIR_ARGUMENT_MISSING: --${required} is required`
        );
      }
    }
    const config = buildArchiveConfig(env);
    if (
      (await fs.realpath(path.resolve(args.flags['live-root']))) !==
      (await fs.realpath(config.root))
    ) {
      throw new Error(
        'GMAIL_LIVE_REPAIR_ROOT_AMBIGUOUS: explicit and configured live roots disagree'
      );
    }
    const report = await createLiveRepairOwnerApproval({
      planInputPath: args.flags['plan-input'],
      cloneDatabasePath: args.flags['clone-rehearsal-db'],
      approvalOutputPath: args.flags['approval-output'],
      approvedPlanDigest: args.flags['approved-plan-digest'],
      approvalId: args.flags['approval-id'] || null,
      confirmation:
        args.flags['approve-reviewed-plan'] === true
          ? OWNER_APPROVAL_CONFIRMATION
          : null,
      liveArchiveRoot: config.root,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (args.command === 'pre-repair-backup') {
    if (args.flags.root) {
      throw new Error(
        'PRE_REPAIR_BACKUP_ROOT_AMBIGUOUS: --root overrides are prohibited'
      );
    }
    for (const required of ['live-root', 'restore-target', 'receipt-output']) {
      if (!args.flags[required] || typeof args.flags[required] !== 'string') {
        throw new Error(
          `PRE_REPAIR_BACKUP_ARGUMENT_MISSING: --${required} is required`
        );
      }
    }
    const config = buildArchiveConfig(env);
    const report = await createSchemaPreservingPreRepairBackup({
      config,
      liveArchiveRoot: args.flags['live-root'],
      restoreTarget: args.flags['restore-target'],
      receiptOutputPath: args.flags['receipt-output'],
      confirmation:
        args.flags['confirm-schema-preserving-backup'] === true
          ? PRE_REPAIR_BACKUP_CONFIRMATION
          : null,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  // Keep dry-run genuinely read-only: opening the normal ArchiveService would
  // run migrations and update account timestamps before the remap inspected
  // anything. Apply has its own explicit lock and one-shot transaction.
  if (args.command === 'remap-gmail-identities') {
    console.log(
      JSON.stringify(await runGmailRemapCommand({ args, env }), null, 2)
    );
    return;
  }
  const configuredBeforeOpen = buildArchiveConfig(env);
  const existingSchemaVersion = readExistingSchemaVersion(
    configuredBeforeOpen.databasePath
  );
  assertCliSchemaMigrationSafe(existingSchemaVersion);
  const archive = await openArchive(env);
  try {
    if (args.command === 'init') {
      await archive.service.initialise(archive.config.accounts);
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
      if (!archive.config.downstreamDeliveryEnabled) {
        throw new Error(
          'DOWNSTREAM_DELIVERY_GATED: Phase 1 archive acceptance has not enabled delivery'
        );
      }
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
    if (args.command === 'backfill-scans') {
      const summary = await backfillAttachmentScans({
        database: archive.database,
        contentStore: archive.contentStore,
        clamscanPath: archive.config.clamScanPath,
        batchSize: Number(args.flags.batch) || 500,
        onProgress: (running) => {
          if ((running.scanned + running.cached) % 500 === 0) {
            process.stderr.write(
              `  scanned ${running.scanned}, cached ${running.cached}…\n`
            );
          }
        },
      });
      console.log(JSON.stringify(summary, null, 2));
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
        const accounts = selectedAccounts(
          archive.config,
          args.flags.account || null
        );
        const results =
          args.command === 'sync'
            ? await archive.engine.runAll(accounts)
            : await reconcileAccountsSequentially(archive.engine, accounts);
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
  assertCliSchemaMigrationSafe,
  liveRepairModeArguments,
  openArchive,
  parseArguments,
  reconcileAccountsSequentially,
  requireStringFlags,
  readExistingSchemaVersion,
  runGmailRemapCommand,
  selectedAccounts,
  verifyArchive,
};
