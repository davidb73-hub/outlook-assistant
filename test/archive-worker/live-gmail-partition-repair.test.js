const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const archiveRequire = createRequire(
  path.resolve(__dirname, '../../archive-worker/live-repair-test-loader.js')
);
const SqliteDatabase = archiveRequire('better-sqlite3');
const { MIGRATIONS } = require('../../archive-worker/migrations');
const {
  ARCHIVE_LAUNCHD_LABEL,
  LIVE_PLAN_KIND,
  LIVE_PLAN_SCHEMA_VERSION,
  OWNER_APPROVAL_CONFIRMATION,
  TARGET_REPAIR_SCHEMA_VERSION,
  LIVE_REPAIR_CONFIRMATION,
  applyLiveGmailPartitionRepair,
  applyPendingRepairMigrations,
  assertExplicitIdentityConfiguration,
  assertExplicitLiveRoot,
  assertLiveServiceQuiesced,
  buildLiveGmailPartitionRepairPlan,
  currentSchemaVersion,
  createLiveRepairOwnerApproval,
  inspectArchiveDatabaseOpenHandles,
  inspectArchiveWorkerProcesses,
  inspectSchedulerDisabled,
  livePlanEnvelopeDigest,
  writePrivateJsonExclusive,
} = require('../../archive-worker/live-gmail-partition-repair');
const {
  GMAIL_PARTITION_REHEARSAL_CONFIRMATION,
  GMAIL_PARTITION_REPAIR_ID,
  partitionRepairPlanDigest,
  repairGmailPartitions,
} = require('../../archive-worker/repair-gmail-partitions');
const {
  ImmutableSqliteDatabase,
} = require('../../archive-worker/immutable-sqlite');
const {
  assertCliSchemaMigrationSafe,
  liveRepairModeArguments,
  parseArguments,
  reconcileAccountsSequentially,
} = require('../../archive-worker/index');

function createSchemaDatabase(databasePath, throughVersion = 7) {
  const database = new SqliteDatabase(databasePath);
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  for (const migration of MIGRATIONS.filter(
    (candidate) => candidate.version <= throughVersion
  )) {
    database.exec(migration.sql);
    database
      .prepare(
        `INSERT INTO schema_migrations(version, name, applied_at)
         VALUES (?, ?, ?)`
      )
      .run(migration.version, migration.name, '2026-08-02T00:00:00.000Z');
  }
  return database;
}

function explicitConfig(root) {
  return {
    root,
    accounts: [
      {
        id: 'vitasci-outlook',
        logicalAccountId: 'vitasci-outlook',
        provider: 'outlook',
        credentialSlot: 'outlook',
        accountKey: 'outlook',
        expectedIdentity: 'outlook@example.invalid',
      },
      {
        id: 'gmail-ablative',
        logicalAccountId: 'gmail-ablative',
        provider: 'gmail',
        credentialSlot: 'personal',
        accountKey: 'personal',
        expectedIdentity: 'ablative@example.invalid',
      },
      {
        id: 'gmail-personal',
        logicalAccountId: 'gmail-personal',
        provider: 'gmail',
        credentialSlot: 'ablative',
        accountKey: 'ablative',
        expectedIdentity: 'personal@example.invalid',
      },
    ],
  };
}

const OPERATOR_NOW = Date.parse('2026-08-02T14:00:00.000Z');
const NODE_SQLITE_SUPPORTED = Number(process.versions.node.split('.')[0]) >= 22;

function readOnlyDatabaseOptions() {
  return NODE_SQLITE_SUPPORTED ? {} : { DatabaseImpl: SqliteDatabase };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Json(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

function writeOwnerOnlyJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(filePath, 0o600);
}

function seedIdentityEvidence(database) {
  const insertedAt = '2026-07-18T00:00:00.000Z';
  const insertAccount = database.prepare(
    `INSERT INTO accounts(
       id, provider, display_name, enabled, created_at, updated_at
     ) VALUES (?, ?, ?, 1, ?, ?)`
  );
  const insertMessage = database.prepare(
    `INSERT INTO messages(
       account_id, provider_message_id, subject, body_text, direction,
       archive_state, current_eligible, deleted_remote,
       first_archived_at, last_seen_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'archived_complete', 1, 0, ?, ?, ?)`
  );
  const insertRecipient = database.prepare(
    `INSERT INTO recipients(
       message_id, recipient_type, ordinal, address, display_name
     ) VALUES (?, ?, 0, ?, 'Synthetic Identity')`
  );
  const insertFts = database.prepare(
    `INSERT INTO messages_fts(
       message_id, account_id, subject, body, participants
     ) VALUES (?, ?, ?, ?, ?)`
  );
  const transaction = database.transaction(() => {
    insertAccount.run(
      'vitasci-outlook',
      'outlook',
      'Synthetic Outlook',
      insertedAt,
      insertedAt
    );
    for (const [accountId, identity] of [
      ['gmail-ablative', 'ablative@example.invalid'],
      ['gmail-personal', 'personal@example.invalid'],
    ]) {
      insertAccount.run(
        accountId,
        'gmail',
        `Synthetic ${accountId}`,
        insertedAt,
        insertedAt
      );
      for (const direction of ['inbound', 'outbound']) {
        const providerMessageId = `${accountId}-${direction}`;
        const subject = `Synthetic ${direction} identity evidence`;
        const message = insertMessage.run(
          accountId,
          providerMessageId,
          subject,
          'Synthetic archive body',
          direction,
          insertedAt,
          insertedAt,
          insertedAt
        );
        insertRecipient.run(
          message.lastInsertRowid,
          direction === 'inbound' ? 'to' : 'from',
          identity
        );
        insertFts.run(
          message.lastInsertRowid,
          accountId,
          subject,
          'Synthetic archive body',
          identity
        );
      }
    }
  });
  transaction();
}

function syntheticIdentityStatus(config, verifiedAt) {
  return {
    generatedAt: verifiedAt,
    passed: true,
    accounts: config.accounts.map((account) => ({
      logicalAccountId: account.logicalAccountId,
      credentialSlot: account.credentialSlot,
      expectedIdentityConfigured: true,
      identityMatch: true,
      verifiedAt,
      errorCode: null,
    })),
  };
}

function providerHarness(config, inventories, verifiedAt) {
  const identityStatusBuilder = jest.fn(async () =>
    syntheticIdentityStatus(config, verifiedAt)
  );
  const gmailProviderFactory = jest.fn((account) => ({
    assertArchiveIdentity: jest.fn(async () => ({
      logicalAccountId: account.logicalAccountId,
      credentialSlot: account.credentialSlot,
      expectedIdentityConfigured: true,
      identityMatch: true,
      verifiedAt,
      errorCode: null,
    })),
    listInventoryPage: jest.fn(async () => ({
      refs: inventories[account.id].map((id) => ({ id })),
      complete: true,
    })),
  }));
  return { identityStatusBuilder, gmailProviderFactory };
}

async function createOperatorEvidence(liveRoot, root) {
  const liveDatabasePath = path.join(liveRoot, 'archive.sqlite3');
  const liveDatabase = new SqliteDatabase(liveDatabasePath);
  liveDatabase.pragma('journal_mode = WAL');
  seedIdentityEvidence(liveDatabase);
  const tableCounts = Object.fromEntries(
    ['accounts', 'messages', 'attachments', 'blobs'].map((table) => [
      table,
      liveDatabase.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
        .count,
    ])
  );
  const snapshotRoot = path.join(liveRoot, 'snapshots', 'current');
  fs.mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
  const snapshotDatabasePath = path.join(snapshotRoot, 'archive.sqlite3');
  await liveDatabase.backup(snapshotDatabasePath);
  liveDatabase.pragma('wal_checkpoint(TRUNCATE)');
  liveDatabase.close();
  for (const suffix of ['-wal', '-shm']) {
    fs.rmSync(`${liveDatabasePath}${suffix}`, { force: true });
  }
  fs.chmodSync(snapshotDatabasePath, 0o600);

  const blobs = [];
  const snapshotManifestPath = path.join(snapshotRoot, 'manifest.json');
  const snapshotManifest = {
    formatVersion: 1,
    createdAt: '2026-08-02T13:55:00.000Z',
    databaseSha256: sha256(fs.readFileSync(snapshotDatabasePath)),
    tableCounts,
    blobCount: 0,
    blobInventorySha256: sha256Json(blobs),
    blobs,
  };
  writeOwnerOnlyJson(snapshotManifestPath, snapshotManifest);

  const anchorDatabasePath = path.join(root, 'identity-anchor.sqlite3');
  const anchorDatabase = createSchemaDatabase(anchorDatabasePath);
  seedIdentityEvidence(anchorDatabase);
  anchorDatabase.close();
  fs.chmodSync(anchorDatabasePath, 0o600);
  const anchorManifestPath = path.join(root, 'identity-anchor-manifest.json');
  writeOwnerOnlyJson(anchorManifestPath, {
    formatVersion: 1,
    createdAt: '2026-07-25T00:00:00.000Z',
    databaseSha256: sha256(fs.readFileSync(anchorDatabasePath)),
  });

  const manifestsRoot = path.join(liveRoot, 'manifests');
  fs.mkdirSync(manifestsRoot, { recursive: true, mode: 0o700 });
  const snapshotId = 'synthetic-restic-snapshot-0001';
  const backupMarkerPath = path.join(manifestsRoot, 'last-backup.json');
  writeOwnerOnlyJson(backupMarkerPath, {
    completedAt: '2026-08-02T13:56:00.000Z',
    snapshotId,
    tableCounts,
    blobCount: 0,
  });
  const restoreReceiptPath = path.join(
    manifestsRoot,
    'pre-repair-restore-synthetic.json'
  );
  const restoreReceipt = {
    schemaVersion: 1,
    kind: 'email-assistant-pre-repair-restore-receipt',
    completedAt: '2026-08-02T13:57:00.000Z',
    snapshotIdDigest: sha256(snapshotId),
    databaseSha256: snapshotManifest.databaseSha256,
    blobInventorySha256: snapshotManifest.blobInventorySha256,
    blobCount: 0,
    exactSnapshotRestored: true,
    retainedRestoreMatchesManifest: true,
    liveSchemaUnchanged: true,
    liveDatabaseHashUnchanged: true,
    fullBlobVerificationPassed: true,
  };
  restoreReceipt.receiptDigest = sha256Json(restoreReceipt);
  writeOwnerOnlyJson(restoreReceiptPath, restoreReceipt);

  return {
    liveDatabasePath,
    snapshotDatabasePath,
    snapshotManifestPath,
    anchorDatabasePath,
    anchorManifestPath,
    backupMarkerPath,
    restoreReceiptPath,
    inventories: {
      'gmail-ablative': ['gmail-ablative-inbound', 'gmail-ablative-outbound'],
      'gmail-personal': ['gmail-personal-inbound', 'gmail-personal-outbound'],
    },
  };
}

async function rehearseExactOperatorPlan({ evidence, envelope, config, root }) {
  const cloneDatabasePath = path.join(root, 'exact-plan-clone.sqlite3');
  fs.copyFileSync(evidence.snapshotDatabasePath, cloneDatabasePath);
  fs.chmodSync(cloneDatabasePath, 0o600);
  const clone = new SqliteDatabase(cloneDatabasePath);
  const anchor = new SqliteDatabase(evidence.anchorDatabasePath, {
    readonly: true,
    fileMustExist: true,
  });
  const proof = syntheticIdentityStatus(
    config,
    new Date(OPERATOR_NOW).toISOString()
  );
  const independentProviderInventories = Object.fromEntries(
    Object.entries(evidence.inventories).map(([accountId, ids]) => [
      accountId,
      new Set(ids),
    ])
  );
  try {
    const applyRehearsal = clone.transaction(() => {
      applyPendingRepairMigrations(clone);
      return repairGmailPartitions(clone, {
        plan: envelope.repairPlan,
        planDigest: envelope.planDigest,
        preconditionDigest: envelope.preconditionDigest,
        identityProof: proof,
        independentProviderInventories,
        independentAnchorDatabase: anchor,
        expectedIdentities: {
          'gmail-ablative': 'ablative@example.invalid',
          'gmail-personal': 'personal@example.invalid',
        },
        rawMessageLoader: () => {
          throw new Error('synthetic fixture has no raw blobs');
        },
        apply: true,
        rehearsal: true,
        confirmation: GMAIL_PARTITION_REHEARSAL_CONFIRMATION,
        now: OPERATOR_NOW,
      });
    });
    expect(applyRehearsal()).toEqual(
      expect.objectContaining({ applied: true, mode: 'rehearsal' })
    );
    expect(repairGmailPartitions(clone)).toEqual(
      expect.objectContaining({ applied: false, status: 'already_applied' })
    );
  } finally {
    anchor.close();
    clone.close();
  }
  fs.chmodSync(cloneDatabasePath, 0o600);
  return cloneDatabasePath;
}

function quiescenceHarness() {
  return {
    schedulerInspector: jest.fn(async () => ({
      label: ARCHIVE_LAUNCHD_LABEL,
      loaded: false,
      persistentlyDisabled: true,
    })),
    processInspector: jest.fn(async () => ({
      running: false,
      matchingProcessCount: 0,
    })),
    databaseHandleInspector: jest.fn(() => ({
      open: false,
      matchingProcessCount: 0,
    })),
  };
}

async function prepareExactOperatorPlan({ liveRoot, root }) {
  const evidence = await createOperatorEvidence(liveRoot, root);
  const config = explicitConfig(liveRoot);
  const planOutputPath = path.join(root, 'reviewed-live-plan.json');
  const approvalOutputPath = path.join(root, 'owner-approval.json');
  const buildProviders = providerHarness(
    config,
    evidence.inventories,
    new Date(OPERATOR_NOW).toISOString()
  );
  const quiescence = quiescenceHarness();
  const before = {
    sha256: sha256(fs.readFileSync(evidence.liveDatabasePath)),
    stat: fs.statSync(evidence.liveDatabasePath, { bigint: true }),
  };
  const planReport = await buildLiveGmailPartitionRepairPlan({
    config,
    liveArchiveRoot: liveRoot,
    requiredLiveArchiveRoot: liveRoot,
    planOutputPath,
    anchorDatabasePath: evidence.anchorDatabasePath,
    anchorManifestPath: evidence.anchorManifestPath,
    snapshotDatabasePath: evidence.snapshotDatabasePath,
    snapshotManifestPath: evidence.snapshotManifestPath,
    backupMarkerPath: evidence.backupMarkerPath,
    preRepairRestoreReceiptPath: evidence.restoreReceiptPath,
    identityStatusBuilder: buildProviders.identityStatusBuilder,
    gmailProviderFactory: buildProviders.gmailProviderFactory,
    schedulerInspector: quiescence.schedulerInspector,
    processInspector: quiescence.processInspector,
    databaseHandleInspector: quiescence.databaseHandleInspector,
    nowFn: () => OPERATOR_NOW,
    ...readOnlyDatabaseOptions(),
  });
  const after = {
    sha256: sha256(fs.readFileSync(evidence.liveDatabasePath)),
    stat: fs.statSync(evidence.liveDatabasePath, { bigint: true }),
  };
  const envelope = JSON.parse(fs.readFileSync(planOutputPath, 'utf8'));
  const cloneDatabasePath = await rehearseExactOperatorPlan({
    evidence,
    envelope,
    config,
    root,
  });
  await createLiveRepairOwnerApproval({
    planInputPath: planOutputPath,
    cloneDatabasePath,
    approvalOutputPath,
    approvedPlanDigest: envelope.planDigest,
    confirmation: OWNER_APPROVAL_CONFIRMATION,
    approvalId: 'owner-approval:integrated-operator-path',
    liveArchiveRoot: liveRoot,
    nowFn: () => OPERATOR_NOW + 60_000,
  });
  return {
    evidence,
    config,
    planOutputPath,
    approvalOutputPath,
    envelope,
    planReport,
    buildProviders,
    quiescence,
    before,
    after,
  };
}

function operatorApplyArguments(fixture, applyProviders, overrides = {}) {
  return {
    config: fixture.config,
    liveArchiveRoot: fixture.config.root,
    requiredLiveArchiveRoot: fixture.config.root,
    planInputPath: fixture.planOutputPath,
    ownerApprovalPath: fixture.approvalOutputPath,
    typedConfirmation: LIVE_REPAIR_CONFIRMATION,
    anchorDatabasePath: fixture.evidence.anchorDatabasePath,
    anchorManifestPath: fixture.evidence.anchorManifestPath,
    snapshotDatabasePath: fixture.evidence.snapshotDatabasePath,
    snapshotManifestPath: fixture.evidence.snapshotManifestPath,
    backupMarkerPath: fixture.evidence.backupMarkerPath,
    preRepairRestoreReceiptPath: fixture.evidence.restoreReceiptPath,
    identityStatusBuilder: applyProviders.identityStatusBuilder,
    gmailProviderFactory: applyProviders.gmailProviderFactory,
    schedulerInspector: fixture.quiescence.schedulerInspector,
    processInspector: fixture.quiescence.processInspector,
    databaseHandleInspector: fixture.quiescence.databaseHandleInspector,
    nowFn: () => OPERATOR_NOW + 120_000,
    ...(NODE_SQLITE_SUPPORTED ? {} : { ReadOnlyDatabaseImpl: SqliteDatabase }),
    ...overrides,
  };
}

describe('owner-gated live Gmail partition repair safety surface', () => {
  let root;
  let liveRoot;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join('/tmp', 'gmail-live-repair-'))
    );
    liveRoot = path.join(root, 'live');
    fs.mkdirSync(liveRoot);
    fs.mkdirSync(path.join(liveRoot, 'raw-messages'));
    fs.mkdirSync(path.join(liveRoot, 'attachments'));
    createSchemaDatabase(path.join(liveRoot, 'archive.sqlite3')).close();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('requires the explicit, configured, and product live roots to be identical', () => {
    expect(
      assertExplicitLiveRoot(liveRoot, liveRoot, { requiredRoot: liveRoot })
    ).toEqual({
      liveRoot: fs.realpathSync(liveRoot),
      databasePath: path.join(fs.realpathSync(liveRoot), 'archive.sqlite3'),
    });

    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    expect(() =>
      assertExplicitLiveRoot(liveRoot, liveRoot, { requiredRoot: other })
    ).toThrow('GMAIL_LIVE_REPAIR_ROOT_AMBIGUOUS');
  });

  test('parses plan and apply modes independently of identity seeding flags', () => {
    const seed = parseArguments([
      'node',
      'index.js',
      'seed-archive-identities',
      '--anchor-db',
      '/tmp/anchor.sqlite3',
    ]);
    expect(seed.flags).toEqual({ 'anchor-db': '/tmp/anchor.sqlite3' });

    expect(
      liveRepairModeArguments(
        parseArguments([
          'node',
          'index.js',
          'live-gmail-partition-repair',
          '--plan-output',
          '/tmp/plan.json',
        ])
      )
    ).toEqual({ apply: false });
    expect(() =>
      liveRepairModeArguments(
        parseArguments([
          'node',
          'index.js',
          'live-gmail-partition-repair',
          '--apply',
        ])
      )
    ).toThrow('GMAIL_LIVE_REPAIR_ARGUMENT_MISSING');
  });

  test('manual reconciliation completes one account before starting the next', async () => {
    let releaseFirst;
    const firstPending = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const calls = [];
    const engine = {
      reconcileAccount: jest.fn(async (account) => {
        calls.push(`start:${account.id}`);
        if (account.id === 'first') await firstPending;
        calls.push(`finish:${account.id}`);
        return { accountId: account.id, status: 'completed' };
      }),
    };
    const pending = reconcileAccountsSequentially(engine, [
      { id: 'first' },
      { id: 'second' },
    ]);
    await Promise.resolve();
    expect(calls).toEqual(['start:first']);
    releaseFirst();

    await expect(pending).resolves.toEqual([
      { accountId: 'first', status: 'completed' },
      { accountId: 'second', status: 'completed' },
    ]);
    expect(calls).toEqual([
      'start:first',
      'finish:first',
      'start:second',
      'finish:second',
    ]);
  });

  test('blocks archive:init and every ordinary command from migrating schema 7', () => {
    expect(() => assertCliSchemaMigrationSafe(7)).toThrow(
      'ARCHIVE_SCHEMA_MIGRATION_REQUIRES_EXPLICIT_WORKFLOW'
    );
    expect(assertCliSchemaMigrationSafe(0)).toBe(true);
    expect(assertCliSchemaMigrationSafe(11)).toBe(true);
  });

  test('rejects symlinked or hard-linked live database ambiguity', () => {
    const databasePath = path.join(liveRoot, 'archive.sqlite3');
    const target = path.join(root, 'target.sqlite3');
    fs.renameSync(databasePath, target);
    fs.symlinkSync(target, databasePath);
    expect(() =>
      assertExplicitLiveRoot(liveRoot, liveRoot, { requiredRoot: liveRoot })
    ).toThrow('GMAIL_LIVE_REPAIR_DATABASE_AMBIGUOUS');

    fs.rmSync(databasePath);
    fs.linkSync(target, databasePath);
    expect(() =>
      assertExplicitLiveRoot(liveRoot, liveRoot, { requiredRoot: liveRoot })
    ).toThrow('GMAIL_LIVE_REPAIR_DATABASE_AMBIGUOUS');
  });

  test('proves the exact launchd label is absent and persistently disabled', async () => {
    for (const persistedValue of ['true', 'disabled']) {
      const passingRunner = jest.fn(async (args) =>
        args[0] === 'print'
          ? { code: 113, stdout: '', stderr: 'not found' }
          : {
              code: 0,
              stdout: `disabled services = {\n  "${ARCHIVE_LAUNCHD_LABEL}" => ${persistedValue}\n}\n`,
              stderr: '',
            }
      );
      await expect(
        inspectSchedulerDisabled({ runner: passingRunner, uid: 501 })
      ).resolves.toEqual({
        label: ARCHIVE_LAUNCHD_LABEL,
        loaded: false,
        persistentlyDisabled: true,
      });
    }

    await expect(
      inspectSchedulerDisabled({
        runner: async (args) =>
          args[0] === 'print'
            ? { code: 113, stdout: '', stderr: 'not found' }
            : {
                code: 0,
                stdout: `"${ARCHIVE_LAUNCHD_LABEL}" => false`,
                stderr: '',
              },
      })
    ).rejects.toThrow('GMAIL_LIVE_REPAIR_SCHEDULER_AMBIGUOUS');

    await expect(
      inspectSchedulerDisabled({
        runner: async (args) =>
          args[0] === 'print'
            ? { code: 0, stdout: 'loaded', stderr: '' }
            : { code: 0, stdout: '', stderr: '' },
      })
    ).rejects.toThrow('GMAIL_LIVE_REPAIR_SCHEDULER_ACTIVE');

    await expect(
      inspectSchedulerDisabled({
        runner: async () => ({ code: 113, stdout: '', stderr: '' }),
      })
    ).rejects.toThrow('GMAIL_LIVE_REPAIR_SCHEDULER_AMBIGUOUS');

    await expect(
      inspectSchedulerDisabled({
        runner: async (args) =>
          args[0] === 'print'
            ? { code: 1, stdout: '', stderr: 'permission denied' }
            : {
                code: 0,
                stdout: `"${ARCHIVE_LAUNCHD_LABEL}" => true`,
                stderr: '',
              },
      })
    ).rejects.toThrow('GMAIL_LIVE_REPAIR_SCHEDULER_AMBIGUOUS');
  });

  test('detects absolute and repository-scoped relative worker processes', async () => {
    const repositoryRoot = fs.realpathSync(path.resolve(__dirname, '../..'));
    const absoluteWorker = path.join(
      repositoryRoot,
      'archive-worker',
      'scheduled.js'
    );
    await expect(
      inspectArchiveWorkerProcesses({
        repositoryRoot,
        currentPid: 99999,
        runner: async () => ({
          code: 0,
          stdout: `123 /opt/homebrew/bin/node ${absoluteWorker}\n`,
          stderr: '',
        }),
      })
    ).rejects.toThrow('GMAIL_LIVE_REPAIR_WORKER_PROCESS_ACTIVE');

    const relativeRunner = jest.fn(async (command) =>
      command === '/bin/ps'
        ? {
            code: 0,
            stdout: '124 node archive-worker/index.js sync\n',
            stderr: '',
          }
        : { code: 0, stdout: `p124\nn${repositoryRoot}\n`, stderr: '' }
    );
    await expect(
      inspectArchiveWorkerProcesses({
        repositoryRoot,
        currentPid: 99999,
        runner: relativeRunner,
      })
    ).rejects.toThrow('GMAIL_LIVE_REPAIR_WORKER_PROCESS_ACTIVE');
  });

  test('ignores a relative worker command whose cwd belongs to another repository', async () => {
    const repositoryRoot = fs.realpathSync(path.resolve(__dirname, '../..'));
    const otherRepository = path.join(root, 'unrelated-repository');
    fs.mkdirSync(otherRepository);
    await expect(
      inspectArchiveWorkerProcesses({
        repositoryRoot,
        currentPid: 99999,
        runner: async (command) =>
          command === '/bin/ps'
            ? {
                code: 0,
                stdout: '125 node archive-worker/scheduled.js\n',
                stderr: '',
              }
            : {
                code: 0,
                stdout: `p125\nn${otherRepository}\n`,
                stderr: '',
              },
      })
    ).resolves.toEqual({ running: false, matchingProcessCount: 0 });
  });

  test('preserves the underlying lsof failure as the ambiguous-process cause', async () => {
    const lsofFailure = new Error('synthetic lsof failure');
    await expect(
      inspectArchiveWorkerProcesses({
        repositoryRoot: fs.realpathSync(path.resolve(__dirname, '../..')),
        currentPid: 99999,
        runner: async (command) => {
          if (command === '/bin/ps') {
            return {
              code: 0,
              stdout: '126 node archive-worker/index.js sync\n',
              stderr: '',
            };
          }
          throw lsofFailure;
        },
      })
    ).rejects.toMatchObject({
      code: 'GMAIL_LIVE_REPAIR_PROCESS_STATE_AMBIGUOUS',
      cause: lsofFailure,
    });
  });

  test('requires a proven absence of archive database handles', async () => {
    await expect(
      inspectArchiveDatabaseOpenHandles({
        liveRoot,
        runner: () => ({ code: 1, stdout: '', stderr: '' }),
      })
    ).resolves.toEqual({ open: false, matchingProcessCount: 0 });

    await expect(
      inspectArchiveDatabaseOpenHandles({
        liveRoot,
        runner: () => ({
          code: 0,
          stdout: 'p123\nf3\narchive.sqlite3-shm\n',
          stderr: '',
        }),
      })
    ).rejects.toThrow('GMAIL_LIVE_REPAIR_EXTERNAL_DATABASE_HANDLE_ACTIVE');

    await expect(
      inspectArchiveDatabaseOpenHandles({
        liveRoot,
        runner: () => ({ code: 2, stdout: '', stderr: 'failed' }),
      })
    ).rejects.toThrow('GMAIL_LIVE_REPAIR_DATABASE_HANDLES_AMBIGUOUS');
  });

  test('quiescence requires no process and no pre-existing lock', async () => {
    const schedulerInspector = async () => ({
      label: ARCHIVE_LAUNCHD_LABEL,
      loaded: false,
      persistentlyDisabled: true,
    });
    const processInspector = async () => ({
      running: false,
      matchingProcessCount: 0,
    });
    const databaseHandleInspector = () => ({
      open: false,
      matchingProcessCount: 0,
    });
    await expect(
      assertLiveServiceQuiesced({
        liveRoot,
        schedulerInspector,
        processInspector,
        databaseHandleInspector,
      })
    ).resolves.toEqual(
      expect.objectContaining({ worker: { lockPresent: false } })
    );

    fs.writeFileSync(path.join(liveRoot, 'worker.lock'), '{}', { mode: 0o600 });
    await expect(
      assertLiveServiceQuiesced({
        liveRoot,
        schedulerInspector,
        processInspector,
        databaseHandleInspector,
      })
    ).rejects.toThrow('GMAIL_LIVE_REPAIR_WORKER_LOCK_PRESENT');
  });

  test('never overwrites or deletes a pre-existing private plan', async () => {
    const planPath = path.join(root, 'private-plan.json');
    const original = Buffer.from('{"owner":"existing"}\n', 'utf8');
    fs.writeFileSync(planPath, original, { mode: 0o600 });

    await expect(
      writePrivateJsonExclusive(planPath, { replacement: true })
    ).rejects.toThrow('GMAIL_LIVE_REPAIR_PLAN_EXISTS');
    expect(fs.readFileSync(planPath)).toEqual(original);
    expect(fs.statSync(planPath).mode & 0o777).toBe(0o600);
  });

  test('writes owner approval only for the explicitly reviewed immutable digest', async () => {
    const generatedAt = '2026-08-02T12:00:00.000Z';
    const repairPlan = { ownerApprovalRecorded: false, generatedAt };
    const envelope = {
      schemaVersion: LIVE_PLAN_SCHEMA_VERSION,
      kind: LIVE_PLAN_KIND,
      migrationId: GMAIL_PARTITION_REPAIR_ID,
      generatedAt,
      liveRootDigest: 'a'.repeat(64),
      sourceSchemaVersion: 7,
      targetSchemaVersion: TARGET_REPAIR_SCHEMA_VERSION,
      sourceBackup: {},
      preRepairRestoreReceipt: { receiptDigest: 'b'.repeat(64) },
      anchorDatabaseSha256: 'c'.repeat(64),
      planDigest: partitionRepairPlanDigest(repairPlan),
      preconditionDigest: 'd'.repeat(64),
      repairPlan,
    };
    envelope.envelopeDigest = livePlanEnvelopeDigest(envelope);
    const planPath = path.join(root, 'reviewed-plan.json');
    const approvalPath = path.join(root, 'owner-approval.json');
    fs.writeFileSync(planPath, `${JSON.stringify(envelope)}\n`, {
      mode: 0o600,
    });

    const report = await createLiveRepairOwnerApproval({
      planInputPath: planPath,
      cloneDatabasePath: path.join(root, 'clone.sqlite3'),
      approvalOutputPath: approvalPath,
      approvedPlanDigest: envelope.planDigest,
      confirmation: OWNER_APPROVAL_CONFIRMATION,
      approvalId: 'owner-approval:synthetic-001',
      liveArchiveRoot: liveRoot,
      repositoryRoot: path.resolve(__dirname, '../..'),
      cloneReceiptReader: async () => ({
        code: 'GMAIL_REHEARSAL_APPLIED_AND_VERIFIED',
        appliedToClone: true,
        secondInvocationNoOp: true,
        planDigest: envelope.planDigest,
        preconditionDigest: envelope.preconditionDigest,
        postStateDigest: 'e'.repeat(64),
      }),
      nowFn: () => Date.parse('2026-08-02T12:01:00.000Z'),
    });
    expect(report).toEqual(
      expect.objectContaining({
        code: 'GMAIL_LIVE_REPAIR_OWNER_APPROVAL_RECORDED',
        approved: true,
        planDigest: envelope.planDigest,
      })
    );
    expect(fs.statSync(approvalPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(approvalPath, 'utf8'))).toEqual(
      expect.objectContaining({
        approved: true,
        approvalRole: 'archive-owner',
        planDigest: envelope.planDigest,
        cloneRehearsal: expect.objectContaining({
          secondInvocationNoOp: true,
        }),
      })
    );

    const rejectedPath = path.join(root, 'rejected-approval.json');
    await expect(
      createLiveRepairOwnerApproval({
        planInputPath: planPath,
        cloneDatabasePath: path.join(root, 'clone.sqlite3'),
        approvalOutputPath: rejectedPath,
        approvedPlanDigest: 'f'.repeat(64),
        confirmation: OWNER_APPROVAL_CONFIRMATION,
        liveArchiveRoot: liveRoot,
      })
    ).rejects.toThrow('GMAIL_LIVE_REPAIR_OWNER_APPROVAL_DIGEST_MISMATCH');
    expect(fs.existsSync(rejectedPath)).toBe(false);

    await expect(
      createLiveRepairOwnerApproval({
        planInputPath: planPath,
        cloneDatabasePath: path.join(root, 'clone.sqlite3'),
        approvalOutputPath: rejectedPath,
        approvedPlanDigest: envelope.planDigest,
        confirmation: OWNER_APPROVAL_CONFIRMATION,
        liveArchiveRoot: liveRoot,
        cloneReceiptReader: async () => ({
          code: 'GMAIL_REHEARSAL_APPLIED_AND_VERIFIED',
          appliedToClone: true,
          secondInvocationNoOp: true,
          planDigest: '0'.repeat(64),
          preconditionDigest: envelope.preconditionDigest,
          postStateDigest: 'e'.repeat(64),
        }),
      })
    ).rejects.toThrow('GMAIL_LIVE_REPAIR_CLONE_PLAN_DIGEST_MISMATCH');
    expect(fs.existsSync(rejectedPath)).toBe(false);
  });

  test.each(['vitasci-outlook', 'gmail-ablative', 'gmail-personal'])(
    'requires the explicit expected identity for %s',
    (accountId) => {
      const config = explicitConfig(liveRoot);
      config.accounts.find(
        (account) => account.id === accountId
      ).expectedIdentity = '';
      expect(() => assertExplicitIdentityConfiguration(config)).toThrow(
        'GMAIL_LIVE_REPAIR_IDENTITY_CONFIG_INVALID'
      );
    }
  );

  test('migrates schema 7 through 11 only inside its caller transaction', () => {
    const database = new SqliteDatabase(path.join(liveRoot, 'archive.sqlite3'));
    const outer = database.transaction(() =>
      applyPendingRepairMigrations(database)
    );
    expect(outer()).toEqual({ before: 7, after: 11, applied: [8, 9, 10, 11] });
    expect(currentSchemaVersion(database)).toBe(11);
    database.close();
  });

  test('rolls schema and content back together when nested repair work fails', () => {
    const database = new SqliteDatabase(path.join(liveRoot, 'archive.sqlite3'));
    const beforeAccounts = database
      .prepare('SELECT COUNT(*) AS count FROM accounts')
      .get().count;
    const nestedRepair = database.transaction(() => {
      database
        .prepare(
          `INSERT INTO accounts(
             id, provider, display_name, enabled, created_at, updated_at
           ) VALUES ('should-roll-back', 'gmail', 'fixture', 0, ?, ?)`
        )
        .run('2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z');
      throw new Error('INDUCED_REPAIR_FAILURE');
    });
    const outer = database.transaction(() => {
      applyPendingRepairMigrations(database);
      nestedRepair();
    });

    expect(outer).toThrow('INDUCED_REPAIR_FAILURE');
    expect(currentSchemaVersion(database)).toBe(7);
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM accounts').get().count
    ).toBe(beforeAccounts);
    expect(
      database
        .prepare(
          `SELECT 1 FROM sqlite_schema
           WHERE type = 'table'
             AND name = 'identity_partition_repair_receipts'`
        )
        .get()
    ).toBeUndefined();
    database.close();
  });

  test('runs the exact synthetic plan, clone rehearsal, approval, and live apply path', async () => {
    const fixture = await prepareExactOperatorPlan({ liveRoot, root });
    expect(fixture.planReport).toEqual(
      expect.objectContaining({
        code: 'GMAIL_LIVE_REPAIR_PLAN_VERIFIED',
        archiveDatabaseWritten: false,
        lockAcquired: false,
        sourceSchemaVersion: 7,
        targetSchemaVersion: 11,
        derivedStateToReset: { folders: 0, syncCursors: 0 },
      })
    );
    expect(fixture.after.sha256).toBe(fixture.before.sha256);
    expect(fixture.after.stat.ino).toBe(fixture.before.stat.ino);
    expect(fixture.after.stat.mtimeNs).toBe(fixture.before.stat.mtimeNs);
    if (NODE_SQLITE_SUPPORTED) {
      expect(fs.existsSync(`${fixture.evidence.liveDatabasePath}-wal`)).toBe(
        false
      );
      expect(fs.existsSync(`${fixture.evidence.liveDatabasePath}-shm`)).toBe(
        false
      );
    }
    const ReadOnlyDatabase = NODE_SQLITE_SUPPORTED
      ? ImmutableSqliteDatabase
      : SqliteDatabase;
    const plannedDatabase = new ReadOnlyDatabase(
      fixture.evidence.liveDatabasePath,
      { readonly: true, fileMustExist: true }
    );
    expect(currentSchemaVersion(plannedDatabase)).toBe(7);
    plannedDatabase.close();
    expect(fixture.buildProviders.identityStatusBuilder).toHaveBeenCalledTimes(
      1
    );
    expect(fixture.buildProviders.gmailProviderFactory).toHaveBeenCalledTimes(
      2
    );

    const applyProviders = providerHarness(
      fixture.config,
      fixture.evidence.inventories,
      new Date(OPERATOR_NOW + 120_000).toISOString()
    );
    const result = await applyLiveGmailPartitionRepair(
      operatorApplyArguments(fixture, applyProviders)
    );
    expect(result).toEqual(
      expect.objectContaining({
        code: 'GMAIL_LIVE_REPAIR_APPLIED_AND_VERIFIED',
        applied: true,
        schemaBefore: 7,
        schemaAfter: 11,
        schemaMigrationsApplied: [8, 9, 10, 11],
        secondInvocationNoOp: true,
        durableReceiptVerified: true,
        automaticReconciliation: false,
        automaticSchedulerResume: false,
        automaticBackup: false,
      })
    );
    expect(applyProviders.identityStatusBuilder).toHaveBeenCalledTimes(1);
    expect(applyProviders.gmailProviderFactory).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(liveRoot, 'worker.lock'))).toBe(false);

    const repaired = new SqliteDatabase(fixture.evidence.liveDatabasePath, {
      readonly: true,
      fileMustExist: true,
    });
    expect(currentSchemaVersion(repaired)).toBe(11);
    expect(
      repaired
        .prepare(
          `SELECT COUNT(*) AS count
           FROM identity_partition_repair_receipts
           WHERE migration_id = ?`
        )
        .get(GMAIL_PARTITION_REPAIR_ID).count
    ).toBe(1);
    expect(repairGmailPartitions(repaired)).toEqual(
      expect.objectContaining({ status: 'already_applied', applied: false })
    );
    repaired.close();
  });

  test('rolls schema and archive content back to version 7 after an induced core failure', async () => {
    const fixture = await prepareExactOperatorPlan({ liveRoot, root });
    const ReadOnlyDatabase = NODE_SQLITE_SUPPORTED
      ? ImmutableSqliteDatabase
      : SqliteDatabase;
    const before = new ReadOnlyDatabase(fixture.evidence.liveDatabasePath, {
      readonly: true,
      fileMustExist: true,
    });
    const beforeMessages = before
      .prepare(
        `SELECT id, account_id, provider_message_id, current_eligible,
                deleted_remote, last_seen_at, updated_at
         FROM messages ORDER BY id`
      )
      .all();
    before.close();
    const applyProviders = providerHarness(
      fixture.config,
      fixture.evidence.inventories,
      new Date(OPERATOR_NOW + 120_000).toISOString()
    );
    const repairImpl = jest.fn(() => {
      throw new Error('INDUCED_CORE_REPAIR_FAILURE');
    });

    await expect(
      applyLiveGmailPartitionRepair(
        operatorApplyArguments(fixture, applyProviders, { repairImpl })
      )
    ).rejects.toThrow('GMAIL_LIVE_REPAIR_TRANSACTION_ROLLED_BACK');
    expect(repairImpl).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(liveRoot, 'worker.lock'))).toBe(false);

    const rolledBack = new SqliteDatabase(fixture.evidence.liveDatabasePath, {
      readonly: true,
      fileMustExist: true,
    });
    expect(currentSchemaVersion(rolledBack)).toBe(7);
    expect(
      rolledBack
        .prepare(
          `SELECT id, account_id, provider_message_id, current_eligible,
                  deleted_remote, last_seen_at, updated_at
           FROM messages ORDER BY id`
        )
        .all()
    ).toEqual(beforeMessages);
    expect(
      rolledBack
        .prepare(
          `SELECT 1 FROM sqlite_schema
           WHERE type = 'table'
             AND name = 'identity_partition_repair_receipts'`
        )
        .get()
    ).toBeUndefined();
    rolledBack.close();
  });

  test('rejects hand-crafted clone digest approval before acquiring a live lock', async () => {
    const fixture = await prepareExactOperatorPlan({ liveRoot, root });
    const approval = JSON.parse(
      fs.readFileSync(fixture.approvalOutputPath, 'utf8')
    );
    approval.cloneRehearsal.planDigest = '0'.repeat(64);
    writeOwnerOnlyJson(fixture.approvalOutputPath, approval);
    const applyProviders = providerHarness(
      fixture.config,
      fixture.evidence.inventories,
      new Date(OPERATOR_NOW + 120_000).toISOString()
    );
    const lockConstructed = jest.fn();
    class ObservedLock {
      constructor() {
        lockConstructed();
      }
    }

    await expect(
      applyLiveGmailPartitionRepair(
        operatorApplyArguments(fixture, applyProviders, {
          LockImpl: ObservedLock,
        })
      )
    ).rejects.toThrow('GMAIL_PARTITION_REPAIR_OWNER_APPROVAL_REQUIRED');
    expect(lockConstructed).not.toHaveBeenCalled();
    expect(applyProviders.identityStatusBuilder).not.toHaveBeenCalled();
  });

  test('detects backup evidence drift before constructing the live lock', async () => {
    const fixture = await prepareExactOperatorPlan({ liveRoot, root });
    const marker = JSON.parse(
      fs.readFileSync(fixture.evidence.backupMarkerPath, 'utf8')
    );
    marker.snapshotId = 'drifted-restic-snapshot';
    writeOwnerOnlyJson(fixture.evidence.backupMarkerPath, marker);
    const applyProviders = providerHarness(
      fixture.config,
      fixture.evidence.inventories,
      new Date(OPERATOR_NOW + 120_000).toISOString()
    );
    const lockConstructed = jest.fn();
    class ObservedLock {
      constructor() {
        lockConstructed();
      }
    }

    await expect(
      applyLiveGmailPartitionRepair(
        operatorApplyArguments(fixture, applyProviders, {
          LockImpl: ObservedLock,
        })
      )
    ).rejects.toThrow('GMAIL_LIVE_REPAIR_RESTORE_RECEIPT_INVALID');
    expect(lockConstructed).not.toHaveBeenCalled();
    expect(applyProviders.identityStatusBuilder).not.toHaveBeenCalled();
  });
});
