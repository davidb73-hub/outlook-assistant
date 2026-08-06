const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const dotenv = require('dotenv');
const SqliteDatabase = require('better-sqlite3');
const { normalizeExpectedIdentity } = require('./config');
const { GmailArchiveProvider } = require('./providers/gmail');
const { OutlookArchiveProvider } = require('./providers/outlook');
const {
  GMAIL_PARTITION_REHEARSAL_CONFIRMATION,
  buildGmailPartitionRepairPlan,
  partitionRepairPlanDigest,
  repairGmailPartitions,
  validatePartitionRepairPlan,
} = require('./repair-gmail-partitions');
const {
  atomicWriteOwnerOnly,
  deriveGmailBindings,
  probeGmailCredentialSlots,
  proveGmailAnchorBindings,
  proveOutlookArchiveBinding,
} = require('./seed-archive-identities');
const { fileHash } = require('./backup');
const { inspectFtsConsistency } = require('./fts-index');
const { ImmutableSqliteDatabase } = require('./immutable-sqlite');

const CLONE_REHEARSAL_CONFIRMATION = 'APPLY_TO_VERIFIED_TEMPORARY_CLONE_ONLY';
const DEFAULT_CONTAMINATION_WINDOW = Object.freeze({
  startedAt: '2026-07-25T22:38:14.000Z',
  endedAt: '2026-07-30T11:29:16.999Z',
});

function rehearsalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function emitProgress(onProgress, phase, details = {}) {
  if (typeof onProgress === 'function') onProgress({ phase, ...details });
}

function assertTemporaryCloneRoot(cloneRoot, liveArchiveRoot) {
  const resolvedClone = fs.realpathSync(path.resolve(cloneRoot));
  const resolvedLive = fs.realpathSync(path.resolve(liveArchiveRoot));
  const temporary =
    resolvedClone.startsWith('/private/tmp/') ||
    resolvedClone.startsWith('/tmp/');
  if (!temporary || resolvedClone === resolvedLive) {
    throw rehearsalError('GMAIL_REHEARSAL_CLONE_PATH_UNSAFE');
  }
  const databasePath = path.join(resolvedClone, 'archive.sqlite3');
  const manifestPath = path.join(resolvedClone, 'manifest.json');
  const requiredStats = new Map();
  for (const requiredPath of [databasePath, manifestPath]) {
    const required = fs.lstatSync(requiredPath);
    if (
      required.isSymbolicLink() ||
      !required.isFile() ||
      path.dirname(fs.realpathSync(requiredPath)) !== resolvedClone
    ) {
      throw rehearsalError('GMAIL_REHEARSAL_CLONE_INCOMPLETE');
    }
    if (required.nlink !== 1) {
      throw rehearsalError('GMAIL_REHEARSAL_CLONE_HARDLINK_UNSAFE');
    }
    requiredStats.set(requiredPath, required);
  }
  const liveDatabasePath = path.join(resolvedLive, 'archive.sqlite3');
  if (fs.existsSync(liveDatabasePath)) {
    const liveDatabase = fs.statSync(liveDatabasePath);
    const cloneDatabase = requiredStats.get(databasePath);
    if (
      cloneDatabase.dev === liveDatabase.dev &&
      cloneDatabase.ino === liveDatabase.ino
    ) {
      throw rehearsalError('GMAIL_REHEARSAL_CLONE_HARDLINK_UNSAFE');
    }
  }
  const wal = fs.existsSync(`${databasePath}-wal`)
    ? fs.lstatSync(`${databasePath}-wal`)
    : null;
  if (wal?.isSymbolicLink() || (wal && wal.size > 0)) {
    throw rehearsalError('GMAIL_REHEARSAL_CLONE_DATABASE_UNSTABLE');
  }
  return { cloneRoot: resolvedClone, databasePath, manifestPath };
}

function assertCloneContentRoot(cloneRoot, contentRoot) {
  const resolvedContentRoot = fs.realpathSync(path.resolve(contentRoot));
  if (resolvedContentRoot !== cloneRoot) {
    throw rehearsalError('GMAIL_REHEARSAL_CONTENT_ROOT_MISMATCH');
  }
  for (const directoryName of ['raw-messages', 'attachments']) {
    const directoryPath = path.join(resolvedContentRoot, directoryName);
    const directory = fs.lstatSync(directoryPath);
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      throw rehearsalError('GMAIL_REHEARSAL_CLONE_CONTENT_INCOMPLETE');
    }
  }
  return resolvedContentRoot;
}

function resolvePlanOutputPath(cloneRoot, requestedPath = null) {
  const outputPath = path.resolve(
    requestedPath || path.join(cloneRoot, 'gmail-partition-repair-plan.json')
  );
  let parentPath;
  try {
    parentPath = fs.realpathSync(path.dirname(outputPath));
  } catch {
    throw rehearsalError('GMAIL_REHEARSAL_PLAN_PATH_UNSAFE');
  }
  if (
    parentPath !== cloneRoot ||
    !outputPath.endsWith('.json') ||
    ['archive.sqlite3', 'manifest.json'].includes(path.basename(outputPath))
  ) {
    throw rehearsalError('GMAIL_REHEARSAL_PLAN_PATH_UNSAFE');
  }
  if (fs.existsSync(outputPath)) {
    const output = fs.lstatSync(outputPath);
    if (output.isSymbolicLink() || !output.isFile()) {
      throw rehearsalError('GMAIL_REHEARSAL_PLAN_PATH_UNSAFE');
    }
  }
  return outputPath;
}

async function readVerifiedAnchorManifest(
  anchorDatabasePath,
  anchorManifestPath
) {
  let manifest;
  try {
    manifest = JSON.parse(
      await fsPromises.readFile(anchorManifestPath, 'utf8')
    );
  } catch {
    throw rehearsalError('GMAIL_REHEARSAL_ANCHOR_MANIFEST_INVALID');
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.databaseSha256 || '')) {
    throw rehearsalError('GMAIL_REHEARSAL_ANCHOR_MANIFEST_INVALID');
  }
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = await fsPromises
      .lstat(`${anchorDatabasePath}${suffix}`)
      .catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    if (sidecar) {
      throw rehearsalError('GMAIL_REHEARSAL_ANCHOR_DATABASE_UNSTABLE');
    }
  }
  const before = await fsPromises.stat(anchorDatabasePath, {
    bigint: true,
  });
  const actualSha256 = await fileHash(anchorDatabasePath);
  const after = await fsPromises.stat(anchorDatabasePath, {
    bigint: true,
  });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs
  ) {
    throw rehearsalError('GMAIL_REHEARSAL_ANCHOR_DATABASE_UNSTABLE');
  }
  if (actualSha256 !== manifest.databaseSha256) {
    throw rehearsalError('GMAIL_REHEARSAL_ANCHOR_DATABASE_HASH_MISMATCH');
  }
  return manifest;
}

function openCloneDatabase(DatabaseImpl, databasePath, applyRehearsal) {
  const database = new DatabaseImpl(databasePath, {
    readonly: !applyRehearsal,
    fileMustExist: true,
  });
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  if (applyRehearsal) {
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');
  } else {
    database.pragma('query_only = ON');
  }
  return database;
}

function openAnchorDatabase(
  databasePath,
  DatabaseImpl = ImmutableSqliteDatabase
) {
  const database = new DatabaseImpl(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  database.pragma('foreign_keys = ON');
  database.pragma('query_only = ON');
  return database;
}

function ftsAccountConsistency(database) {
  return inspectFtsConsistency(database).summary;
}

function sha256Json(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

async function readExactLivePlanEnvelope(planInputPath) {
  const resolved = path.resolve(planInputPath || '');
  const stat = await fsPromises.lstat(resolved).catch(() => null);
  if (
    !stat?.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600
  ) {
    throw rehearsalError('GMAIL_REHEARSAL_PLAN_INPUT_UNSAFE');
  }
  let envelope;
  try {
    envelope = JSON.parse(await fsPromises.readFile(resolved, 'utf8'));
  } catch {
    throw rehearsalError('GMAIL_REHEARSAL_PLAN_INPUT_INVALID');
  }
  const { envelopeDigest, ...unsigned } = envelope || {};
  if (
    envelope?.schemaVersion !== 1 ||
    envelope?.kind !== 'gmail-partition-live-repair-plan' ||
    envelope?.repairPlan?.ownerApprovalRecorded !== false ||
    envelope?.planDigest !== partitionRepairPlanDigest(envelope.repairPlan) ||
    envelope?.preconditionDigest?.length !== 64 ||
    envelopeDigest !== sha256Json(unsigned)
  ) {
    throw rehearsalError('GMAIL_REHEARSAL_PLAN_INPUT_INVALID');
  }
  return envelope;
}

async function verifyCloneBlobManifest(
  database,
  cloneRoot,
  manifest,
  { concurrency = 4, onProgress = null, progressEvery = 1000 } = {}
) {
  if (
    manifest?.formatVersion !== 1 ||
    !Array.isArray(manifest.blobs) ||
    manifest.blobCount !== manifest.blobs.length ||
    !/^[a-f0-9]{64}$/.test(manifest.blobInventorySha256 || '') ||
    sha256Json(manifest.blobs) !== manifest.blobInventorySha256
  ) {
    throw rehearsalError('GMAIL_REHEARSAL_CLONE_MANIFEST_INVALID');
  }
  const databaseInventory = database
    .prepare(
      `SELECT hash, kind, relative_path AS relativePath, size
       FROM blobs ORDER BY kind, hash`
    )
    .all();
  if (
    databaseInventory.length !== manifest.blobCount ||
    sha256Json(databaseInventory) !== manifest.blobInventorySha256
  ) {
    throw rehearsalError('GMAIL_REHEARSAL_CLONE_BLOB_INVENTORY_MISMATCH');
  }
  for (const blob of manifest.blobs) {
    let expectedPrefix = null;
    if (blob.kind === 'raw-message') expectedPrefix = 'raw-messages/';
    else if (blob.kind === 'attachment') expectedPrefix = 'attachments/';
    const absolutePath = path.resolve(cloneRoot, blob.relativePath || '');
    const relative = path.relative(cloneRoot, absolutePath);
    if (
      !expectedPrefix ||
      !/^[a-f0-9]{64}$/.test(blob.hash || '') ||
      !Number.isSafeInteger(blob.size) ||
      blob.size < 0 ||
      !String(blob.relativePath || '').startsWith(expectedPrefix) ||
      path.basename(blob.relativePath || '') !== blob.hash ||
      relative.startsWith('..') ||
      path.isAbsolute(relative)
    ) {
      throw rehearsalError('GMAIL_REHEARSAL_CLONE_MANIFEST_INVALID');
    }
  }
  const startedAt = Date.now();
  emitProgress(onProgress, 'clone_blob_verification_started', {
    totalBlobs: manifest.blobCount,
  });
  let nextIndex = 0;
  let verifiedBlobs = 0;
  let verifiedBytes = 0;
  const safeProgressEvery = Math.max(
    1,
    Number.parseInt(progressEvery, 10) || 1000
  );
  const worker = async () => {
    while (nextIndex < manifest.blobs.length) {
      const blob = manifest.blobs[nextIndex];
      nextIndex += 1;
      const absolutePath = path.resolve(cloneRoot, blob.relativePath);
      const stat = await fsPromises.lstat(absolutePath).catch(() => null);
      if (
        !stat?.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== blob.size ||
        (await fileHash(absolutePath)) !== blob.hash
      ) {
        throw rehearsalError('GMAIL_REHEARSAL_CLONE_BLOB_HASH_MISMATCH');
      }
      verifiedBlobs += 1;
      verifiedBytes += blob.size;
      if (
        verifiedBlobs === manifest.blobCount ||
        verifiedBlobs % safeProgressEvery === 0
      ) {
        emitProgress(onProgress, 'clone_blob_verification_progress', {
          verifiedBlobs,
          totalBlobs: manifest.blobCount,
          verifiedBytes,
          elapsedMs: Date.now() - startedAt,
        });
      }
    }
  };
  const workerCount = Math.max(
    1,
    Math.min(Number(concurrency) || 1, manifest.blobs.length || 1)
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  emitProgress(onProgress, 'clone_blob_verification_completed', {
    verifiedBlobs,
    totalBlobs: manifest.blobCount,
    verifiedBytes,
    elapsedMs: Date.now() - startedAt,
  });
  return {
    passed: true,
    verifiedBlobCount: manifest.blobCount,
    blobInventorySha256: manifest.blobInventorySha256,
  };
}

function assertFreshOutlookIdentity(
  outlookAccount,
  outlookIdentityProviderFactory = null
) {
  const provider = outlookIdentityProviderFactory
    ? outlookIdentityProviderFactory(outlookAccount)
    : new OutlookArchiveProvider({
        account: outlookAccount,
        persistTokenRefresh: false,
      });
  return provider.assertArchiveIdentity();
}

function assertConfiguredTarget(fileEnv, key, expectedIdentity) {
  const configured = normalizeExpectedIdentity(fileEnv[key]);
  if (!configured) {
    throw rehearsalError('GMAIL_REHEARSAL_IDENTITY_CONFIG_MISSING');
  }
  if (configured !== expectedIdentity) {
    throw rehearsalError('GMAIL_REHEARSAL_IDENTITY_CONFIG_CONFLICT');
  }
  return true;
}

function gmailAccounts(bindings) {
  return [
    {
      id: 'gmail-ablative',
      logicalAccountId: 'gmail-ablative',
      provider: 'gmail',
      credentialSlot: 'personal',
      accountKey: 'personal',
      expectedIdentity: bindings.logicalAblative,
    },
    {
      id: 'gmail-personal',
      logicalAccountId: 'gmail-personal',
      provider: 'gmail',
      credentialSlot: 'ablative',
      accountKey: 'ablative',
      expectedIdentity: bindings.logicalPersonal,
    },
  ];
}

async function collectProviderInventory(
  provider,
  account,
  { onProgress = null } = {}
) {
  const startedAt = Date.now();
  emitProgress(onProgress, 'provider_inventory_started', {
    logicalAccountId: account.logicalAccountId,
  });
  await provider.assertArchiveIdentity();
  const providerMessageIds = new Set();
  const seenCursors = new Set();
  let cursor = null;
  for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
    const page = await provider.listInventoryPage(cursor, {
      pageSize: 500,
    });
    if (!Array.isArray(page?.refs)) {
      throw rehearsalError('GMAIL_REHEARSAL_PROVIDER_RESPONSE_INVALID');
    }
    for (const ref of page.refs) {
      if (!ref || typeof ref.id !== 'string' || !ref.id) {
        throw rehearsalError('GMAIL_REHEARSAL_PROVIDER_RESPONSE_INVALID');
      }
      providerMessageIds.add(ref.id);
    }
    emitProgress(onProgress, 'provider_inventory_page', {
      logicalAccountId: account.logicalAccountId,
      pageNumber: pageNumber + 1,
      collectedMessages: providerMessageIds.size,
      complete: page.complete === true,
      elapsedMs: Date.now() - startedAt,
    });
    if (page.complete) {
      const identityStatus = await provider.assertArchiveIdentity();
      emitProgress(onProgress, 'provider_inventory_completed', {
        logicalAccountId: account.logicalAccountId,
        pages: pageNumber + 1,
        collectedMessages: providerMessageIds.size,
        elapsedMs: Date.now() - startedAt,
      });
      return {
        logicalAccountId: account.logicalAccountId,
        providerMessageIds,
        identityStatus,
      };
    }
    if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
      throw rehearsalError('GMAIL_REHEARSAL_PROVIDER_CURSOR_INVALID');
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw rehearsalError('GMAIL_REHEARSAL_PROVIDER_PAGE_LIMIT');
}

async function collectGmailInventories({
  accounts,
  env,
  providerFactory = null,
  onProgress = null,
}) {
  const results = [];
  for (const account of accounts) {
    const provider = providerFactory
      ? providerFactory(account)
      : new GmailArchiveProvider({
          account,
          env,
          persistTokenRefresh: false,
        });
    results.push(
      await collectProviderInventory(provider, account, { onProgress })
    );
  }
  const inventories = Object.fromEntries(
    results.map((result) => [
      result.logicalAccountId,
      result.providerMessageIds,
    ])
  );
  const overlap = [...inventories['gmail-ablative']].some((id) =>
    inventories['gmail-personal'].has(id)
  );
  if (overlap) {
    throw rehearsalError('GMAIL_REHEARSAL_PROVIDER_INVENTORY_OVERLAP');
  }
  return {
    inventories,
    statuses: results.map((result) => result.identityStatus),
  };
}

function identityProof(gmailStatuses, outlookStatus) {
  const accounts = [...gmailStatuses, outlookStatus].map((status) => ({
    logicalAccountId: status.logicalAccountId,
    credentialSlot: status.credentialSlot,
    expectedIdentityConfigured: status.expectedIdentityConfigured === true,
    identityMatch: status.identityMatch === true,
    verifiedAt: status.verifiedAt,
    errorCode: status.errorCode || null,
  }));
  return {
    passed: accounts.every(
      (account) =>
        account.expectedIdentityConfigured &&
        account.identityMatch &&
        !account.errorCode
    ),
    accounts,
  };
}

function rawMessageLoader(database, contentRoot) {
  const root = path.resolve(contentRoot);
  const statement = database.prepare(
    `SELECT kind, relative_path, size FROM blobs WHERE hash = ?`
  );
  return (row) => {
    const blob = statement.get(row.raw_blob_hash);
    if (!blob || blob.kind !== 'raw-message') {
      throw rehearsalError('GMAIL_REHEARSAL_RAW_BLOB_MISSING');
    }
    const absolutePath = path.resolve(root, blob.relative_path);
    const relative = path.relative(root, absolutePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw rehearsalError('GMAIL_REHEARSAL_RAW_BLOB_PATH_UNSAFE');
    }
    const content = fs.readFileSync(absolutePath);
    if (content.length !== blob.size) {
      throw rehearsalError('GMAIL_REHEARSAL_RAW_BLOB_SIZE_MISMATCH');
    }
    return content;
  };
}

function databaseCounts(database) {
  return {
    messages: database.prepare('SELECT COUNT(*) AS count FROM messages').get()
      .count,
    attachments: database
      .prepare('SELECT COUNT(*) AS count FROM attachments')
      .get().count,
    blobs: database.prepare('SELECT COUNT(*) AS count FROM blobs').get().count,
  };
}

async function runGmailPartitionCloneRehearsal({
  cloneRoot,
  contentRoot,
  anchorDatabasePath,
  anchorManifestPath,
  liveArchiveRoot,
  envPath = path.resolve(__dirname, '..', '.env'),
  planOutputPath = null,
  planInputPath = null,
  applyRehearsal = false,
  confirmation = null,
  contaminationWindow = DEFAULT_CONTAMINATION_WINDOW,
  DatabaseImpl = SqliteDatabase,
  AnchorDatabaseImpl = ImmutableSqliteDatabase,
  gmailSlotProbeFactory = null,
  gmailProviderFactory = null,
  outlookProfileProbe = null,
  outlookIdentityProviderFactory = null,
  processEnv = process.env,
  onProgress = null,
} = {}) {
  const rehearsalStartedAt = Date.now();
  const progress = (phaseOrEvent, details = {}) => {
    const nestedEvent =
      phaseOrEvent && typeof phaseOrEvent === 'object' ? phaseOrEvent : null;
    const phase = nestedEvent?.phase || phaseOrEvent;
    const eventDetails = nestedEvent
      ? Object.fromEntries(
          Object.entries(nestedEvent).filter(([key]) => key !== 'phase')
        )
      : details;
    emitProgress(onProgress, phase, {
      ...eventDetails,
      rehearsalElapsedMs: Date.now() - rehearsalStartedAt,
    });
  };
  if (applyRehearsal && confirmation !== CLONE_REHEARSAL_CONFIRMATION) {
    throw rehearsalError('GMAIL_REHEARSAL_CONFIRMATION_REQUIRED');
  }
  const clone = assertTemporaryCloneRoot(cloneRoot, liveArchiveRoot);
  const resolvedContentRoot = assertCloneContentRoot(
    clone.cloneRoot,
    contentRoot
  );
  if (planInputPath && planOutputPath) {
    throw rehearsalError('GMAIL_REHEARSAL_PLAN_MODE_AMBIGUOUS');
  }
  const outputPath = planInputPath
    ? null
    : resolvePlanOutputPath(clone.cloneRoot, planOutputPath);
  progress('clone_paths_verified', { applyRehearsal });
  const resolvedAnchorPath = fs.realpathSync(path.resolve(anchorDatabasePath));
  const resolvedAnchorManifestPath = fs.realpathSync(
    path.resolve(anchorManifestPath)
  );
  progress('anchor_verification_started');
  const anchorManifest = await readVerifiedAnchorManifest(
    resolvedAnchorPath,
    resolvedAnchorManifestPath
  );
  progress('anchor_verification_completed');
  let cloneManifest;
  try {
    cloneManifest = JSON.parse(
      await fsPromises.readFile(clone.manifestPath, 'utf8')
    );
  } catch {
    throw rehearsalError('GMAIL_REHEARSAL_CLONE_MANIFEST_INVALID');
  }
  const envContent = await fsPromises.readFile(envPath, 'utf8');
  const fileEnv = dotenv.parse(envContent);
  const mergedEnv = { ...processEnv, ...fileEnv };
  const gmailProbe = await probeGmailCredentialSlots({
    env: mergedEnv,
    slotProbeFactory: gmailSlotProbeFactory,
  });
  const bindings = deriveGmailBindings(
    fileEnv,
    envContent,
    gmailProbe.slotIdentities
  );
  assertConfiguredTarget(
    fileEnv,
    'EMAIL_ARCHIVE_GMAIL_ABLATIVE_EXPECTED_IDENTITY',
    bindings.logicalAblative
  );
  assertConfiguredTarget(
    fileEnv,
    'EMAIL_ARCHIVE_GMAIL_PERSONAL_EXPECTED_IDENTITY',
    bindings.logicalPersonal
  );
  progress('credential_bindings_proved');

  const database = openCloneDatabase(
    DatabaseImpl,
    clone.databasePath,
    applyRehearsal
  );
  const anchorDatabase = openAnchorDatabase(
    resolvedAnchorPath,
    AnchorDatabaseImpl
  );
  try {
    progress('database_integrity_started');
    if (
      database.pragma('integrity_check', { simple: true }) !== 'ok' ||
      database.pragma('foreign_key_check').length > 0 ||
      anchorDatabase.pragma('integrity_check', { simple: true }) !== 'ok' ||
      anchorDatabase.pragma('foreign_key_check').length > 0
    ) {
      throw rehearsalError('GMAIL_REHEARSAL_DATABASE_INVALID');
    }
    progress('database_integrity_completed');
    progress('fts_consistency_started');
    const ftsBefore = ftsAccountConsistency(database);
    if (!ftsBefore.passed) {
      throw rehearsalError('GMAIL_REHEARSAL_FTS_ACCOUNT_MISMATCH');
    }
    progress('fts_consistency_completed', ftsBefore);
    const blobManifestVerification = await verifyCloneBlobManifest(
      database,
      clone.cloneRoot,
      cloneManifest,
      { onProgress: progress }
    );
    progress('identity_and_anchor_proof_started');
    const anchorEvidence = proveGmailAnchorBindings(anchorDatabase, bindings);
    const outlookProbe = outlookProfileProbe
      ? await outlookProfileProbe()
      : await new OutlookArchiveProvider({
          account: {
            id: 'vitasci-outlook',
            logicalAccountId: 'vitasci-outlook',
            provider: 'outlook',
            credentialSlot: 'default-delegated',
            expectedIdentity: 'commissioning-placeholder.invalid',
          },
          persistTokenRefresh: false,
        }).probeIdentityCandidatesForCommissioning();
    const outlook = proveOutlookArchiveBinding(
      database,
      outlookProbe.candidates || []
    );
    assertConfiguredTarget(
      fileEnv,
      'EMAIL_ARCHIVE_OUTLOOK_EXPECTED_IDENTITY',
      outlook.identity
    );
    const outlookAccount = {
      id: 'vitasci-outlook',
      logicalAccountId: 'vitasci-outlook',
      provider: 'outlook',
      credentialSlot: 'default-delegated',
      expectedIdentity: outlook.identity,
    };
    const outlookStatus = await assertFreshOutlookIdentity(
      outlookAccount,
      outlookIdentityProviderFactory
    );
    progress('identity_and_anchor_proof_completed');
    const accounts = gmailAccounts(bindings);
    const firstCollection = await collectGmailInventories({
      accounts,
      env: mergedEnv,
      providerFactory: gmailProviderFactory,
      onProgress: progress,
    });
    const firstProof = identityProof(firstCollection.statuses, outlookStatus);
    if (!firstProof.passed) {
      throw rehearsalError('GMAIL_REHEARSAL_IDENTITY_UNPROVED');
    }
    const expectedIdentities = {
      'gmail-ablative': bindings.logicalAblative,
      'gmail-personal': bindings.logicalPersonal,
    };
    const loadRaw = rawMessageLoader(database, resolvedContentRoot);
    const generatedAt = new Date().toISOString();
    progress('repair_plan_build_started');
    const exactEnvelope = planInputPath
      ? await readExactLivePlanEnvelope(planInputPath)
      : null;
    const plan = exactEnvelope
      ? exactEnvelope.repairPlan
      : buildGmailPartitionRepairPlan({
          database,
          anchorDatabase,
          providerInventories: firstCollection.inventories,
          identityProof: firstProof,
          expectedIdentities,
          rawMessageLoader: loadRaw,
          anchorSnapshotId: anchorManifest.databaseSha256,
          contaminationWindow,
          generatedAt,
          ownerApprovalRecorded: false,
        });
    progress('repair_plan_build_completed', { counts: plan.counts });
    const planDigest = partitionRepairPlanDigest(plan);
    if (exactEnvelope) {
      validatePartitionRepairPlan(database, plan, {
        identityProof: firstProof,
        suppliedPlanDigest: planDigest,
        independentProviderInventories: firstCollection.inventories,
        independentAnchorDatabase: anchorDatabase,
        expectedIdentities,
        rawMessageLoader: loadRaw,
        requireIndependentEvidence: true,
      });
      progress('repair_plan_input_verified');
    } else {
      progress('repair_plan_write_started');
      await atomicWriteOwnerOnly(
        outputPath,
        `${JSON.stringify(plan, null, 2)}\n`
      );
      progress('repair_plan_write_completed');
    }
    progress('repair_dry_run_started');
    const dryRun = repairGmailPartitions(database, {
      plan,
      planDigest,
      identityProof: firstProof,
      expectedIdentities,
      rawMessageLoader: loadRaw,
    });
    if (
      exactEnvelope &&
      dryRun.preconditionDigest !== exactEnvelope.preconditionDigest
    ) {
      throw rehearsalError('GMAIL_REHEARSAL_EXACT_PRECONDITION_MISMATCH');
    }
    progress('repair_dry_run_completed');
    if (dryRun.repairSchemaConfigured !== true) {
      throw rehearsalError('GMAIL_REHEARSAL_REPAIR_SCHEMA_MISSING');
    }
    const beforeCounts = databaseCounts(database);
    const baseReport = {
      code: 'GMAIL_REHEARSAL_DRY_RUN_VERIFIED',
      clonePathVerified: true,
      liveArchiveUntouched: true,
      identityProofPassed: true,
      anchorBindingProved: anchorEvidence.length === 2,
      providerInventoryCounts: Object.fromEntries(
        Object.entries(firstCollection.inventories).map(([accountId, ids]) => [
          accountId,
          ids.size,
        ])
      ),
      planWrittenOwnerOnly: exactEnvelope
        ? false
        : ((await fsPromises.stat(outputPath)).mode & 0o777) === 0o600,
      exactLivePlanInputVerified: Boolean(exactEnvelope),
      counts: plan.counts,
      preconditionDigest: dryRun.preconditionDigest,
      integrity: dryRun.integrity,
      foreignKeyProblems: dryRun.foreignKeyProblems,
      ftsConsistencyBefore: ftsBefore,
      ftsSearchPassed: dryRun.ftsSearchPassed,
      ftsSearchDigest: dryRun.ftsSearchDigest,
      blobManifestVerification,
      databaseCounts: beforeCounts,
    };
    if (!applyRehearsal) {
      progress('rehearsal_completed', { applied: false });
      return baseReport;
    }

    progress('independent_apply_evidence_started');
    const secondCollection = await collectGmailInventories({
      accounts,
      env: mergedEnv,
      providerFactory: gmailProviderFactory,
      onProgress: progress,
    });
    const freshOutlookStatus = await assertFreshOutlookIdentity(
      outlookAccount,
      outlookIdentityProviderFactory
    );
    const freshProof = identityProof(
      secondCollection.statuses,
      freshOutlookStatus
    );
    if (!freshProof.passed) {
      throw rehearsalError('GMAIL_REHEARSAL_IDENTITY_UNPROVED');
    }
    progress('independent_apply_evidence_completed');
    progress('repair_apply_started');
    const applied = repairGmailPartitions(database, {
      plan,
      planDigest,
      preconditionDigest: dryRun.preconditionDigest,
      identityProof: freshProof,
      expectedIdentities,
      rawMessageLoader: loadRaw,
      independentProviderInventories: secondCollection.inventories,
      independentAnchorDatabase: anchorDatabase,
      apply: true,
      rehearsal: true,
      confirmation: GMAIL_PARTITION_REHEARSAL_CONFIRMATION,
    });
    progress('repair_apply_completed');
    const ftsAfter = ftsAccountConsistency(database);
    if (!ftsAfter.passed) {
      throw rehearsalError('GMAIL_REHEARSAL_FTS_ACCOUNT_MISMATCH');
    }
    const verifiedNoOp = repairGmailPartitions(database);
    progress('rehearsal_completed', { applied: true });
    return {
      ...baseReport,
      code: 'GMAIL_REHEARSAL_APPLIED_AND_VERIFIED',
      appliedToClone: applied.applied === true,
      changedRows: applied.changedRows,
      stableMessageIdsPreserved: applied.stableMessageIdsPreserved === true,
      childRowsPreserved: applied.childRowsPreserved === true,
      blobsPreserved: applied.blobsPreserved === true,
      activeOverlap: applied.activeOverlap,
      independentProviderAdditions: applied.independentProviderAdditions,
      postStateDigest: applied.postStateDigest,
      secondInvocationNoOp:
        verifiedNoOp.status === 'already_applied' &&
        verifiedNoOp.applied === false,
      postDatabaseCounts: databaseCounts(database),
      ftsConsistencyAfter: ftsAfter,
      integrity: database.pragma('integrity_check', { simple: true }),
      foreignKeyProblems: database.pragma('foreign_key_check').length,
    };
  } finally {
    anchorDatabase.close();
    database.close();
  }
}

module.exports = {
  CLONE_REHEARSAL_CONFIRMATION,
  DEFAULT_CONTAMINATION_WINDOW,
  assertCloneContentRoot,
  assertConfiguredTarget,
  assertFreshOutlookIdentity,
  assertTemporaryCloneRoot,
  collectGmailInventories,
  collectProviderInventory,
  ftsAccountConsistency,
  openAnchorDatabase,
  openCloneDatabase,
  rawMessageLoader,
  readExactLivePlanEnvelope,
  readVerifiedAnchorManifest,
  resolvePlanOutputPath,
  runGmailPartitionCloneRehearsal,
  verifyCloneBlobManifest,
};
