const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const archiveRequire = createRequire(
  path.resolve(
    __dirname,
    '../../archive-worker/immutable-sqlite-test-loader.js'
  )
);
const SqliteDatabase = archiveRequire('better-sqlite3');
const {
  ImmutableSqliteDatabase,
} = require('../../archive-worker/immutable-sqlite');

const nodeMajor = Number(process.versions.node.split('.')[0]);
const describeWithNodeSqlite = nodeMajor >= 22 ? describe : describe.skip;

describeWithNodeSqlite('immutable SQLite safety adapter', () => {
  let root;
  let databasePath;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join('/tmp', 'immutable-sqlite-'));
    databasePath = path.join(root, 'archive.sqlite3');
    const database = new SqliteDatabase(databasePath);
    database.pragma('journal_mode = WAL');
    database.exec('CREATE TABLE fixture(value TEXT);');
    database.prepare('INSERT INTO fixture(value) VALUES (?)').run('safe');
    database.pragma('wal_checkpoint(TRUNCATE)');
    database.close();
    for (const suffix of ['-wal', '-shm']) {
      fs.rmSync(`${databasePath}${suffix}`, { force: true });
    }
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('reads a WAL-mode database without creating sidecars or changing metadata', () => {
    const before = fs.statSync(databasePath, { bigint: true });
    const database = new ImmutableSqliteDatabase(databasePath, {
      readonly: true,
      fileMustExist: true,
    });

    database.pragma('foreign_keys = ON');
    database.pragma('query_only = ON');
    expect(database.prepare('SELECT value FROM fixture').get().value).toBe(
      'safe'
    );
    expect(() =>
      database.prepare('INSERT INTO fixture(value) VALUES (?)').run('unsafe')
    ).toThrow();
    database.close();

    const after = fs.statSync(databasePath, { bigint: true });
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(fs.existsSync(`${databasePath}-wal`)).toBe(false);
    expect(fs.existsSync(`${databasePath}-shm`)).toBe(false);
  });

  test('fails closed when either sidecar path already exists', () => {
    fs.writeFileSync(`${databasePath}-wal`, '');
    expect(
      () =>
        new ImmutableSqliteDatabase(databasePath, {
          readonly: true,
          fileMustExist: true,
        })
    ).toThrow('IMMUTABLE_SQLITE_SIDECAR_PRESENT');
  });
});
