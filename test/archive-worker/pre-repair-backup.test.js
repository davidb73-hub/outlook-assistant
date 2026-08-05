const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const archiveRequire = createRequire(
  path.resolve(__dirname, '../../archive-worker/pre-repair-test-loader.js')
);
const SqliteDatabase = archiveRequire('better-sqlite3');
const { MIGRATIONS } = require('../../archive-worker/migrations');
const {
  ARCHIVE_LAUNCHD_LABEL,
} = require('../../archive-worker/live-gmail-partition-repair');
const {
  PRE_REPAIR_BACKUP_CONFIRMATION,
  createSchemaPreservingPreRepairBackup,
} = require('../../archive-worker/pre-repair-backup');
const {
  ImmutableSqliteDatabase,
} = require('../../archive-worker/immutable-sqlite');
const { readExistingSchemaVersion } = require('../../archive-worker/index');

const NODE_SQLITE_SUPPORTED = Number(process.versions.node.split('.')[0]) >= 22;
const TEST_READ_ONLY_DATABASE = NODE_SQLITE_SUPPORTED
  ? ImmutableSqliteDatabase
  : SqliteDatabase;

function createSchemaSevenDatabase(databasePath) {
  const database = new SqliteDatabase(databasePath);
  database.pragma('journal_mode = WAL');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  for (const migration of MIGRATIONS.filter(
    (candidate) => candidate.version <= 7
  )) {
    database.exec(migration.sql);
    database
      .prepare(
        `INSERT INTO schema_migrations(version, name, applied_at)
         VALUES (?, ?, ?)`
      )
      .run(migration.version, migration.name, '2026-08-02T00:00:00.000Z');
  }
  database
    .prepare(
      `INSERT INTO accounts(
         id, provider, display_name, enabled, created_at, updated_at
       ) VALUES ('gmail-ablative', 'gmail', 'Ablative', 1, ?, ?)`
    )
    .run('2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z');
  database.pragma('wal_checkpoint(TRUNCATE)');
  database.close();
  for (const suffix of ['-wal', '-shm']) {
    fs.rmSync(`${databasePath}${suffix}`, { force: true });
  }
}

function hash(filePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

describe('schema-preserving pre-repair encrypted backup', () => {
  let root;
  let liveRoot;
  let databasePath;
  let restoreTarget;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join('/tmp', 'pre-repair-backup-'));
    liveRoot = path.join(root, 'live');
    restoreTarget = path.join(root, 'restore');
    fs.mkdirSync(liveRoot);
    fs.mkdirSync(path.join(liveRoot, 'raw-messages'));
    fs.mkdirSync(path.join(liveRoot, 'attachments'));
    databasePath = path.join(liveRoot, 'archive.sqlite3');
    createSchemaSevenDatabase(databasePath);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('backs up and restores the exact snapshot without changing live schema or bytes', async () => {
    const beforeHash = hash(databasePath);
    const beforeStat = fs.statSync(databasePath, { bigint: true });
    const calls = [];
    const passwordCalls = [];
    const runner = jest.fn(async (_command, args) => {
      calls.push(args);
      if (args[0] === 'backup') {
        return {
          code: 0,
          stderr: '',
          stdout: `${JSON.stringify({
            message_type: 'summary',
            snapshot_id: 'schema7-snapshot-0001',
            files_new: 2,
            files_changed: 0,
            data_added: 1,
          })}\n`,
        };
      }
      if (args[0] === 'restore') {
        const target = args[args.indexOf('--target') + 1];
        fs.mkdirSync(path.join(target, 'snapshots'), { recursive: true });
        fs.cpSync(
          path.join(liveRoot, 'snapshots', 'current'),
          path.join(target, 'snapshots', 'current'),
          { recursive: true }
        );
        fs.cpSync(
          path.join(liveRoot, 'raw-messages'),
          path.join(target, 'raw-messages'),
          { recursive: true }
        );
        fs.cpSync(
          path.join(liveRoot, 'attachments'),
          path.join(target, 'attachments'),
          { recursive: true }
        );
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const config = {
      root: liveRoot,
      databasePath,
      manifestsDir: path.join(liveRoot, 'manifests'),
      backupRepository: 'rclone:synthetic:email-assistant-backup',
    };
    const receiptOutputPath = path.join(
      config.manifestsDir,
      'pre-repair-restore-schema7-snapshot-0001.json'
    );
    const report = await createSchemaPreservingPreRepairBackup({
      config,
      liveArchiveRoot: liveRoot,
      requiredLiveArchiveRoot: liveRoot,
      restoreTarget,
      receiptOutputPath,
      confirmation: PRE_REPAIR_BACKUP_CONFIRMATION,
      DatabaseImpl: TEST_READ_ONLY_DATABASE,
      schedulerInspector: async () => ({
        label: ARCHIVE_LAUNCHD_LABEL,
        loaded: false,
        persistentlyDisabled: true,
      }),
      processInspector: async () => ({
        running: false,
        matchingProcessCount: 0,
      }),
      databaseHandleInspector: () => ({
        open: false,
        matchingProcessCount: 0,
      }),
      backupManagerOptions: {
        runner,
        passwordProvider: async (options) => {
          passwordCalls.push(options);
          return 'synthetic-password';
        },
        resticPath: '/synthetic/restic',
      },
    });

    expect(report).toEqual(
      expect.objectContaining({
        code: 'PRE_REPAIR_BACKUP_AND_EXACT_RESTORE_VERIFIED',
        liveSchemaBefore: 7,
        liveSchemaAfter: 7,
        liveDatabaseHashUnchanged: true,
        exactSnapshotRestored: true,
        restoreReceiptWrittenOwnerOnly: true,
        restore: expect.objectContaining({
          snapshotId: 'schema7-snapshot-0001',
          restoredSchemaVersion: 7,
          disposableMigrationRecognizedThrough: 11,
          ok: true,
        }),
      })
    );
    expect(
      readExistingSchemaVersion(databasePath, TEST_READ_ONLY_DATABASE)
    ).toBe(7);
    expect(hash(databasePath)).toBe(beforeHash);
    const afterStat = fs.statSync(databasePath, { bigint: true });
    expect(afterStat.mtimeNs).toBe(beforeStat.mtimeNs);
    if (NODE_SQLITE_SUPPORTED) {
      expect(fs.existsSync(`${databasePath}-wal`)).toBe(false);
      expect(fs.existsSync(`${databasePath}-shm`)).toBe(false);
    }
    expect(fs.existsSync(path.join(liveRoot, 'worker.lock'))).toBe(false);
    expect(fs.statSync(receiptOutputPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(receiptOutputPath, 'utf8'))).toEqual(
      expect.objectContaining({
        exactSnapshotRestored: true,
        retainedRestoreMatchesManifest: true,
        liveSchemaUnchanged: true,
        receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    );
    const retainedManifest = JSON.parse(
      fs.readFileSync(
        path.join(restoreTarget, 'snapshots', 'current', 'manifest.json'),
        'utf8'
      )
    );
    expect(
      hash(path.join(restoreTarget, 'snapshots', 'current', 'archive.sqlite3'))
    ).toBe(retainedManifest.databaseSha256);
    expect(calls).toContainEqual([
      'restore',
      'schema7-snapshot-0001',
      '--target',
      fs.realpathSync(restoreTarget),
    ]);
    expect(calls.flat()).not.toContain('latest');
    expect(passwordCalls[0]).toEqual({ create: false });
  });

  test('missing existing backup password fails before snapshot or marker mutation', async () => {
    const config = {
      root: liveRoot,
      databasePath,
      manifestsDir: path.join(liveRoot, 'manifests'),
      backupRepository: 'rclone:synthetic:email-assistant-backup',
    };
    await expect(
      createSchemaPreservingPreRepairBackup({
        config,
        liveArchiveRoot: liveRoot,
        requiredLiveArchiveRoot: liveRoot,
        restoreTarget,
        receiptOutputPath: path.join(
          config.manifestsDir,
          'pre-repair-restore-missing-password.json'
        ),
        confirmation: PRE_REPAIR_BACKUP_CONFIRMATION,
        DatabaseImpl: TEST_READ_ONLY_DATABASE,
        schedulerInspector: async () => ({
          label: ARCHIVE_LAUNCHD_LABEL,
          loaded: false,
          persistentlyDisabled: true,
        }),
        processInspector: async () => ({
          running: false,
          matchingProcessCount: 0,
        }),
        databaseHandleInspector: () => ({
          open: false,
          matchingProcessCount: 0,
        }),
        backupManagerOptions: {
          runner: jest.fn(),
          passwordProvider: async ({ create }) => {
            expect(create).toBe(false);
            throw new Error('missing key');
          },
        },
      })
    ).rejects.toThrow('PRE_REPAIR_BACKUP_REPOSITORY_UNVERIFIED');
    expect(fs.existsSync(path.join(liveRoot, 'snapshots', 'current'))).toBe(
      false
    );
    expect(
      fs.existsSync(path.join(liveRoot, 'manifests', 'last-backup.json'))
    ).toBe(false);
    expect(fs.existsSync(path.join(liveRoot, 'worker.lock'))).toBe(false);
    expect(readExistingSchemaVersion(databasePath)).toBe(7);
  });

  test('requires explicit confirmation before creating a restore target or lock', async () => {
    await expect(
      createSchemaPreservingPreRepairBackup({
        config: { root: liveRoot },
        liveArchiveRoot: liveRoot,
        requiredLiveArchiveRoot: liveRoot,
        restoreTarget,
      })
    ).rejects.toThrow('PRE_REPAIR_BACKUP_CONFIRMATION_REQUIRED');
    expect(fs.existsSync(restoreTarget)).toBe(false);
    expect(fs.existsSync(path.join(liveRoot, 'worker.lock'))).toBe(false);
    expect(readExistingSchemaVersion(databasePath)).toBe(7);
  });
});
