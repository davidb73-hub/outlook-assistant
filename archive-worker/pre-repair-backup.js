const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const SqliteDatabase = require('better-sqlite3');
const { ArchiveDatabase } = require('./database');
const { BackupManager, fileHash } = require('./backup');
const { WorkerLock } = require('./lock');
const { inspectFtsConsistency } = require('./fts-index');
const {
  ARCHIVE_LAUNCHD_LABEL,
  assertExplicitLiveRoot,
  assertLiveServiceQuiesced,
  currentSchemaVersion,
  inspectArchiveWorkerProcesses,
  inspectSchedulerDisabled,
} = require('./live-gmail-partition-repair');

const PRE_REPAIR_BACKUP_CONFIRMATION =
  'CREATE_AND_RESTORE_SCHEMA_PRESERVING_PRE_REPAIR_BACKUP';
const REQUIRED_PRE_REPAIR_SCHEMA_VERSION = 7;
const PRE_REPAIR_RESTORE_RECEIPT_KIND =
  'email-assistant-pre-repair-restore-receipt';

function sha256Json(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function receiptDigest(receipt) {
  const { receiptDigest: _ignored, ...unsigned } = receipt;
  return sha256Json(unsigned);
}

function backupError(code, message = null, cause = null) {
  const error = new Error(message ? `${code}: ${message}` : code, {
    cause: cause || undefined,
  });
  error.code = code;
  return error;
}

function sourceCounts(database) {
  return Object.fromEntries(
    ['accounts', 'messages', 'attachments', 'blobs'].map((table) => [
      table,
      database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
    ])
  );
}

function rawBackupAdapter(database) {
  return {
    db: database,
    listBlobs: () =>
      database
        .prepare(
          `SELECT hash, kind, relative_path, size, media_type
           FROM blobs ORDER BY kind, hash`
        )
        .all(),
  };
}

async function assertNewEmptyRestoreTarget(target) {
  const resolved = path.resolve(target || '');
  if (
    resolved !== '/tmp' &&
    !resolved.startsWith('/tmp/') &&
    resolved !== '/private/tmp' &&
    !resolved.startsWith('/private/tmp/')
  ) {
    throw backupError('PRE_REPAIR_BACKUP_RESTORE_TARGET_UNSAFE');
  }
  if (resolved === '/' || resolved === path.parse(resolved).root) {
    throw backupError('PRE_REPAIR_BACKUP_RESTORE_TARGET_UNSAFE');
  }
  try {
    const stat = await fsPromises.lstat(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw backupError('PRE_REPAIR_BACKUP_RESTORE_TARGET_UNSAFE');
    }
    if ((await fsPromises.readdir(resolved)).length !== 0) {
      throw backupError('PRE_REPAIR_BACKUP_RESTORE_TARGET_NOT_EMPTY');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fsPromises.mkdir(resolved, { recursive: false, mode: 0o700 });
  }
  return fs.realpathSync(resolved);
}

async function verifyExactPreRepairRestore({
  restoreTarget,
  expectedSnapshotId,
  DatabaseImpl = SqliteDatabase,
  ArchiveDatabaseImpl = ArchiveDatabase,
} = {}) {
  if (!expectedSnapshotId) {
    throw backupError('PRE_REPAIR_BACKUP_SNAPSHOT_ID_MISSING');
  }
  const snapshotRoot = path.join(restoreTarget, 'snapshots', 'current');
  const databasePath = path.join(snapshotRoot, 'archive.sqlite3');
  const manifestPath = path.join(snapshotRoot, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await fsPromises.readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw backupError(
      'PRE_REPAIR_BACKUP_RESTORE_MANIFEST_INVALID',
      null,
      error
    );
  }
  if (
    manifest?.formatVersion !== 1 ||
    !Array.isArray(manifest.blobs) ||
    manifest.blobCount !== manifest.blobs.length ||
    manifest.tableCounts?.blobs !== manifest.blobCount ||
    sha256Json(manifest.blobs) !== manifest.blobInventorySha256 ||
    (await fileHash(databasePath)) !== manifest.databaseSha256
  ) {
    throw backupError('PRE_REPAIR_BACKUP_RESTORE_DATABASE_HASH_MISMATCH');
  }
  const database = new DatabaseImpl(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  let counts;
  try {
    database.pragma('foreign_keys = ON');
    database.pragma('query_only = ON');
    if (
      currentSchemaVersion(database) !== REQUIRED_PRE_REPAIR_SCHEMA_VERSION ||
      database.pragma('integrity_check', { simple: true }) !== 'ok' ||
      database.pragma('foreign_key_check').length !== 0 ||
      !inspectFtsConsistency(database).summary.passed
    ) {
      throw backupError('PRE_REPAIR_BACKUP_RESTORE_DATABASE_INVALID');
    }
    counts = sourceCounts(database);
  } finally {
    database.close();
  }
  if (JSON.stringify(counts) !== JSON.stringify(manifest.tableCounts)) {
    throw backupError('PRE_REPAIR_BACKUP_RESTORE_COUNT_MISMATCH');
  }
  let verifiedBlobCount = 0;
  for (const blob of manifest.blobs || []) {
    const absolutePath = path.resolve(restoreTarget, blob.relativePath || '');
    const relative = path.relative(restoreTarget, absolutePath);
    const stat = await fsPromises.lstat(absolutePath).catch(() => null);
    if (
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      !stat?.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== blob.size ||
      (await fileHash(absolutePath)) !== blob.hash
    ) {
      throw backupError('PRE_REPAIR_BACKUP_RESTORE_BLOB_MISMATCH');
    }
    verifiedBlobCount += 1;
  }
  if (verifiedBlobCount !== manifest.blobCount) {
    throw backupError('PRE_REPAIR_BACKUP_RESTORE_BLOB_MISMATCH');
  }

  // Migration recognition is proved only on the disposable restored database.
  // The live schema-7 database is never opened through ArchiveDatabase here.
  const migrationRecognitionPath = path.join(
    restoreTarget,
    'migration-recognition.sqlite3'
  );
  await fsPromises.copyFile(databasePath, migrationRecognitionPath);
  await fsPromises.chmod(migrationRecognitionPath, 0o600);
  const migratedRestore = new ArchiveDatabaseImpl(migrationRecognitionPath);
  let migratedSchemaVersion;
  try {
    migratedSchemaVersion = currentSchemaVersion(migratedRestore.db);
    if (
      migratedSchemaVersion !== 11 ||
      migratedRestore.db.pragma('integrity_check', { simple: true }) !== 'ok' ||
      migratedRestore.db.pragma('foreign_key_check').length !== 0
    ) {
      throw backupError(
        'PRE_REPAIR_BACKUP_RESTORE_MIGRATION_RECOGNITION_FAILED'
      );
    }
  } finally {
    migratedRestore.close();
  }
  return {
    snapshotId: expectedSnapshotId,
    databaseHashMatches: true,
    countsMatch: true,
    integrity: 'ok',
    foreignKeyProblems: 0,
    ftsConsistency: true,
    verifiedBlobCount,
    restoredSchemaVersion: REQUIRED_PRE_REPAIR_SCHEMA_VERSION,
    disposableMigrationRecognizedThrough: migratedSchemaVersion,
    retainedRestoreMatchesManifest:
      (await fileHash(databasePath)) === manifest.databaseSha256,
    databaseSha256: manifest.databaseSha256,
    blobInventorySha256: manifest.blobInventorySha256,
    blobCount: manifest.blobCount,
    ok: true,
  };
}

async function writePreRepairRestoreReceipt({
  receiptOutputPath,
  liveRoot,
  receipt,
} = {}) {
  const output = path.resolve(receiptOutputPath || '');
  const manifestsRoot = fs.realpathSync(path.join(liveRoot, 'manifests'));
  const canonicalOutput = path.join(manifestsRoot, path.basename(output));
  if (
    fs.realpathSync(path.dirname(output)) !== manifestsRoot ||
    !path.basename(output).startsWith('pre-repair-restore-') ||
    !output.endsWith('.json')
  ) {
    throw backupError('PRE_REPAIR_BACKUP_RECEIPT_PATH_UNSAFE');
  }
  let handle;
  let created = false;
  try {
    handle = await fsPromises.open(canonicalOutput, 'wx', 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.chmod(canonicalOutput, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error.code === 'EEXIST') {
      throw backupError(
        'PRE_REPAIR_BACKUP_RECEIPT_EXISTS',
        'refusing to overwrite existing restore evidence'
      );
    }
    if (created) {
      await fsPromises.rm(canonicalOutput, { force: true }).catch(() => {});
    }
    throw error;
  }
  return canonicalOutput;
}

async function createSchemaPreservingPreRepairBackup({
  config,
  liveArchiveRoot,
  requiredLiveArchiveRoot,
  restoreTarget,
  receiptOutputPath,
  confirmation,
  DatabaseImpl = SqliteDatabase,
  ArchiveDatabaseImpl = ArchiveDatabase,
  LockImpl = WorkerLock,
  BackupManagerImpl = BackupManager,
  schedulerInspector = inspectSchedulerDisabled,
  processInspector = inspectArchiveWorkerProcesses,
  backupManagerOptions = {},
} = {}) {
  if (confirmation !== PRE_REPAIR_BACKUP_CONFIRMATION) {
    throw backupError('PRE_REPAIR_BACKUP_CONFIRMATION_REQUIRED');
  }
  const paths = assertExplicitLiveRoot(liveArchiveRoot, config?.root, {
    requiredRoot: requiredLiveArchiveRoot,
  });
  const resolvedRestoreTarget =
    await assertNewEmptyRestoreTarget(restoreTarget);
  await assertLiveServiceQuiesced({
    liveRoot: paths.liveRoot,
    schedulerInspector,
    processInspector,
  });
  const lock = new LockImpl(paths.liveRoot);
  let database = null;
  await lock.acquire();
  try {
    const scheduler = await schedulerInspector();
    const processes = await processInspector();
    if (
      scheduler?.label !== ARCHIVE_LAUNCHD_LABEL ||
      scheduler?.loaded !== false ||
      scheduler?.persistentlyDisabled !== true ||
      processes?.running !== false ||
      processes?.matchingProcessCount !== 0
    ) {
      throw backupError('PRE_REPAIR_BACKUP_QUIESCENCE_CHANGED');
    }
    const beforeStat = await fsPromises.stat(paths.databasePath, {
      bigint: true,
    });
    const beforeHash = await fileHash(paths.databasePath);
    database = new DatabaseImpl(paths.databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    database.pragma('foreign_keys = ON');
    database.pragma('query_only = ON');
    if (
      currentSchemaVersion(database) !== REQUIRED_PRE_REPAIR_SCHEMA_VERSION ||
      database.pragma('integrity_check', { simple: true }) !== 'ok' ||
      database.pragma('foreign_key_check').length !== 0 ||
      !inspectFtsConsistency(database).summary.passed
    ) {
      throw backupError('PRE_REPAIR_BACKUP_SOURCE_INVALID');
    }
    const beforeCounts = sourceCounts(database);
    const manager = new BackupManagerImpl({
      config,
      database: rawBackupAdapter(database),
      ...backupManagerOptions,
    });
    let preflightPassword;
    try {
      preflightPassword = await manager.passwordProvider({ create: false });
      await manager.runner(manager.resticPath, ['cat', 'config'], {
        cwd: config.root,
        env: manager.resticEnvironment(preflightPassword),
      });
    } catch (error) {
      throw backupError(
        'PRE_REPAIR_BACKUP_REPOSITORY_UNVERIFIED',
        'the existing encrypted repository and Keychain password must be readable before any snapshot mutation',
        error
      );
    }
    const backup = await manager.backup();
    if (!backup.snapshotId) {
      throw backupError('PRE_REPAIR_BACKUP_SNAPSHOT_ID_MISSING');
    }
    const password = await manager.passwordProvider({ create: false });
    await manager.runner(
      manager.resticPath,
      ['restore', backup.snapshotId, '--target', resolvedRestoreTarget],
      {
        cwd: config.root,
        env: manager.resticEnvironment(password),
      }
    );
    const restore = await verifyExactPreRepairRestore({
      restoreTarget: resolvedRestoreTarget,
      expectedSnapshotId: backup.snapshotId,
      DatabaseImpl,
      ArchiveDatabaseImpl,
    });
    const afterCounts = sourceCounts(database);
    database.close();
    database = null;
    const afterHash = await fileHash(paths.databasePath);
    const afterStat = await fsPromises.stat(paths.databasePath, {
      bigint: true,
    });
    if (
      beforeHash !== afterHash ||
      beforeStat.dev !== afterStat.dev ||
      beforeStat.ino !== afterStat.ino ||
      beforeStat.size !== afterStat.size ||
      beforeStat.mtimeNs !== afterStat.mtimeNs ||
      JSON.stringify(beforeCounts) !== JSON.stringify(afterCounts)
    ) {
      throw backupError(
        'PRE_REPAIR_BACKUP_LIVE_SOURCE_CHANGED',
        'the live schema or content changed while creating the backup'
      );
    }
    const completedAt = new Date().toISOString();
    const receipt = {
      schemaVersion: 1,
      kind: PRE_REPAIR_RESTORE_RECEIPT_KIND,
      completedAt,
      snapshotIdDigest: crypto
        .createHash('sha256')
        .update(backup.snapshotId)
        .digest('hex'),
      databaseSha256: backup.manifest.databaseSha256,
      blobInventorySha256: backup.manifest.blobInventorySha256,
      blobCount: backup.manifest.blobCount,
      exactSnapshotRestored: true,
      retainedRestoreMatchesManifest:
        restore.retainedRestoreMatchesManifest === true,
      liveSchemaUnchanged: true,
      liveDatabaseHashUnchanged: true,
      fullBlobVerificationPassed:
        restore.verifiedBlobCount === backup.manifest.blobCount,
    };
    receipt.receiptDigest = receiptDigest(receipt);
    await writePreRepairRestoreReceipt({
      receiptOutputPath,
      liveRoot: paths.liveRoot,
      receipt,
    });
    return {
      code: 'PRE_REPAIR_BACKUP_AND_EXACT_RESTORE_VERIFIED',
      liveSchemaBefore: REQUIRED_PRE_REPAIR_SCHEMA_VERSION,
      liveSchemaAfter: REQUIRED_PRE_REPAIR_SCHEMA_VERSION,
      liveDatabaseHashUnchanged: true,
      liveDatabaseMtimeUnchanged: true,
      liveContentCountsUnchanged: true,
      snapshotId: backup.snapshotId,
      backupRepositoryVerified: true,
      exactSnapshotRestored: true,
      restoreReceiptWrittenOwnerOnly: true,
      restoreReceiptDigest: receipt.receiptDigest,
      restore,
      scheduler: 'persistently-disabled',
      automaticSchedulerResume: false,
      automaticReconciliation: false,
    };
  } finally {
    if (database) database.close();
    await lock.release();
  }
}

module.exports = {
  PRE_REPAIR_BACKUP_CONFIRMATION,
  PRE_REPAIR_RESTORE_RECEIPT_KIND,
  REQUIRED_PRE_REPAIR_SCHEMA_VERSION,
  assertNewEmptyRestoreTarget,
  createSchemaPreservingPreRepairBackup,
  rawBackupAdapter,
  sourceCounts,
  receiptDigest,
  verifyExactPreRepairRestore,
  writePreRepairRestoreReceipt,
};
