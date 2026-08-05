const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const SqliteDatabase = require('better-sqlite3');
const { DEFAULT_ARCHIVE_ROOT } = require('./config');
const { MIGRATIONS } = require('./migrations');
const { WorkerLock } = require('./lock');
const { buildIdentityStatus } = require('./identity-status');
const { GmailArchiveProvider } = require('./providers/gmail');
const { OutlookArchiveProvider } = require('./providers/outlook');
const {
  DEFAULT_CONTAMINATION_WINDOW,
  collectGmailInventories,
  ftsAccountConsistency,
  rawMessageLoader,
  verifyCloneBlobManifest,
} = require('./rehearse-gmail-partition-repair');
const { proveGmailAnchorBindings } = require('./seed-archive-identities');
const { fileHash } = require('./backup');
const {
  GMAIL_PARTITION_REPAIR_CONFIRMATION,
  GMAIL_PARTITION_REPAIR_ID,
  OWNER_APPROVAL_OPERATION,
  OWNER_APPROVAL_SCHEMA_VERSION,
  buildGmailPartitionRepairPlan,
  partitionRepairPlanDigest,
  partitionRepairPreconditionDigest,
  repairGmailPartitions,
  validateOwnerApprovalMetadata,
} = require('./repair-gmail-partitions');

const ARCHIVE_LAUNCHD_LABEL = 'com.davidbasseal.email-assistant-archive';
const LIVE_REPAIR_CONFIRMATION =
  'APPLY_TO_LIVE_EMAIL_ARCHIVE_AND_KEEP_SCHEDULER_DISABLED';
const OWNER_APPROVAL_CONFIRMATION =
  'APPROVE_REVIEWED_LIVE_GMAIL_PARTITION_REPAIR_PLAN';
const LIVE_PLAN_SCHEMA_VERSION = 1;
const LIVE_PLAN_KIND = 'gmail-partition-live-repair-plan';
const MINIMUM_SUPPORTED_SCHEMA_VERSION = 7;
const TARGET_REPAIR_SCHEMA_VERSION = 11;
const DEFAULT_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PRE_REPAIR_RESTORE_RECEIPT_KIND =
  'email-assistant-pre-repair-restore-receipt';

function liveRepairError(code, message = null, cause = null) {
  const error = new Error(message ? `${code}: ${message}` : code, {
    cause: cause || undefined,
  });
  error.code = code;
  return error;
}

function sha256Json(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function assertRegularOwnerOnlyFile(filePath, code) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw liveRepairError(
      code,
      'required private evidence file is unavailable',
      error
    );
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600
  ) {
    throw liveRepairError(
      code,
      'private evidence must be one regular, non-hard-linked file at mode 0600'
    );
  }
  return stat;
}

async function readPrivateJson(filePath, code) {
  const resolved = path.resolve(filePath || '');
  assertRegularOwnerOnlyFile(resolved, code);
  try {
    return JSON.parse(await fsPromises.readFile(resolved, 'utf8'));
  } catch (error) {
    throw liveRepairError(code, 'private evidence JSON is invalid', error);
  }
}

async function writePrivateJsonExclusive(
  filePath,
  value,
  { forbiddenRoots = [] } = {}
) {
  const resolved = path.resolve(filePath || '');
  const parent = fs.realpathSync(path.dirname(resolved));
  const canonicalOutput = path.join(parent, path.basename(resolved));
  if (
    forbiddenRoots.some((root) =>
      isPathInside(fs.realpathSync(root), canonicalOutput)
    )
  ) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_PLAN_PATH_UNSAFE',
      'the private plan must be outside the archive and repository trees'
    );
  }
  let handle;
  let created = false;
  try {
    handle = await fsPromises.open(canonicalOutput, 'wx', 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.chmod(canonicalOutput, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) {
      await fsPromises.rm(canonicalOutput, { force: true }).catch(() => {});
    }
    if (error.code === 'EEXIST') {
      throw liveRepairError(
        'GMAIL_LIVE_REPAIR_PLAN_EXISTS',
        'refusing to overwrite an existing private plan'
      );
    }
    throw error;
  }
  assertRegularOwnerOnlyFile(
    canonicalOutput,
    'GMAIL_LIVE_REPAIR_PLAN_FILE_UNSAFE'
  );
  return canonicalOutput;
}

function assertExplicitLiveRoot(
  requestedRoot,
  configuredRoot,
  { requiredRoot = DEFAULT_ARCHIVE_ROOT } = {}
) {
  if (!requestedRoot || !configuredRoot || !requiredRoot) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_ROOT_REQUIRED',
      'the live archive root must be supplied explicitly'
    );
  }
  const candidates = [requestedRoot, configuredRoot, requiredRoot].map((root) =>
    path.resolve(root)
  );
  for (const root of candidates) {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw liveRepairError(
        'GMAIL_LIVE_REPAIR_ROOT_AMBIGUOUS',
        'the live archive root must be one real directory, not a symlink'
      );
    }
  }
  const resolved = candidates.map((root) => fs.realpathSync(root));
  if (new Set(resolved).size !== 1) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_ROOT_AMBIGUOUS',
      'the explicit, configured, and product live roots do not agree'
    );
  }
  const liveRoot = resolved[0];
  const databasePath = path.join(liveRoot, 'archive.sqlite3');
  const database = fs.lstatSync(databasePath);
  if (database.isSymbolicLink() || !database.isFile() || database.nlink !== 1) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_DATABASE_AMBIGUOUS',
      'the live database must be one regular, non-hard-linked file'
    );
  }
  for (const directoryName of ['raw-messages', 'attachments']) {
    const directory = fs.lstatSync(path.join(liveRoot, directoryName));
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      throw liveRepairError(
        'GMAIL_LIVE_REPAIR_CONTENT_ROOT_AMBIGUOUS',
        'the live content directories must be real directories inside the archive root'
      );
    }
  }
  return { liveRoot, databasePath };
}

function runLaunchctl(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/launchctl', args, { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-100_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-10_000);
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runProcessCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-1_000_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-10_000);
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function inspectSchedulerDisabled({
  runner = runLaunchctl,
  uid = process.getuid(),
  label = ARCHIVE_LAUNCHD_LABEL,
} = {}) {
  const domain = `gui/${uid}`;
  let service;
  let disabled;
  try {
    service = await runner(['print', `${domain}/${label}`]);
    disabled = await runner(['print-disabled', domain]);
  } catch (error) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_SCHEDULER_AMBIGUOUS',
      'launchd state could not be proved',
      error
    );
  }
  if (service?.code === 0) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_SCHEDULER_ACTIVE',
      `the exact ${label} service is still loaded`
    );
  }
  if (service?.code !== 113) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_SCHEDULER_AMBIGUOUS',
      `launchctl did not return the known absent-service status for ${label}`
    );
  }
  // launchctl uses both `true` and `disabled` for the persisted disabled
  // state across supported macOS releases. Accept only those exact values;
  // `false`, `enabled`, a missing label, or an unreadable domain stay closed.
  const disabledPattern = new RegExp(
    `["']?${escapeRegex(label)}["']?\\s*=>\\s*(?:true|disabled)(?:\\s|$)`
  );
  if (disabled?.code !== 0 || !disabledPattern.test(disabled.stdout || '')) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_SCHEDULER_AMBIGUOUS',
      `the exact ${label} service is not proved persistently disabled`
    );
  }
  return { label, loaded: false, persistentlyDisabled: true };
}

async function inspectArchiveWorkerProcesses({
  repositoryRoot = path.resolve(__dirname, '..'),
  runner = runProcessCapture,
  currentPid = process.pid,
} = {}) {
  const resolvedRepository = fs.realpathSync(repositoryRoot);
  let processes;
  try {
    processes = await runner('/bin/ps', ['-axo', 'pid=,command=']);
  } catch (error) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_PROCESS_STATE_AMBIGUOUS',
      'the local process list could not be inspected',
      error
    );
  }
  if (processes?.code !== 0) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_PROCESS_STATE_AMBIGUOUS',
      'the local process list could not be proved'
    );
  }
  const absoluteScripts = [
    path.join(resolvedRepository, 'archive-worker', 'scheduled.js'),
    path.join(resolvedRepository, 'archive-worker', 'index.js'),
  ];
  let matches = 0;
  for (const line of String(processes.stdout || '').split('\n')) {
    const parsed = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!parsed) continue;
    const pid = Number(parsed[1]);
    const command = parsed[2];
    if (pid === currentPid) continue;
    if (absoluteScripts.some((script) => command.includes(script))) {
      matches += 1;
      continue;
    }
    const archiveWorkerCommand =
      /(?:^|[\s/])archive-worker\/(?:scheduled|index)\.js(?:\s|$)/.test(
        command
      );
    if (!archiveWorkerCommand) continue;
    let cwd;
    try {
      cwd = await runner('/usr/sbin/lsof', [
        '-a',
        '-p',
        String(pid),
        '-d',
        'cwd',
        '-Fn',
      ]);
    } catch (error) {
      throw liveRepairError(
        'GMAIL_LIVE_REPAIR_PROCESS_STATE_AMBIGUOUS',
        'a possible relative archive worker could not be scoped to a working directory',
        error
      );
    }
    const cwdPath = String(cwd?.stdout || '')
      .split('\n')
      .find((entry) => entry.startsWith('n'))
      ?.slice(1);
    if (cwd?.code !== 0 || !cwdPath) {
      throw liveRepairError(
        'GMAIL_LIVE_REPAIR_PROCESS_STATE_AMBIGUOUS',
        'a possible relative archive worker could not be scoped to a working directory'
      );
    }
    if (fs.realpathSync(cwdPath) === resolvedRepository) matches += 1;
  }
  if (matches > 0) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_WORKER_PROCESS_ACTIVE',
      'an archive worker process from this repository is still running'
    );
  }
  return { running: false, matchingProcessCount: 0 };
}

async function assertNoWorkerLock(liveRoot) {
  const lockPath = path.join(liveRoot, 'worker.lock');
  try {
    await fsPromises.lstat(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { lockPresent: false };
    throw error;
  }
  throw liveRepairError(
    'GMAIL_LIVE_REPAIR_WORKER_LOCK_PRESENT',
    'a worker lock exists; this workflow never removes or guesses about it'
  );
}

async function assertLiveServiceQuiesced({
  liveRoot,
  schedulerInspector = inspectSchedulerDisabled,
  processInspector = inspectArchiveWorkerProcesses,
} = {}) {
  const scheduler = await schedulerInspector();
  if (
    scheduler?.label !== ARCHIVE_LAUNCHD_LABEL ||
    scheduler?.loaded !== false ||
    scheduler?.persistentlyDisabled !== true
  ) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_SCHEDULER_AMBIGUOUS',
      'the exact archive scheduler is not proved disabled and absent'
    );
  }
  const processes = await processInspector();
  if (processes?.running !== false || processes?.matchingProcessCount !== 0) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_PROCESS_STATE_AMBIGUOUS',
      'archive worker process absence is not proved'
    );
  }
  const worker = await assertNoWorkerLock(liveRoot);
  return { scheduler, processes, worker };
}

function assertOwnedWorkerLock(liveRoot) {
  const lockPath = path.join(liveRoot, 'worker.lock');
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (error) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_LOCK_OWNERSHIP_UNPROVED',
      'the apply lock cannot be read safely',
      error
    );
  }
  if (Number(owner?.pid) !== process.pid) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_LOCK_OWNERSHIP_UNPROVED',
      'the apply lock is not owned by this process'
    );
  }
}

function openReadOnlyDatabase(DatabaseImpl, databasePath) {
  const database = new DatabaseImpl(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('query_only = ON');
  return database;
}

function currentSchemaVersion(database) {
  const table = database
    .prepare(
      `SELECT 1 FROM sqlite_schema
       WHERE type = 'table' AND name = 'schema_migrations'`
    )
    .get();
  if (!table) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_SCHEMA_UNSUPPORTED',
      'schema migration history is missing'
    );
  }
  const applied = database
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
    .all();
  const latest = applied.at(-1)?.version || 0;
  if (
    latest < MINIMUM_SUPPORTED_SCHEMA_VERSION ||
    latest > TARGET_REPAIR_SCHEMA_VERSION ||
    applied.length !== latest ||
    applied.some((row, index) => {
      const migration = MIGRATIONS.find(
        (candidate) => candidate.version === index + 1
      );
      return row.version !== index + 1 || row.name !== migration?.name;
    })
  ) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_SCHEMA_UNSUPPORTED',
      `expected an exact forward migration history from 1 through ${TARGET_REPAIR_SCHEMA_VERSION}`
    );
  }
  return latest;
}

function applyPendingRepairMigrations(database) {
  const before = currentSchemaVersion(database);
  const applied = [];
  for (const migration of MIGRATIONS) {
    if (
      migration.version <= before ||
      migration.version > TARGET_REPAIR_SCHEMA_VERSION
    ) {
      continue;
    }
    database.exec(migration.sql);
    database
      .prepare(
        `INSERT INTO schema_migrations(version, name, applied_at)
         VALUES (?, ?, ?)`
      )
      .run(migration.version, migration.name, new Date().toISOString());
    applied.push(migration.version);
  }
  if (currentSchemaVersion(database) !== TARGET_REPAIR_SCHEMA_VERSION) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_SCHEMA_MIGRATION_FAILED',
      `schema did not reach version ${TARGET_REPAIR_SCHEMA_VERSION}`
    );
  }
  return { before, after: TARGET_REPAIR_SCHEMA_VERSION, applied };
}

async function readVerifiedDatabaseManifest(
  databasePath,
  manifestPath,
  { codePrefix, requireBlobManifest = false } = {}
) {
  const resolvedDatabase = path.resolve(databasePath || '');
  const resolvedManifest = path.resolve(manifestPath || '');
  for (const [filePath, suffix] of [
    [resolvedDatabase, 'DATABASE_UNSAFE'],
    [resolvedManifest, 'MANIFEST_UNSAFE'],
  ]) {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw liveRepairError(`${codePrefix}_${suffix}`);
    }
  }
  const wal = await fsPromises
    .stat(`${resolvedDatabase}-wal`)
    .catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  if (wal?.size > 0) {
    throw liveRepairError(`${codePrefix}_DATABASE_UNSTABLE`);
  }
  let manifest;
  try {
    manifest = JSON.parse(await fsPromises.readFile(resolvedManifest, 'utf8'));
  } catch (error) {
    throw liveRepairError(`${codePrefix}_MANIFEST_INVALID`, null, error);
  }
  if (
    manifest?.formatVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(String(manifest.databaseSha256 || '')) ||
    (requireBlobManifest &&
      (!Array.isArray(manifest.blobs) ||
        !/^[a-f0-9]{64}$/.test(String(manifest.blobInventorySha256 || ''))))
  ) {
    throw liveRepairError(`${codePrefix}_MANIFEST_INVALID`);
  }
  const before = await fsPromises.stat(resolvedDatabase, { bigint: true });
  const databaseSha256 = await fileHash(resolvedDatabase);
  const after = await fsPromises.stat(resolvedDatabase, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs
  ) {
    throw liveRepairError(`${codePrefix}_DATABASE_UNSTABLE`);
  }
  if (databaseSha256 !== manifest.databaseSha256) {
    throw liveRepairError(`${codePrefix}_DATABASE_HASH_MISMATCH`);
  }
  return {
    databasePath: fs.realpathSync(resolvedDatabase),
    manifestPath: fs.realpathSync(resolvedManifest),
    manifest,
  };
}

async function verifyCompletedBackupEvidence({
  liveRoot,
  snapshot,
  markerPath,
  now = Date.now(),
  maxAgeMs = DEFAULT_EVIDENCE_MAX_AGE_MS,
} = {}) {
  const expectedSnapshotRoot = path.join(liveRoot, 'snapshots', 'current');
  if (
    path.dirname(snapshot.databasePath) !==
      fs.realpathSync(expectedSnapshotRoot) ||
    path.dirname(snapshot.manifestPath) !==
      fs.realpathSync(expectedSnapshotRoot)
  ) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_BACKUP_AMBIGUOUS',
      'the source snapshot must be the verified current snapshot under the live archive root'
    );
  }
  const resolvedMarker = path.resolve(markerPath || '');
  if (resolvedMarker !== path.join(liveRoot, 'manifests', 'last-backup.json')) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_BACKUP_AMBIGUOUS',
      'the completed-backup marker path does not match the live archive'
    );
  }
  const marker = await readPrivateJson(
    resolvedMarker,
    'GMAIL_LIVE_REPAIR_BACKUP_MARKER_INVALID'
  );
  const createdAt = new Date(snapshot.manifest.createdAt || '').getTime();
  const completedAt = new Date(marker.completedAt || '').getTime();
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(completedAt) ||
    completedAt < createdAt ||
    completedAt > now + 30_000 ||
    now - completedAt > maxAgeMs ||
    typeof marker.snapshotId !== 'string' ||
    marker.snapshotId.length < 8 ||
    JSON.stringify(marker.tableCounts) !==
      JSON.stringify(snapshot.manifest.tableCounts) ||
    marker.blobCount !== snapshot.manifest.blobCount
  ) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_BACKUP_EVIDENCE_INVALID',
      'the current snapshot is not tied to a fresh completed encrypted backup'
    );
  }
  return {
    completedAt: new Date(completedAt).toISOString(),
    snapshotIdDigest: sha256Text(marker.snapshotId),
    databaseSha256: snapshot.manifest.databaseSha256,
    blobInventorySha256: snapshot.manifest.blobInventorySha256,
    blobCount: snapshot.manifest.blobCount,
  };
}

async function verifyPreRepairRestoreReceipt({
  receiptPath,
  liveRoot,
  backupEvidence,
  now = Date.now(),
  maxAgeMs = DEFAULT_EVIDENCE_MAX_AGE_MS,
} = {}) {
  const resolved = path.resolve(receiptPath || '');
  const manifestsRoot = fs.realpathSync(path.join(liveRoot, 'manifests'));
  if (
    fs.realpathSync(path.dirname(resolved)) !== manifestsRoot ||
    !path.basename(resolved).startsWith('pre-repair-restore-')
  ) {
    throw liveRepairError('GMAIL_LIVE_REPAIR_RESTORE_RECEIPT_UNSAFE');
  }
  const receipt = await readPrivateJson(
    resolved,
    'GMAIL_LIVE_REPAIR_RESTORE_RECEIPT_UNSAFE'
  );
  const { receiptDigest, ...unsigned } = receipt;
  const completedAt = new Date(receipt.completedAt || '').getTime();
  const backupCompletedAt = new Date(backupEvidence.completedAt).getTime();
  if (
    receipt?.schemaVersion !== 1 ||
    receipt?.kind !== PRE_REPAIR_RESTORE_RECEIPT_KIND ||
    receiptDigest !== sha256Json(unsigned) ||
    receipt.snapshotIdDigest !== backupEvidence.snapshotIdDigest ||
    receipt.databaseSha256 !== backupEvidence.databaseSha256 ||
    receipt.blobInventorySha256 !== backupEvidence.blobInventorySha256 ||
    receipt.blobCount !== backupEvidence.blobCount ||
    receipt.exactSnapshotRestored !== true ||
    receipt.retainedRestoreMatchesManifest !== true ||
    receipt.liveSchemaUnchanged !== true ||
    receipt.liveDatabaseHashUnchanged !== true ||
    receipt.fullBlobVerificationPassed !== true ||
    !Number.isFinite(completedAt) ||
    completedAt < backupCompletedAt ||
    completedAt > now + 30_000 ||
    now - completedAt > maxAgeMs
  ) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_RESTORE_RECEIPT_INVALID',
      'the exact pre-repair backup restore was not proved against current backup evidence'
    );
  }
  return { receiptDigest, completedAt: new Date(completedAt).toISOString() };
}

function assertDatabaseHealthy(database, code) {
  if (
    database.pragma('integrity_check', { simple: true }) !== 'ok' ||
    database.pragma('foreign_key_check').length > 0
  ) {
    throw liveRepairError(
      code,
      'SQLite integrity or foreign-key verification failed'
    );
  }
  const fts = ftsAccountConsistency(database);
  if (!fts.passed) {
    throw liveRepairError(code, 'message and FTS ownership do not agree');
  }
  return fts;
}

function expectedGmailIdentities(config) {
  const entries = config.accounts
    .filter((account) => account.provider === 'gmail')
    .map((account) => [account.id, account.expectedIdentity]);
  const identities = Object.fromEntries(entries);
  if (
    !identities['gmail-ablative'] ||
    !identities['gmail-personal'] ||
    identities['gmail-ablative'] === identities['gmail-personal']
  ) {
    throw liveRepairError('GMAIL_LIVE_REPAIR_IDENTITY_CONFIG_INVALID');
  }
  return identities;
}

function assertExplicitIdentityConfiguration(config) {
  const accounts = (config?.accounts || []).filter((account) =>
    ['gmail', 'outlook'].includes(account.provider)
  );
  const expectedIds = new Set([
    'vitasci-outlook',
    'gmail-ablative',
    'gmail-personal',
  ]);
  const identities = accounts.map((account) => account.expectedIdentity);
  if (
    accounts.length !== 3 ||
    new Set(accounts.map((account) => account.id)).size !== 3 ||
    accounts.some(
      (account) =>
        !expectedIds.has(account.id) ||
        !account.expectedIdentity ||
        account.identityConfigurationError
    ) ||
    new Set(identities).size !== identities.length
  ) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_IDENTITY_CONFIG_INVALID',
      'all three distinct explicit archive expected-identity keys are mandatory'
    );
  }
  return true;
}

function identityProof(gmailStatuses, identityStatus) {
  const outlook = identityStatus.accounts.find(
    (account) => account.logicalAccountId === 'vitasci-outlook'
  );
  const accounts = [...gmailStatuses, outlook]
    .filter(Boolean)
    .map((status) => ({
      logicalAccountId: status.logicalAccountId,
      credentialSlot: status.credentialSlot,
      expectedIdentityConfigured: status.expectedIdentityConfigured === true,
      identityMatch: status.identityMatch === true,
      verifiedAt: status.verifiedAt,
      errorCode: status.errorCode || null,
    }));
  return {
    passed:
      identityStatus.passed === true &&
      accounts.length === 3 &&
      accounts.every(
        (account) =>
          account.expectedIdentityConfigured &&
          account.identityMatch &&
          !account.errorCode
      ),
    accounts,
  };
}

async function collectFreshLiveEvidence({
  config,
  env,
  identityStatusBuilder = buildIdentityStatus,
  gmailProviderFactory = null,
  identityProviderFactory = null,
  onProgress = null,
} = {}) {
  const safeProviderFactory =
    identityProviderFactory ||
    ((account) =>
      account.provider === 'gmail'
        ? new GmailArchiveProvider({
            account,
            env,
            persistTokenRefresh: false,
          })
        : new OutlookArchiveProvider({
            account,
            persistTokenRefresh: false,
          }));
  const status = await identityStatusBuilder({
    config,
    env,
    providerFactory: safeProviderFactory,
  });
  if (!status.passed) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_IDENTITY_UNPROVED',
      'all three privacy-safe provider identity checks must pass'
    );
  }
  const gmailAccounts = config.accounts.filter(
    (account) => account.provider === 'gmail'
  );
  const collection = await collectGmailInventories({
    accounts: gmailAccounts,
    env,
    providerFactory:
      gmailProviderFactory ||
      ((account) =>
        new GmailArchiveProvider({
          account,
          env,
          persistTokenRefresh: false,
        })),
    onProgress,
  });
  const proof = identityProof(collection.statuses, status);
  if (!proof.passed) {
    throw liveRepairError('GMAIL_LIVE_REPAIR_IDENTITY_UNPROVED');
  }
  return { identityProof: proof, inventories: collection.inventories };
}

function livePlanEnvelopeDigest(envelope) {
  const { envelopeDigest: _ignored, ...unsigned } = envelope || {};
  return sha256Json(unsigned);
}

function validateLivePlanFileIntegrity(envelope) {
  const planDigest = partitionRepairPlanDigest(envelope?.repairPlan);
  if (
    envelope?.schemaVersion !== LIVE_PLAN_SCHEMA_VERSION ||
    envelope?.kind !== LIVE_PLAN_KIND ||
    envelope?.migrationId !== GMAIL_PARTITION_REPAIR_ID ||
    envelope?.repairPlan?.ownerApprovalRecorded !== false ||
    envelope?.sourceSchemaVersion < MINIMUM_SUPPORTED_SCHEMA_VERSION ||
    envelope?.sourceSchemaVersion > TARGET_REPAIR_SCHEMA_VERSION ||
    envelope?.targetSchemaVersion !== TARGET_REPAIR_SCHEMA_VERSION ||
    envelope?.planDigest !== planDigest ||
    !/^[a-f0-9]{64}$/.test(String(envelope?.preconditionDigest || '')) ||
    !/^[a-f0-9]{64}$/.test(String(envelope?.liveRootDigest || '')) ||
    !/^[a-f0-9]{64}$/.test(
      String(envelope?.preRepairRestoreReceipt?.receiptDigest || '')
    ) ||
    envelope?.envelopeDigest !== livePlanEnvelopeDigest(envelope)
  ) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_PLAN_INVALID',
      'the private plan envelope or immutable digest is invalid'
    );
  }
  return envelope;
}

function validateLivePlanEnvelope(
  envelope,
  { liveRoot, backupEvidence, anchorDatabaseSha256, restoreReceiptDigest } = {}
) {
  validateLivePlanFileIntegrity(envelope);
  if (
    envelope?.liveRootDigest !== sha256Text(liveRoot) ||
    envelope?.sourceBackup?.databaseSha256 !== backupEvidence.databaseSha256 ||
    envelope?.sourceBackup?.blobInventorySha256 !==
      backupEvidence.blobInventorySha256 ||
    envelope?.sourceBackup?.snapshotIdDigest !==
      backupEvidence.snapshotIdDigest ||
    envelope?.sourceBackup?.completedAt !== backupEvidence.completedAt ||
    envelope?.preRepairRestoreReceipt?.receiptDigest !== restoreReceiptDigest ||
    envelope?.anchorDatabaseSha256 !== anchorDatabaseSha256
  ) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_PLAN_INVALID',
      'the private plan, digest, live root, backup, or anchor evidence disagrees'
    );
  }
  return envelope;
}

async function readVerifiedCloneRepairReceipt(
  cloneDatabasePath,
  { DatabaseImpl = SqliteDatabase } = {}
) {
  const resolved = fs.realpathSync(path.resolve(cloneDatabasePath || ''));
  const temporary =
    resolved.startsWith('/private/tmp/') || resolved.startsWith('/tmp/');
  const stat = fs.lstatSync(resolved);
  if (
    !temporary ||
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0
  ) {
    throw liveRepairError('GMAIL_LIVE_REPAIR_CLONE_RECEIPT_UNSAFE');
  }
  const wal = await fsPromises.stat(`${resolved}-wal`).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (wal?.size > 0) {
    throw liveRepairError('GMAIL_LIVE_REPAIR_CLONE_RECEIPT_UNSAFE');
  }
  const database = openReadOnlyDatabase(DatabaseImpl, resolved);
  try {
    if (currentSchemaVersion(database) !== TARGET_REPAIR_SCHEMA_VERSION) {
      throw liveRepairError('GMAIL_LIVE_REPAIR_CLONE_RECEIPT_INVALID');
    }
    const noOp = repairGmailPartitions(database);
    const receipt = database
      .prepare(
        `SELECT plan_digest, precondition_digest,
                post_state_digest, details_json
         FROM identity_partition_repair_receipts
         WHERE migration_id = ?`
      )
      .get(GMAIL_PARTITION_REPAIR_ID);
    let details;
    try {
      details = JSON.parse(receipt?.details_json || '');
    } catch {
      throw liveRepairError('GMAIL_LIVE_REPAIR_CLONE_RECEIPT_INVALID');
    }
    if (
      noOp.status !== 'already_applied' ||
      noOp.applied !== false ||
      details?.mode !== 'rehearsal' ||
      receipt?.post_state_digest !== noOp.postStateDigest
    ) {
      throw liveRepairError('GMAIL_LIVE_REPAIR_CLONE_RECEIPT_INVALID');
    }
    return {
      code: 'GMAIL_REHEARSAL_APPLIED_AND_VERIFIED',
      appliedToClone: true,
      secondInvocationNoOp: true,
      planDigest: receipt.plan_digest,
      preconditionDigest: receipt.precondition_digest,
      postStateDigest: noOp.postStateDigest,
    };
  } finally {
    database.close();
  }
}

async function createLiveRepairOwnerApproval({
  planInputPath,
  cloneDatabasePath,
  approvalOutputPath,
  approvedPlanDigest,
  confirmation,
  approvalId = null,
  liveArchiveRoot,
  repositoryRoot = path.resolve(__dirname, '..'),
  cloneReceiptReader = readVerifiedCloneRepairReceipt,
  nowFn = Date.now,
} = {}) {
  if (confirmation !== OWNER_APPROVAL_CONFIRMATION) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_OWNER_APPROVAL_CONFIRMATION_REQUIRED'
    );
  }
  const envelope = validateLivePlanFileIntegrity(
    await readPrivateJson(planInputPath, 'GMAIL_LIVE_REPAIR_PLAN_FILE_UNSAFE')
  );
  if (approvedPlanDigest !== envelope.planDigest) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_OWNER_APPROVAL_DIGEST_MISMATCH',
      'the explicitly approved digest does not match the immutable private plan'
    );
  }
  const cloneRehearsal = await cloneReceiptReader(cloneDatabasePath);
  if (
    cloneRehearsal?.planDigest !== envelope.planDigest ||
    cloneRehearsal?.preconditionDigest !== envelope.preconditionDigest
  ) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_CLONE_PLAN_DIGEST_MISMATCH',
      'the clone did not rehearse the exact immutable live plan and precondition'
    );
  }
  const approvedAt = new Date(nowFn()).toISOString();
  const safeApprovalId =
    approvalId || `owner-approval:${approvedAt.replaceAll(/[^0-9TZ]/g, '')}`;
  const approval = {
    schemaVersion: OWNER_APPROVAL_SCHEMA_VERSION,
    operation: OWNER_APPROVAL_OPERATION,
    migrationId: GMAIL_PARTITION_REPAIR_ID,
    approved: true,
    approvalRole: 'archive-owner',
    approvalId: safeApprovalId,
    approvedAt,
    planDigest: envelope.planDigest,
    preconditionDigest: envelope.preconditionDigest,
    cloneRehearsal,
  };
  validateOwnerApprovalMetadata(approval, {
    plan: envelope.repairPlan,
    planDigest: envelope.planDigest,
    preconditionDigest: envelope.preconditionDigest,
    now: nowFn(),
  });
  await writePrivateJsonExclusive(approvalOutputPath, approval, {
    forbiddenRoots: [
      fs.realpathSync(liveArchiveRoot),
      fs.realpathSync(repositoryRoot),
    ],
  });
  return {
    code: 'GMAIL_LIVE_REPAIR_OWNER_APPROVAL_RECORDED',
    approved: true,
    approvalWrittenOwnerOnly: true,
    planDigest: envelope.planDigest,
    preconditionDigest: envelope.preconditionDigest,
    cloneRehearsalVerified: true,
    archiveDatabaseWritten: false,
    mailboxWritten: false,
  };
}

function safeProgress(onProgress, phase, details = {}) {
  if (typeof onProgress === 'function') onProgress({ phase, ...details });
}

async function prepareReadOnlyEvidence({
  config,
  paths,
  anchorDatabasePath,
  anchorManifestPath,
  snapshotDatabasePath,
  snapshotManifestPath,
  backupMarkerPath,
  preRepairRestoreReceiptPath,
  DatabaseImpl,
  nowFn = Date.now,
  maxEvidenceAgeMs,
  onProgress,
} = {}) {
  assertExplicitIdentityConfiguration(config);
  safeProgress(onProgress, 'database_evidence_started');
  const snapshot = await readVerifiedDatabaseManifest(
    snapshotDatabasePath,
    snapshotManifestPath,
    {
      codePrefix: 'GMAIL_LIVE_REPAIR_SOURCE_SNAPSHOT',
      requireBlobManifest: true,
    }
  );
  const anchor = await readVerifiedDatabaseManifest(
    anchorDatabasePath,
    anchorManifestPath,
    { codePrefix: 'GMAIL_LIVE_REPAIR_ANCHOR' }
  );
  const backupEvidence = await verifyCompletedBackupEvidence({
    liveRoot: paths.liveRoot,
    snapshot,
    markerPath: backupMarkerPath,
    now: nowFn(),
    maxAgeMs: maxEvidenceAgeMs,
  });
  const restoreReceipt = await verifyPreRepairRestoreReceipt({
    receiptPath: preRepairRestoreReceiptPath,
    liveRoot: paths.liveRoot,
    backupEvidence,
    now: nowFn(),
    maxAgeMs: maxEvidenceAgeMs,
  });
  const database = openReadOnlyDatabase(DatabaseImpl, paths.databasePath);
  const snapshotDatabase = openReadOnlyDatabase(
    DatabaseImpl,
    snapshot.databasePath
  );
  const anchorDatabase = openReadOnlyDatabase(
    DatabaseImpl,
    anchor.databasePath
  );
  try {
    const schemaVersion = currentSchemaVersion(database);
    if (currentSchemaVersion(snapshotDatabase) !== schemaVersion) {
      throw liveRepairError(
        'GMAIL_LIVE_REPAIR_SOURCE_SNAPSHOT_MISMATCH',
        'the live database and completed-backup snapshot have different schema histories'
      );
    }
    assertDatabaseHealthy(database, 'GMAIL_LIVE_REPAIR_DATABASE_INVALID');
    assertDatabaseHealthy(
      snapshotDatabase,
      'GMAIL_LIVE_REPAIR_SOURCE_SNAPSHOT_INVALID'
    );
    if (
      anchorDatabase.pragma('integrity_check', { simple: true }) !== 'ok' ||
      anchorDatabase.pragma('foreign_key_check').length > 0
    ) {
      throw liveRepairError('GMAIL_LIVE_REPAIR_ANCHOR_INVALID');
    }
    const expected = expectedGmailIdentities(config);
    proveGmailAnchorBindings(anchorDatabase, {
      logicalAblative: expected['gmail-ablative'],
      logicalPersonal: expected['gmail-personal'],
    });
    const blobVerification = await verifyCloneBlobManifest(
      database,
      paths.liveRoot,
      snapshot.manifest,
      { onProgress }
    );
    safeProgress(onProgress, 'database_evidence_completed', {
      schemaVersion,
      verifiedBlobCount: blobVerification.verifiedBlobCount,
    });
    return {
      database,
      snapshotDatabase,
      anchorDatabase,
      schemaVersion,
      snapshot,
      anchor,
      backupEvidence,
      restoreReceipt,
      blobVerification,
      expectedIdentities: expected,
    };
  } catch (error) {
    database.close();
    snapshotDatabase.close();
    anchorDatabase.close();
    throw error;
  }
}

async function preflightLivePlanEvidence({
  envelope,
  paths,
  anchorDatabasePath,
  anchorManifestPath,
  snapshotDatabasePath,
  snapshotManifestPath,
  backupMarkerPath,
  preRepairRestoreReceiptPath,
  nowFn = Date.now,
  maxEvidenceAgeMs = DEFAULT_EVIDENCE_MAX_AGE_MS,
} = {}) {
  const snapshot = await readVerifiedDatabaseManifest(
    snapshotDatabasePath,
    snapshotManifestPath,
    {
      codePrefix: 'GMAIL_LIVE_REPAIR_SOURCE_SNAPSHOT',
      requireBlobManifest: true,
    }
  );
  const anchor = await readVerifiedDatabaseManifest(
    anchorDatabasePath,
    anchorManifestPath,
    { codePrefix: 'GMAIL_LIVE_REPAIR_ANCHOR' }
  );
  const backupEvidence = await verifyCompletedBackupEvidence({
    liveRoot: paths.liveRoot,
    snapshot,
    markerPath: backupMarkerPath,
    now: nowFn(),
    maxAgeMs: maxEvidenceAgeMs,
  });
  const restoreReceipt = await verifyPreRepairRestoreReceipt({
    receiptPath: preRepairRestoreReceiptPath,
    liveRoot: paths.liveRoot,
    backupEvidence,
    now: nowFn(),
    maxAgeMs: maxEvidenceAgeMs,
  });
  validateLivePlanEnvelope(envelope, {
    liveRoot: paths.liveRoot,
    backupEvidence,
    anchorDatabaseSha256: anchor.manifest.databaseSha256,
    restoreReceiptDigest: restoreReceipt.receiptDigest,
  });
  return { snapshot, anchor, backupEvidence, restoreReceipt };
}

function closeReadOnlyEvidence(evidence) {
  evidence?.database?.close();
  evidence?.snapshotDatabase?.close();
  evidence?.anchorDatabase?.close();
}

async function buildLiveGmailPartitionRepairPlan({
  config,
  env = process.env,
  liveArchiveRoot,
  requiredLiveArchiveRoot = DEFAULT_ARCHIVE_ROOT,
  repositoryRoot = path.resolve(__dirname, '..'),
  planOutputPath,
  anchorDatabasePath,
  anchorManifestPath,
  snapshotDatabasePath,
  snapshotManifestPath,
  backupMarkerPath,
  preRepairRestoreReceiptPath,
  contaminationWindow,
  DatabaseImpl = SqliteDatabase,
  schedulerInspector = inspectSchedulerDisabled,
  processInspector = inspectArchiveWorkerProcesses,
  identityStatusBuilder = buildIdentityStatus,
  gmailProviderFactory = null,
  identityProviderFactory = null,
  nowFn = Date.now,
  maxEvidenceAgeMs = DEFAULT_EVIDENCE_MAX_AGE_MS,
  onProgress = null,
} = {}) {
  const paths = assertExplicitLiveRoot(liveArchiveRoot, config?.root, {
    requiredRoot: requiredLiveArchiveRoot,
  });
  await assertLiveServiceQuiesced({
    liveRoot: paths.liveRoot,
    schedulerInspector,
    processInspector,
  });
  const evidence = await prepareReadOnlyEvidence({
    config,
    paths,
    anchorDatabasePath,
    anchorManifestPath,
    snapshotDatabasePath,
    snapshotManifestPath,
    backupMarkerPath,
    preRepairRestoreReceiptPath,
    DatabaseImpl,
    nowFn,
    maxEvidenceAgeMs,
    onProgress,
  });
  try {
    safeProgress(onProgress, 'fresh_provider_evidence_started');
    const fresh = await collectFreshLiveEvidence({
      config,
      env,
      identityStatusBuilder,
      gmailProviderFactory,
      identityProviderFactory,
      onProgress,
    });
    safeProgress(onProgress, 'fresh_provider_evidence_completed');
    const generatedAt = new Date(nowFn()).toISOString();
    const plan = buildGmailPartitionRepairPlan({
      database: evidence.database,
      anchorDatabase: evidence.anchorDatabase,
      providerInventories: fresh.inventories,
      identityProof: fresh.identityProof,
      expectedIdentities: evidence.expectedIdentities,
      rawMessageLoader: rawMessageLoader(evidence.database, paths.liveRoot),
      anchorSnapshotId: evidence.anchor.manifest.databaseSha256,
      contaminationWindow: contaminationWindow || DEFAULT_CONTAMINATION_WINDOW,
      generatedAt,
      ownerApprovalRecorded: false,
    });
    const planDigest = partitionRepairPlanDigest(plan);
    const dryRun = repairGmailPartitions(evidence.database, {
      plan,
      planDigest,
      identityProof: fresh.identityProof,
      expectedIdentities: evidence.expectedIdentities,
      rawMessageLoader: rawMessageLoader(evidence.database, paths.liveRoot),
      now: nowFn(),
    });
    const snapshotPrecondition = partitionRepairPreconditionDigest(
      evidence.snapshotDatabase,
      plan,
      planDigest
    );
    if (snapshotPrecondition !== dryRun.preconditionDigest) {
      throw liveRepairError(
        'GMAIL_LIVE_REPAIR_SOURCE_SNAPSHOT_MISMATCH',
        'the completed-backup snapshot does not exactly match the approved repair source state'
      );
    }
    const envelope = {
      schemaVersion: LIVE_PLAN_SCHEMA_VERSION,
      kind: LIVE_PLAN_KIND,
      migrationId: GMAIL_PARTITION_REPAIR_ID,
      generatedAt,
      liveRootDigest: sha256Text(paths.liveRoot),
      sourceSchemaVersion: evidence.schemaVersion,
      targetSchemaVersion: TARGET_REPAIR_SCHEMA_VERSION,
      sourceBackup: evidence.backupEvidence,
      preRepairRestoreReceipt: evidence.restoreReceipt,
      anchorDatabaseSha256: evidence.anchor.manifest.databaseSha256,
      planDigest,
      preconditionDigest: dryRun.preconditionDigest,
      repairPlan: plan,
    };
    envelope.envelopeDigest = livePlanEnvelopeDigest(envelope);
    await writePrivateJsonExclusive(planOutputPath, envelope, {
      forbiddenRoots: [paths.liveRoot, fs.realpathSync(repositoryRoot)],
    });
    return {
      code: 'GMAIL_LIVE_REPAIR_PLAN_VERIFIED',
      mode: 'read-only-plan',
      archiveDatabaseWritten: false,
      mailboxWritten: false,
      lockAcquired: false,
      scheduler: 'persistently-disabled',
      sourceSchemaVersion: evidence.schemaVersion,
      targetSchemaVersion: TARGET_REPAIR_SCHEMA_VERSION,
      migrationsPending: TARGET_REPAIR_SCHEMA_VERSION - evidence.schemaVersion,
      planWrittenOwnerOnly: true,
      planDigest,
      preconditionDigest: dryRun.preconditionDigest,
      envelopeDigest: envelope.envelopeDigest,
      counts: plan.counts,
      derivedStateToReset: dryRun.derivedStateToReset,
      providerInventoryCounts: Object.fromEntries(
        Object.entries(fresh.inventories).map(([accountId, ids]) => [
          accountId,
          ids.size,
        ])
      ),
      verifiedBlobCount: evidence.blobVerification.verifiedBlobCount,
      ownerApprovalRecorded: false,
      automaticReconciliation: false,
      automaticSchedulerResume: false,
    };
  } finally {
    closeReadOnlyEvidence(evidence);
  }
}

async function applyLiveGmailPartitionRepair({
  config,
  env = process.env,
  liveArchiveRoot,
  requiredLiveArchiveRoot = DEFAULT_ARCHIVE_ROOT,
  planInputPath,
  ownerApprovalPath,
  typedConfirmation,
  anchorDatabasePath,
  anchorManifestPath,
  snapshotDatabasePath,
  snapshotManifestPath,
  backupMarkerPath,
  preRepairRestoreReceiptPath,
  DatabaseImpl = SqliteDatabase,
  LockImpl = WorkerLock,
  schedulerInspector = inspectSchedulerDisabled,
  processInspector = inspectArchiveWorkerProcesses,
  identityStatusBuilder = buildIdentityStatus,
  gmailProviderFactory = null,
  identityProviderFactory = null,
  repairImpl = repairGmailPartitions,
  nowFn = Date.now,
  maxEvidenceAgeMs = DEFAULT_EVIDENCE_MAX_AGE_MS,
  onProgress = null,
} = {}) {
  if (typedConfirmation !== LIVE_REPAIR_CONFIRMATION) {
    throw liveRepairError(
      'GMAIL_LIVE_REPAIR_TYPED_CONFIRMATION_REQUIRED',
      'the exact live-archive warning phrase was not supplied'
    );
  }
  const paths = assertExplicitLiveRoot(liveArchiveRoot, config?.root, {
    requiredRoot: requiredLiveArchiveRoot,
  });
  const envelope = await readPrivateJson(
    planInputPath,
    'GMAIL_LIVE_REPAIR_PLAN_FILE_UNSAFE'
  );
  const ownerApproval = await readPrivateJson(
    ownerApprovalPath,
    'GMAIL_LIVE_REPAIR_OWNER_APPROVAL_FILE_UNSAFE'
  );
  validateLivePlanFileIntegrity(envelope);
  validateOwnerApprovalMetadata(ownerApproval, {
    plan: envelope.repairPlan,
    planDigest: envelope.planDigest,
    preconditionDigest: envelope.preconditionDigest,
    now: nowFn(),
  });
  await assertLiveServiceQuiesced({
    liveRoot: paths.liveRoot,
    schedulerInspector,
    processInspector,
  });
  await preflightLivePlanEvidence({
    envelope,
    paths,
    anchorDatabasePath,
    anchorManifestPath,
    snapshotDatabasePath,
    snapshotManifestPath,
    backupMarkerPath,
    preRepairRestoreReceiptPath,
    nowFn,
    maxEvidenceAgeMs,
  });

  const lock = new LockImpl(paths.liveRoot);
  let evidence = null;
  let writable = null;
  let outerCommitted = false;
  await lock.acquire();
  try {
    assertOwnedWorkerLock(paths.liveRoot);
    const scheduler = await schedulerInspector();
    if (
      scheduler?.label !== ARCHIVE_LAUNCHD_LABEL ||
      scheduler?.loaded !== false ||
      scheduler?.persistentlyDisabled !== true
    ) {
      throw liveRepairError('GMAIL_LIVE_REPAIR_SCHEDULER_AMBIGUOUS');
    }
    const processes = await processInspector();
    if (processes?.running !== false || processes?.matchingProcessCount !== 0) {
      throw liveRepairError(
        'GMAIL_LIVE_REPAIR_PROCESS_STATE_AMBIGUOUS',
        'archive worker process absence changed after lock acquisition'
      );
    }
    evidence = await prepareReadOnlyEvidence({
      config,
      paths,
      anchorDatabasePath,
      anchorManifestPath,
      snapshotDatabasePath,
      snapshotManifestPath,
      backupMarkerPath,
      preRepairRestoreReceiptPath,
      DatabaseImpl,
      nowFn,
      maxEvidenceAgeMs,
      onProgress,
    });
    validateLivePlanEnvelope(envelope, {
      liveRoot: paths.liveRoot,
      backupEvidence: evidence.backupEvidence,
      anchorDatabaseSha256: evidence.anchor.manifest.databaseSha256,
      restoreReceiptDigest: evidence.restoreReceipt.receiptDigest,
    });
    if (evidence.schemaVersion !== envelope.sourceSchemaVersion) {
      throw liveRepairError(
        'GMAIL_LIVE_REPAIR_PRECONDITION_MISMATCH',
        'the live schema changed after planning'
      );
    }
    const livePrecondition = partitionRepairPreconditionDigest(
      evidence.database,
      envelope.repairPlan,
      envelope.planDigest
    );
    const snapshotPrecondition = partitionRepairPreconditionDigest(
      evidence.snapshotDatabase,
      envelope.repairPlan,
      envelope.planDigest
    );
    if (
      livePrecondition !== envelope.preconditionDigest ||
      snapshotPrecondition !== envelope.preconditionDigest
    ) {
      throw liveRepairError(
        'GMAIL_LIVE_REPAIR_PRECONDITION_MISMATCH',
        'the live database or completed-backup snapshot changed after planning'
      );
    }
    safeProgress(onProgress, 'fresh_apply_provider_evidence_started');
    const fresh = await collectFreshLiveEvidence({
      config,
      env,
      identityStatusBuilder,
      gmailProviderFactory,
      identityProviderFactory,
      onProgress,
    });
    safeProgress(onProgress, 'fresh_apply_provider_evidence_completed');
    evidence.database.close();
    evidence.snapshotDatabase.close();
    evidence.database = null;
    evidence.snapshotDatabase = null;
    // Keep the independently verified anchor open for core evidence validation.

    writable = new DatabaseImpl(paths.databasePath, { fileMustExist: true });
    writable.pragma('foreign_keys = ON');
    writable.pragma('busy_timeout = 5000');
    writable.pragma('journal_mode = WAL');
    writable.pragma('synchronous = FULL');
    if (
      currentSchemaVersion(writable) !== envelope.sourceSchemaVersion ||
      partitionRepairPreconditionDigest(
        writable,
        envelope.repairPlan,
        envelope.planDigest
      ) !== envelope.preconditionDigest
    ) {
      throw liveRepairError(
        'GMAIL_LIVE_REPAIR_PRECONDITION_MISMATCH',
        'the live database changed immediately before the transaction'
      );
    }
    let transactionResult;
    const applyTransaction = writable.transaction(() => {
      const migrations = applyPendingRepairMigrations(writable);
      if (
        partitionRepairPreconditionDigest(
          writable,
          envelope.repairPlan,
          envelope.planDigest
        ) !== envelope.preconditionDigest
      ) {
        throw liveRepairError(
          'GMAIL_LIVE_REPAIR_MIGRATION_INVALIDATED_PLAN',
          'forward schema migrations changed the owner-approved repair precondition'
        );
      }
      const applied = repairImpl(writable, {
        plan: envelope.repairPlan,
        planDigest: envelope.planDigest,
        preconditionDigest: envelope.preconditionDigest,
        identityProof: fresh.identityProof,
        independentProviderInventories: fresh.inventories,
        independentAnchorDatabase: evidence.anchorDatabase,
        expectedIdentities: evidence.expectedIdentities,
        rawMessageLoader: rawMessageLoader(writable, paths.liveRoot),
        ownerApprovalMetadata: ownerApproval,
        apply: true,
        rehearsal: false,
        confirmation: GMAIL_PARTITION_REPAIR_CONFIRMATION,
        now: nowFn(),
      });
      const noOp = repairImpl(writable);
      if (noOp.status !== 'already_applied' || noOp.applied !== false) {
        throw liveRepairError(
          'GMAIL_LIVE_REPAIR_NOOP_VERIFICATION_FAILED',
          'the permanent repair receipt did not make a second invocation a verified no-op'
        );
      }
      return { migrations, applied, noOp };
    });
    try {
      transactionResult = applyTransaction();
      outerCommitted = true;
    } catch (error) {
      throw liveRepairError(
        'GMAIL_LIVE_REPAIR_TRANSACTION_ROLLED_BACK',
        'schema migrations and repair content were rolled back together; scheduler remains disabled',
        error
      );
    }
    const durableNoOp = repairImpl(writable);
    if (
      durableNoOp.status !== 'already_applied' ||
      durableNoOp.applied !== false ||
      writable.pragma('integrity_check', { simple: true }) !== 'ok' ||
      writable.pragma('foreign_key_check').length > 0
    ) {
      throw liveRepairError(
        'GMAIL_LIVE_REPAIR_POSTCOMMIT_VERIFICATION_FAILED',
        'the committed receipt or database integrity could not be verified; scheduler remains disabled'
      );
    }
    return {
      code: 'GMAIL_LIVE_REPAIR_APPLIED_AND_VERIFIED',
      mode: 'live-apply',
      applied: transactionResult.applied.applied === true,
      changedRows: transactionResult.applied.changedRows,
      counts: envelope.repairPlan.counts,
      planDigest: envelope.planDigest,
      preconditionDigest: envelope.preconditionDigest,
      postStateDigest: transactionResult.applied.postStateDigest,
      schemaBefore: transactionResult.migrations.before,
      schemaAfter: transactionResult.migrations.after,
      schemaMigrationsApplied: transactionResult.migrations.applied,
      secondInvocationNoOp: true,
      durableReceiptVerified: true,
      integrity: 'ok',
      foreignKeyProblems: 0,
      scheduler: 'persistently-disabled',
      automaticReconciliation: false,
      automaticSchedulerResume: false,
      automaticBackup: false,
    };
  } catch (error) {
    if (outerCommitted) throw error;
    throw error;
  } finally {
    if (writable) writable.close();
    closeReadOnlyEvidence(evidence);
    await lock.release();
  }
}

module.exports = {
  ARCHIVE_LAUNCHD_LABEL,
  DEFAULT_EVIDENCE_MAX_AGE_MS,
  LIVE_PLAN_KIND,
  LIVE_PLAN_SCHEMA_VERSION,
  LIVE_REPAIR_CONFIRMATION,
  MINIMUM_SUPPORTED_SCHEMA_VERSION,
  TARGET_REPAIR_SCHEMA_VERSION,
  OWNER_APPROVAL_CONFIRMATION,
  applyLiveGmailPartitionRepair,
  applyPendingRepairMigrations,
  assertExplicitIdentityConfiguration,
  assertExplicitLiveRoot,
  assertLiveServiceQuiesced,
  assertNoWorkerLock,
  buildLiveGmailPartitionRepairPlan,
  collectFreshLiveEvidence,
  createLiveRepairOwnerApproval,
  currentSchemaVersion,
  inspectSchedulerDisabled,
  inspectArchiveWorkerProcesses,
  livePlanEnvelopeDigest,
  preflightLivePlanEvidence,
  readVerifiedCloneRepairReceipt,
  readPrivateJson,
  readVerifiedDatabaseManifest,
  runProcessCapture,
  runLaunchctl,
  validateLivePlanEnvelope,
  validateLivePlanFileIntegrity,
  verifyCompletedBackupEvidence,
  verifyPreRepairRestoreReceipt,
  writePrivateJsonExclusive,
};
