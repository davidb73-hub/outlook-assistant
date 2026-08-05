'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const SqliteDatabase = require('better-sqlite3');
const { ArchiveService } = require('./archive-service');
const { BackupManager, fileHash } = require('./backup');
const { ArchiveDatabase } = require('./database');
const { inspectFtsConsistency } = require('./fts-index');
const {
  CLONE_REHEARSAL_CONFIRMATION,
  runGmailPartitionCloneRehearsal,
} = require('./rehearse-gmail-partition-repair');
const { ContentStore, sha256 } = require('./storage');
const { ArchiveSyncEngine } = require('./sync-engine');

const COMMISSIONING_CONFIRMATION = 'DISPOSABLE_ARCHIVE_COMMISSIONING_ONLY';
const COMMISSIONING_ROOT = '/private/tmp/email-archive-aion-commissioning';
const RESTIC_PATH = '/opt/homebrew/bin/restic';
const SESSION_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;

const IDENTITIES = Object.freeze({
  outlook: 'outlook@example.test',
  gmailAblative: 'ablative@example.test',
  gmailPersonal: 'personal@example.test',
});

const ACCOUNTS = Object.freeze([
  Object.freeze({
    id: 'vitasci-outlook',
    logicalAccountId: 'vitasci-outlook',
    provider: 'outlook',
    credentialSlot: 'default-delegated',
    displayName: 'Synthetic Outlook',
    expectedIdentity: IDENTITIES.outlook,
  }),
  Object.freeze({
    id: 'gmail-ablative',
    logicalAccountId: 'gmail-ablative',
    provider: 'gmail',
    credentialSlot: 'personal',
    accountKey: 'personal',
    displayName: 'Synthetic Ablative Gmail',
    expectedIdentity: IDENTITIES.gmailAblative,
  }),
  Object.freeze({
    id: 'gmail-personal',
    logicalAccountId: 'gmail-personal',
    provider: 'gmail',
    credentialSlot: 'ablative',
    accountKey: 'ablative',
    displayName: 'Synthetic Personal Gmail',
    expectedIdentity: IDENTITIES.gmailPersonal,
  }),
]);

const INVENTORIES = Object.freeze({
  'vitasci-outlook': Object.freeze([
    'outlook-identity-outbound',
    'outlook-identity-inbound',
  ]),
  'gmail-ablative': Object.freeze([
    'ablative-identity-outbound',
    'ablative-identity-inbound',
    'anchored-a',
    'correct-a',
  ]),
  'gmail-personal': Object.freeze([
    'personal-identity-outbound',
    'personal-identity-inbound',
    'post-p',
  ]),
});

function commissioningError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireConfirmation(confirmation) {
  if (confirmation !== COMMISSIONING_CONFIRMATION) {
    throw commissioningError('DISPOSABLE_COMMISSIONING_CONFIRMATION_REQUIRED');
  }
}

function requireSessionId(sessionId) {
  if (!SESSION_PATTERN.test(String(sessionId || ''))) {
    throw commissioningError('DISPOSABLE_COMMISSIONING_SESSION_INVALID');
  }
  return String(sessionId);
}

function pathsFor(sessionId) {
  const safeSessionId = requireSessionId(sessionId);
  const root = path.join(COMMISSIONING_ROOT, safeSessionId);
  if (path.dirname(root) !== COMMISSIONING_ROOT) {
    throw commissioningError('DISPOSABLE_COMMISSIONING_PATH_UNSAFE');
  }
  return {
    sessionId: safeSessionId,
    root,
    statePath: path.join(root, 'commissioning-state.json'),
    cloneRoot: path.join(root, 'clone'),
    anchorRoot: path.join(root, 'anchor'),
    anchorDatabasePath: path.join(root, 'anchor', 'archive.sqlite3'),
    anchorManifestPath: path.join(root, 'anchor', 'manifest.json'),
    envPath: path.join(root, 'synthetic.env'),
    backupRepository: path.join(root, 'restic-repository'),
    restoreRoot: path.join(root, 'restored'),
    liveSentinelRoot: path.join(root, 'live-boundary-sentinel'),
  };
}

function liveArchiveRoot() {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Email Assistant Archive'
  );
}

async function rehearsalLiveRoot(paths) {
  const liveRoot = liveArchiveRoot();
  const liveStat = await fsPromises.lstat(liveRoot).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (liveStat) {
    if (liveStat.isSymbolicLink() || !liveStat.isDirectory()) {
      throw commissioningError('DISPOSABLE_COMMISSIONING_LIVE_ROOT_UNSAFE');
    }
    return liveRoot;
  }
  await fsPromises.mkdir(paths.liveSentinelRoot, { mode: 0o700 });
  return paths.liveSentinelRoot;
}

async function safeStat(filePath) {
  const stat = await fsPromises
    .lstat(filePath, { bigint: true })
    .catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  if (!stat) return { exists: false };
  return {
    exists: true,
    symbolicLink: stat.isSymbolicLink(),
    device: String(stat.dev),
    inode: String(stat.ino),
    size: String(stat.size),
    modifiedNanoseconds: String(stat.mtimeNs),
  };
}

async function liveFingerprint(root = liveArchiveRoot()) {
  return {
    root: await safeStat(root),
    database: await safeStat(path.join(root, 'archive.sqlite3')),
    wal: await safeStat(path.join(root, 'archive.sqlite3-wal')),
    shm: await safeStat(path.join(root, 'archive.sqlite3-shm')),
  };
}

function fingerprintsMatch(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function ensureCommissioningRoot() {
  await fsPromises.mkdir(COMMISSIONING_ROOT, {
    recursive: true,
    mode: 0o700,
  });
  const stat = await fsPromises.lstat(COMMISSIONING_ROOT);
  const resolved = await fsPromises.realpath(COMMISSIONING_ROOT);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    resolved !== COMMISSIONING_ROOT
  ) {
    throw commissioningError('DISPOSABLE_COMMISSIONING_ROOT_UNSAFE');
  }
  await fsPromises.chmod(COMMISSIONING_ROOT, 0o700);
}

async function atomicWriteOwnerOnly(filePath, value) {
  const temporary = `${filePath}.tmp`;
  await fsPromises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fsPromises.rename(temporary, filePath);
  await fsPromises.chmod(filePath, 0o600);
}

async function readState(paths, expectedStage = null) {
  const rootStat = await fsPromises.lstat(paths.root).catch(() => null);
  const stateStat = await fsPromises.lstat(paths.statePath).catch(() => null);
  if (
    !rootStat?.isDirectory() ||
    rootStat.isSymbolicLink() ||
    !stateStat?.isFile() ||
    stateStat.isSymbolicLink() ||
    stateStat.nlink !== 1 ||
    (stateStat.mode & 0o777) !== 0o600
  ) {
    throw commissioningError('DISPOSABLE_COMMISSIONING_STATE_UNSAFE');
  }
  let state;
  try {
    state = JSON.parse(await fsPromises.readFile(paths.statePath, 'utf8'));
  } catch {
    throw commissioningError('DISPOSABLE_COMMISSIONING_STATE_INVALID');
  }
  if (
    state?.schemaVersion !== 1 ||
    state?.sessionId !== paths.sessionId ||
    (expectedStage && state.stage !== expectedStage)
  ) {
    throw commissioningError('DISPOSABLE_COMMISSIONING_STATE_INVALID');
  }
  return state;
}

async function assertLiveUnchanged(state) {
  const current = await liveFingerprint();
  if (!fingerprintsMatch(state.initialLiveFingerprint, current)) {
    throw commissioningError('DISPOSABLE_COMMISSIONING_LIVE_STATE_CHANGED');
  }
  return true;
}

function message(providerMessageId, subject, options = {}) {
  const direction = options.direction || 'inbound';
  const identity = options.identity || 'synthetic-sender@example.test';
  const recipientType = direction === 'outbound' ? 'from' : 'to';
  return {
    providerMessageId,
    subject,
    bodyText: `Synthetic commissioning body for ${subject}`,
    receivedAt: options.receivedAt || '2026-07-18T00:00:00.000Z',
    direction,
    currentEligible: options.currentEligible !== false,
    recipients: [
      {
        type: recipientType,
        address: identity,
        displayName: 'Synthetic identity evidence',
      },
    ],
    locations: [
      {
        providerLocationId: 'inbox',
        displayName: 'Inbox',
        kind: 'inbox',
      },
    ],
    attachments: options.attachments || [],
    hasAttachments: Boolean(options.attachments?.length),
    source: { fixture: true, commissioning: true },
  };
}

function rawMessage({ deliveredTo, subject }) {
  return Buffer.from(
    [
      `Delivered-To: ${deliveredTo}`,
      `To: Archive Owner <${deliveredTo}>`,
      'From: Synthetic Sender <synthetic-sender@example.test>',
      `Subject: ${subject}`,
      '',
      'Synthetic commissioning content only',
    ].join('\r\n')
  );
}

async function stageIdentityEvidence(service, account, identity, prefix) {
  const outbound = message(
    `${prefix}-identity-outbound`,
    `${prefix} outbound`,
    {
      direction: 'outbound',
      identity,
    }
  );
  const inbound = message(`${prefix}-identity-inbound`, `${prefix} inbound`, {
    direction: 'inbound',
    identity,
  });
  await service.stageMessage(
    account.id,
    outbound,
    rawMessage({ deliveredTo: identity, subject: outbound.subject })
  );
  await service.stageMessage(
    account.id,
    inbound,
    rawMessage({ deliveredTo: identity, subject: inbound.subject })
  );
}

function checkpointAndClose(database) {
  database.db.pragma('wal_checkpoint(TRUNCATE)');
  database.close();
}

async function createFixture(paths) {
  const cloneDatabase = new ArchiveDatabase(
    path.join(paths.cloneRoot, 'archive.sqlite3')
  );
  const anchorDatabase = new ArchiveDatabase(paths.anchorDatabasePath);
  const cloneStore = new ContentStore(paths.cloneRoot);
  const anchorStore = new ContentStore(paths.anchorRoot);
  const cloneService = new ArchiveService({
    database: cloneDatabase,
    contentStore: cloneStore,
  });
  const anchorService = new ArchiveService({
    database: anchorDatabase,
    contentStore: anchorStore,
  });
  try {
    await cloneService.initialise(ACCOUNTS);
    await anchorService.initialise(
      ACCOUNTS.filter((account) => account.provider === 'gmail')
    );

    // Keep the Gmail insertion order identical in the current and immutable
    // anchor databases. Repair evidence binds the canonical database row as
    // well as its account and blob hash.
    await stageIdentityEvidence(
      cloneService,
      ACCOUNTS[1],
      IDENTITIES.gmailAblative,
      'ablative'
    );
    await stageIdentityEvidence(
      cloneService,
      ACCOUNTS[2],
      IDENTITIES.gmailPersonal,
      'personal'
    );
    await stageIdentityEvidence(
      anchorService,
      ACCOUNTS[1],
      IDENTITIES.gmailAblative,
      'ablative'
    );
    await stageIdentityEvidence(
      anchorService,
      ACCOUNTS[2],
      IDENTITIES.gmailPersonal,
      'personal'
    );

    const anchored = message('anchored-a', 'canonical anchored');
    const anchoredRaw = rawMessage({
      deliveredTo: IDENTITIES.gmailAblative,
      subject: anchored.subject,
    });
    await cloneService.stageMessage('gmail-ablative', anchored, anchoredRaw);
    await cloneService.stageMessage('gmail-personal', anchored, anchoredRaw);
    await anchorService.stageMessage('gmail-ablative', anchored, anchoredRaw);

    await stageIdentityEvidence(
      cloneService,
      ACCOUNTS[0],
      IDENTITIES.outlook,
      'outlook'
    );

    const post = message('post-p', 'post-anchor canonical', {
      attachments: [
        {
          providerAttachmentId: 'commissioning-attachment',
          fileName: 'commissioning.txt',
          mediaType: 'text/plain',
        },
      ],
    });
    const postRaw = rawMessage({
      deliveredTo: IDENTITIES.gmailPersonal,
      subject: post.subject,
    });
    await cloneService.stageMessage('gmail-personal', post, postRaw);
    const postWrong = await cloneService.stageMessage(
      'gmail-ablative',
      post,
      postRaw
    );
    const attachmentBlob = await cloneStore.write(
      'attachment',
      Buffer.from('Synthetic commissioning attachment'),
      'text/plain'
    );
    cloneDatabase.completeAttachment(
      postWrong.id,
      'commissioning-attachment',
      attachmentBlob
    );

    const correct = message('correct-a', 'already correct');
    await cloneService.stageMessage(
      'gmail-ablative',
      correct,
      rawMessage({
        deliveredTo: IDENTITIES.gmailAblative,
        subject: correct.subject,
      })
    );

    const tombstone = message('deleted-only-a', 'proved tombstone');
    await cloneService.stageMessage(
      'gmail-personal',
      tombstone,
      rawMessage({
        deliveredTo: IDENTITIES.gmailAblative,
        subject: tombstone.subject,
      })
    );
    cloneDatabase.recordTombstone('gmail-personal', 'deleted-only-a', {
      reason: 'synthetic commissioning fixture',
    });
  } finally {
    await checkpointAndClose(anchorDatabase);
    await checkpointAndClose(cloneDatabase);
  }

  const anchorSha256 = await fileHash(paths.anchorDatabasePath);
  await atomicWriteOwnerOnly(paths.anchorManifestPath, {
    databaseSha256: anchorSha256,
  });

  const databasePath = path.join(paths.cloneRoot, 'archive.sqlite3');
  const database = new SqliteDatabase(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  let blobs;
  let messageCount;
  try {
    blobs = database
      .prepare(
        `SELECT hash, kind, relative_path AS relativePath, size
         FROM blobs ORDER BY kind, hash`
      )
      .all();
    messageCount = database
      .prepare('SELECT COUNT(*) AS count FROM messages')
      .get().count;
  } finally {
    database.close();
  }
  await atomicWriteOwnerOnly(path.join(paths.cloneRoot, 'manifest.json'), {
    formatVersion: 1,
    databaseSha256: await fileHash(databasePath),
    messageCount,
    blobCount: blobs.length,
    blobInventorySha256: sha256(Buffer.from(JSON.stringify(blobs), 'utf8')),
    blobs,
  });

  const envContent = [
    `GMAIL_PERSONAL_EXPECTED_EMAIL=${IDENTITIES.gmailAblative}`,
    `GMAIL_ABLATIVE_EXPECTED_EMAIL=${IDENTITIES.gmailPersonal}`,
    `EMAIL_ARCHIVE_GMAIL_ABLATIVE_EXPECTED_IDENTITY=${IDENTITIES.gmailAblative}`,
    `EMAIL_ARCHIVE_GMAIL_PERSONAL_EXPECTED_IDENTITY=${IDENTITIES.gmailPersonal}`,
    `EMAIL_ARCHIVE_OUTLOOK_EXPECTED_IDENTITY=${IDENTITIES.outlook}`,
    '',
  ].join('\n');
  await fsPromises.writeFile(paths.envPath, envContent, { mode: 0o600 });
  await fsPromises.chmod(paths.envPath, 0o600);
  return { messageCount, blobCount: blobs.length };
}

function identityStatus(account) {
  return {
    logicalAccountId: account.logicalAccountId,
    credentialSlot: account.credentialSlot,
    expectedIdentityConfigured: true,
    identityMatch: true,
    verifiedAt: new Date().toISOString(),
    errorCode: null,
  };
}

function gmailSlotProbeFactory(account) {
  const identity =
    account.credentialSlot === 'personal'
      ? IDENTITIES.gmailAblative
      : IDENTITIES.gmailPersonal;
  return {
    probeIdentityCandidateForCommissioning: () =>
      Promise.resolve({
        credentialSlot: account.credentialSlot,
        identity,
        refreshedInMemory: false,
      }),
  };
}

function inventoryProvider(account) {
  const ids = INVENTORIES[account.logicalAccountId];
  if (!ids) {
    throw commissioningError('DISPOSABLE_COMMISSIONING_ACCOUNT_UNKNOWN');
  }
  return {
    assertArchiveIdentity: () => Promise.resolve(identityStatus(account)),
    refreshLocations: () =>
      Promise.resolve([
        {
          providerFolderId: 'inbox',
          displayName: 'Inbox',
          kind: 'inbox',
          excluded: false,
        },
      ]),
    listInventoryPage: () =>
      Promise.resolve({
        refs: ids.map((id) => ({ id })),
        nextCursor: null,
        complete: true,
      }),
    fetchBundle: () =>
      Promise.reject(
        commissioningError('DISPOSABLE_COMMISSIONING_UNEXPECTED_FETCH')
      ),
    fetchAttachment: () =>
      Promise.reject(
        commissioningError('DISPOSABLE_COMMISSIONING_UNEXPECTED_FETCH')
      ),
  };
}

async function prepareDisposable({ sessionId, confirmation }) {
  requireConfirmation(confirmation);
  const paths = pathsFor(sessionId);
  await ensureCommissioningRoot();
  const existing = await fsPromises.lstat(paths.root).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    throw commissioningError('DISPOSABLE_COMMISSIONING_SESSION_EXISTS');
  }
  await fsPromises.mkdir(paths.root, { mode: 0o700 });
  await fsPromises.mkdir(paths.cloneRoot, { mode: 0o700 });
  await fsPromises.mkdir(paths.anchorRoot, { mode: 0o700 });
  const initialLiveFingerprint = await liveFingerprint();
  const fixture = await createFixture(paths);
  const state = {
    schemaVersion: 1,
    sessionId: paths.sessionId,
    stage: 'prepared',
    createdAt: new Date().toISOString(),
    initialLiveFingerprint,
    fixture,
  };
  await atomicWriteOwnerOnly(paths.statePath, state);
  await assertLiveUnchanged(state);
  return {
    ok: true,
    session_id: paths.sessionId,
    code: 'DISPOSABLE_FIXTURE_PREPARED',
    fixture_messages: fixture.messageCount,
    fixture_blobs: fixture.blobCount,
  };
}

async function rehearseRepair({ sessionId, preparationCode }) {
  if (preparationCode !== 'DISPOSABLE_FIXTURE_PREPARED') {
    throw commissioningError('DISPOSABLE_COMMISSIONING_STAGE_PROOF_INVALID');
  }
  const paths = pathsFor(sessionId);
  const state = await readState(paths, 'prepared');
  await assertLiveUnchanged(state);
  const liveBoundaryRoot = await rehearsalLiveRoot(paths);
  const report = await runGmailPartitionCloneRehearsal({
    cloneRoot: paths.cloneRoot,
    contentRoot: paths.cloneRoot,
    anchorDatabasePath: paths.anchorDatabasePath,
    anchorManifestPath: paths.anchorManifestPath,
    liveArchiveRoot: liveBoundaryRoot,
    envPath: paths.envPath,
    applyRehearsal: true,
    confirmation: CLONE_REHEARSAL_CONFIRMATION,
    gmailSlotProbeFactory,
    gmailProviderFactory: inventoryProvider,
    outlookProfileProbe: () =>
      Promise.resolve({
        candidates: [IDENTITIES.outlook],
        refreshedInMemory: false,
      }),
    outlookIdentityProviderFactory: inventoryProvider,
    processEnv: {},
  });
  if (
    report.code !== 'GMAIL_REHEARSAL_APPLIED_AND_VERIFIED' ||
    report.appliedToClone !== true ||
    report.secondInvocationNoOp !== true ||
    report.integrity !== 'ok' ||
    report.foreignKeyProblems !== 0
  ) {
    throw commissioningError('DISPOSABLE_COMMISSIONING_REHEARSAL_FAILED');
  }
  state.stage = 'rehearsed';
  state.rehearsal = {
    changedRows: report.changedRows,
    quarantineDuplicates: report.counts.quarantineDuplicates,
    movedCanonicals: report.counts.moveProvedCanonicals,
    noOpVerified: report.secondInvocationNoOp,
    stableMessageIdsPreserved: report.stableMessageIdsPreserved,
    childRowsPreserved: report.childRowsPreserved,
    blobsPreserved: report.blobsPreserved,
  };
  await atomicWriteOwnerOnly(paths.statePath, state);
  await assertLiveUnchanged(state);
  return {
    ok: true,
    session_id: paths.sessionId,
    code: 'DISPOSABLE_REPAIR_REHEARSED',
    changed_rows: report.changedRows,
    quarantined_duplicates: report.counts.quarantineDuplicates,
    moved_canonicals: report.counts.moveProvedCanonicals,
    second_run_noop: report.secondInvocationNoOp,
  };
}

async function reconcileDisposable({ sessionId, rehearsalCode }) {
  if (rehearsalCode !== 'DISPOSABLE_REPAIR_REHEARSED') {
    throw commissioningError('DISPOSABLE_COMMISSIONING_STAGE_PROOF_INVALID');
  }
  const paths = pathsFor(sessionId);
  const state = await readState(paths, 'rehearsed');
  await assertLiveUnchanged(state);
  const database = new ArchiveDatabase(
    path.join(paths.cloneRoot, 'archive.sqlite3')
  );
  const service = new ArchiveService({
    database,
    contentStore: new ContentStore(paths.cloneRoot),
  });
  let results;
  let integrity;
  let foreignKeyProblems;
  let fts;
  try {
    const engine = new ArchiveSyncEngine({
      database,
      service,
      config: {
        accounts: ACCOUNTS,
        reconciliationBatchSize: 1,
      },
      providerFactory: inventoryProvider,
    });
    results = [];
    for (const account of ACCOUNTS) {
      results.push(await engine.reconcileAccount(account));
    }
    integrity = database.db.pragma('integrity_check', { simple: true });
    foreignKeyProblems = database.db.pragma('foreign_key_check').length;
    fts = inspectFtsConsistency(database.db).summary;
  } finally {
    await checkpointAndClose(database);
  }
  const passed =
    results.length === 3 &&
    results.every(
      (result) =>
        result.status === 'completed' &&
        result.differences === 0 &&
        result.errors === 0
    ) &&
    integrity === 'ok' &&
    foreignKeyProblems === 0 &&
    fts.passed === true;
  if (!passed) {
    throw commissioningError('DISPOSABLE_COMMISSIONING_RECONCILIATION_FAILED');
  }
  const discovered = results.reduce(
    (total, result) => total + result.discovered,
    0
  );
  state.stage = 'reconciled';
  state.reconciliation = {
    accounts: results.length,
    discovered,
    differences: 0,
    integrity,
    foreignKeyProblems,
    ftsPassed: true,
  };
  await atomicWriteOwnerOnly(paths.statePath, state);
  await assertLiveUnchanged(state);
  return {
    ok: true,
    session_id: paths.sessionId,
    code: 'DISPOSABLE_RECONCILIATION_VERIFIED',
    accounts_reconciled: results.length,
    inventory_items: discovered,
    differences: 0,
    integrity_ok: true,
  };
}

function disposablePassword(sessionId) {
  return crypto
    .createHash('sha256')
    .update(`disposable-aion-commissioning:${sessionId}`)
    .digest('hex');
}

async function backupDisposable({ sessionId, reconciliationCode }) {
  if (reconciliationCode !== 'DISPOSABLE_RECONCILIATION_VERIFIED') {
    throw commissioningError('DISPOSABLE_COMMISSIONING_STAGE_PROOF_INVALID');
  }
  const paths = pathsFor(sessionId);
  const state = await readState(paths, 'reconciled');
  await assertLiveUnchanged(state);
  await fsPromises.access(RESTIC_PATH, fs.constants.X_OK).catch(() => {
    throw commissioningError('DISPOSABLE_COMMISSIONING_RESTIC_UNAVAILABLE');
  });
  const database = new ArchiveDatabase(
    path.join(paths.cloneRoot, 'archive.sqlite3')
  );
  let first;
  let second;
  try {
    const manager = new BackupManager({
      config: {
        root: paths.cloneRoot,
        backupRepository: paths.backupRepository,
      },
      database,
      passwordProvider: () =>
        Promise.resolve(disposablePassword(paths.sessionId)),
      resticPath: RESTIC_PATH,
    });
    first = await manager.backup();
    second = await manager.backup();
  } finally {
    await checkpointAndClose(database);
  }
  if (
    first.repositoryCreated !== true ||
    !first.snapshotId ||
    second.repositoryCreated !== false ||
    !second.snapshotId ||
    second.dataAdded >= first.dataAdded
  ) {
    throw commissioningError('DISPOSABLE_COMMISSIONING_BACKUP_FAILED');
  }
  state.stage = 'backed_up';
  state.backup = {
    snapshots: 2,
    repositoryCreated: true,
    deduplicationObserved: true,
    manifestBlobCount: second.manifest.blobCount,
  };
  await atomicWriteOwnerOnly(paths.statePath, state);
  await assertLiveUnchanged(state);
  return {
    ok: true,
    session_id: paths.sessionId,
    code: 'DISPOSABLE_BACKUP_VERIFIED',
    snapshots_created: 2,
    deduplication_observed: true,
    manifest_blobs: second.manifest.blobCount,
  };
}

async function restoreDisposable({ sessionId, backupCode }) {
  if (backupCode !== 'DISPOSABLE_BACKUP_VERIFIED') {
    throw commissioningError('DISPOSABLE_COMMISSIONING_STAGE_PROOF_INVALID');
  }
  const paths = pathsFor(sessionId);
  const state = await readState(paths, 'backed_up');
  await assertLiveUnchanged(state);
  const database = new ArchiveDatabase(
    path.join(paths.cloneRoot, 'archive.sqlite3')
  );
  let restored;
  try {
    const manager = new BackupManager({
      config: {
        root: paths.cloneRoot,
        backupRepository: paths.backupRepository,
      },
      database,
      passwordProvider: () =>
        Promise.resolve(disposablePassword(paths.sessionId)),
      resticPath: RESTIC_PATH,
    });
    restored = await manager.restore(paths.restoreRoot);
  } finally {
    await checkpointAndClose(database);
  }
  if (
    restored.ok !== true ||
    restored.integrity !== 'ok' ||
    restored.databaseHashMatches !== true ||
    restored.countsMatch !== true ||
    restored.failedHashes.length !== 0
  ) {
    throw commissioningError('DISPOSABLE_COMMISSIONING_RESTORE_FAILED');
  }
  state.stage = 'restored';
  state.restore = {
    ok: true,
    databaseHashMatches: true,
    countsMatch: true,
    verifiedBlobCount: restored.verifiedBlobCount,
  };
  await atomicWriteOwnerOnly(paths.statePath, state);
  await assertLiveUnchanged(state);
  return {
    ok: true,
    session_id: paths.sessionId,
    code: 'DISPOSABLE_RESTORE_VERIFIED',
    database_hash_matches: true,
    counts_match: true,
    verified_blobs: restored.verifiedBlobCount,
  };
}

async function finalizeDisposable({ sessionId, restoreCode }) {
  if (restoreCode !== 'DISPOSABLE_RESTORE_VERIFIED') {
    throw commissioningError('DISPOSABLE_COMMISSIONING_STAGE_PROOF_INVALID');
  }
  const paths = pathsFor(sessionId);
  const state = await readState(paths, 'restored');
  await assertLiveUnchanged(state);
  state.stage = 'commissioned';
  state.completedAt = new Date().toISOString();
  state.liveArchiveUnchanged = true;
  state.liveEmailRetrieved = false;
  await atomicWriteOwnerOnly(paths.statePath, state);
  return {
    status: 'commissioned_disposable',
    session_id: paths.sessionId,
    repair_rehearsed: true,
    accounts_reconciled: state.reconciliation.accounts,
    differences: state.reconciliation.differences,
    backup_verified: true,
    restore_verified: true,
    live_archive_unchanged: true,
    live_email_retrieved: false,
  };
}

async function cleanupDisposable({ sessionId, confirmation }) {
  requireConfirmation(confirmation);
  const paths = pathsFor(sessionId);
  await readState(paths);
  await fsPromises.rm(paths.root, { recursive: true, force: false });
  return { removed: true, session_id: paths.sessionId };
}

module.exports = {
  ACCOUNTS,
  COMMISSIONING_CONFIRMATION,
  COMMISSIONING_ROOT,
  IDENTITIES,
  INVENTORIES,
  RESTIC_PATH,
  backupDisposable,
  cleanupDisposable,
  finalizeDisposable,
  fingerprintsMatch,
  liveFingerprint,
  pathsFor,
  prepareDisposable,
  reconcileDisposable,
  rehearseRepair,
  restoreDisposable,
};
