const crypto = require('crypto');
const fs = require('fs');
const { createRequire } = require('module');
const path = require('path');
const archiveRequire = createRequire(
  path.resolve(__dirname, '../../archive-worker/rehearsal-test-loader.js')
);
const SqliteDatabase = archiveRequire('better-sqlite3');
const {
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
  verifyCloneBlobManifest,
} = require('../../archive-worker/rehearse-gmail-partition-repair');
const {
  partitionRepairPlanDigest,
} = require('../../archive-worker/repair-gmail-partitions');

function safeIdentityStatus(logicalAccountId, credentialSlot) {
  return {
    logicalAccountId,
    credentialSlot,
    expectedIdentityConfigured: true,
    identityMatch: true,
    verifiedAt: new Date().toISOString(),
    errorCode: null,
  };
}

describe('Gmail partition clone rehearsal operator surface', () => {
  let root;
  let cloneRoot;
  let liveRoot;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join('/tmp', 'gmail-rehearsal-command-'));
    cloneRoot = path.join(root, 'clone');
    liveRoot = path.join(root, 'live');
    fs.mkdirSync(cloneRoot);
    fs.mkdirSync(liveRoot);
    fs.mkdirSync(path.join(cloneRoot, 'raw-messages'));
    fs.mkdirSync(path.join(cloneRoot, 'attachments'));
    fs.writeFileSync(path.join(cloneRoot, 'archive.sqlite3'), 'fixture');
    fs.writeFileSync(path.join(cloneRoot, 'manifest.json'), '{}');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('accepts only a complete temporary clone distinct from the live root', () => {
    expect(assertTemporaryCloneRoot(cloneRoot, liveRoot)).toEqual({
      cloneRoot: fs.realpathSync(cloneRoot),
      databasePath: path.join(fs.realpathSync(cloneRoot), 'archive.sqlite3'),
      manifestPath: path.join(fs.realpathSync(cloneRoot), 'manifest.json'),
    });
    expect(() => assertTemporaryCloneRoot(liveRoot, liveRoot)).toThrow(
      'GMAIL_REHEARSAL_CLONE_PATH_UNSAFE'
    );
  });

  test.each([
    'EMAIL_ARCHIVE_OUTLOOK_EXPECTED_IDENTITY',
    'EMAIL_ARCHIVE_GMAIL_ABLATIVE_EXPECTED_IDENTITY',
    'EMAIL_ARCHIVE_GMAIL_PERSONAL_EXPECTED_IDENTITY',
  ])('requires the explicit archive identity key %s', (key) => {
    expect(() =>
      assertConfiguredTarget({}, key, 'expected@example.invalid')
    ).toThrow('GMAIL_REHEARSAL_IDENTITY_CONFIG_MISSING');
    expect(() =>
      assertConfiguredTarget(
        { [key]: 'other@example.invalid' },
        key,
        'expected@example.invalid'
      )
    ).toThrow('GMAIL_REHEARSAL_IDENTITY_CONFIG_CONFLICT');
    expect(
      assertConfiguredTarget(
        { [key]: 'EXPECTED@example.invalid' },
        key,
        'expected@example.invalid'
      )
    ).toBe(true);
  });

  test('rejects a symlinked clone database and non-empty WAL state', () => {
    const cloneDatabase = path.join(cloneRoot, 'archive.sqlite3');
    const liveDatabase = path.join(liveRoot, 'archive.sqlite3');
    fs.writeFileSync(liveDatabase, 'live fixture');
    fs.rmSync(cloneDatabase);
    fs.symlinkSync(liveDatabase, cloneDatabase);
    expect(() => assertTemporaryCloneRoot(cloneRoot, liveRoot)).toThrow(
      'GMAIL_REHEARSAL_CLONE_INCOMPLETE'
    );

    fs.rmSync(cloneDatabase);
    fs.writeFileSync(cloneDatabase, 'clone fixture');
    fs.writeFileSync(`${cloneDatabase}-wal`, 'uncheckpointed change');
    expect(() => assertTemporaryCloneRoot(cloneRoot, liveRoot)).toThrow(
      'GMAIL_REHEARSAL_CLONE_DATABASE_UNSTABLE'
    );
  });

  test('rejects a clone database hard-linked to the live archive inode', () => {
    const cloneDatabase = path.join(cloneRoot, 'archive.sqlite3');
    const liveDatabase = path.join(liveRoot, 'archive.sqlite3');
    fs.writeFileSync(liveDatabase, 'live database fixture');
    fs.rmSync(cloneDatabase);
    fs.linkSync(liveDatabase, cloneDatabase);

    expect(() => assertTemporaryCloneRoot(cloneRoot, liveRoot)).toThrow(
      'GMAIL_REHEARSAL_CLONE_HARDLINK_UNSAFE'
    );
  });

  test('requires blob content to be physically contained in the verified clone', () => {
    expect(assertCloneContentRoot(fs.realpathSync(cloneRoot), cloneRoot)).toBe(
      fs.realpathSync(cloneRoot)
    );
    expect(() =>
      assertCloneContentRoot(fs.realpathSync(cloneRoot), liveRoot)
    ).toThrow('GMAIL_REHEARSAL_CONTENT_ROOT_MISMATCH');

    fs.rmSync(path.join(cloneRoot, 'raw-messages'), {
      recursive: true,
      force: true,
    });
    fs.symlinkSync(
      path.join(liveRoot, 'raw-messages'),
      path.join(cloneRoot, 'raw-messages')
    );
    expect(() =>
      assertCloneContentRoot(fs.realpathSync(cloneRoot), cloneRoot)
    ).toThrow('GMAIL_REHEARSAL_CLONE_CONTENT_INCOMPLETE');
  });

  test('constrains plan output to a regular JSON file in the verified clone', () => {
    const resolvedClone = fs.realpathSync(cloneRoot);
    expect(resolvePlanOutputPath(resolvedClone)).toBe(
      path.join(resolvedClone, 'gmail-partition-repair-plan.json')
    );
    expect(() =>
      resolvePlanOutputPath(resolvedClone, path.join(liveRoot, 'plan.json'))
    ).toThrow('GMAIL_REHEARSAL_PLAN_PATH_UNSAFE');
    expect(() =>
      resolvePlanOutputPath(
        resolvedClone,
        path.join(resolvedClone, 'manifest.json')
      )
    ).toThrow('GMAIL_REHEARSAL_PLAN_PATH_UNSAFE');
  });

  test('accepts only an owner-only immutable exact live plan envelope', async () => {
    const repairPlan = { ownerApprovalRecorded: false };
    const envelope = {
      schemaVersion: 1,
      kind: 'gmail-partition-live-repair-plan',
      planDigest: partitionRepairPlanDigest(repairPlan),
      preconditionDigest: 'a'.repeat(64),
      repairPlan,
    };
    envelope.envelopeDigest = crypto
      .createHash('sha256')
      .update(JSON.stringify(envelope))
      .digest('hex');
    const inputPath = path.join(root, 'exact-live-plan.json');
    fs.writeFileSync(inputPath, `${JSON.stringify(envelope)}\n`, {
      mode: 0o600,
    });
    await expect(readExactLivePlanEnvelope(inputPath)).resolves.toEqual(
      envelope
    );

    envelope.preconditionDigest = 'b'.repeat(64);
    fs.writeFileSync(inputPath, `${JSON.stringify(envelope)}\n`, {
      mode: 0o600,
    });
    await expect(readExactLivePlanEnvelope(inputPath)).rejects.toThrow(
      'GMAIL_REHEARSAL_PLAN_INPUT_INVALID'
    );
  });

  test('opens a dry-run clone read-only and enables query_only without WAL', () => {
    const databasePath = path.join(root, 'readonly.sqlite3');
    const writable = new SqliteDatabase(databasePath);
    writable.exec('CREATE TABLE fixture(value TEXT)');
    writable.prepare('INSERT INTO fixture(value) VALUES (?)').run('safe');
    writable.close();
    const before = crypto
      .createHash('sha256')
      .update(fs.readFileSync(databasePath))
      .digest('hex');

    const database = openCloneDatabase(SqliteDatabase, databasePath, false);
    expect(database.pragma('query_only', { simple: true })).toBe(1);
    expect(() =>
      database.prepare('INSERT INTO fixture(value) VALUES (?)').run('write')
    ).toThrow();
    database.close();

    const after = crypto
      .createHash('sha256')
      .update(fs.readFileSync(databasePath))
      .digest('hex');
    expect(after).toBe(before);
    expect(fs.existsSync(`${databasePath}-wal`)).toBe(false);
    expect(fs.existsSync(`${databasePath}-shm`)).toBe(false);
  });

  test('opens a WAL-mode anchor immutably without creating sidecars', () => {
    const databasePath = path.join(root, 'immutable-anchor.sqlite3');
    const writable = new SqliteDatabase(databasePath);
    writable.pragma('journal_mode = WAL');
    writable.exec('CREATE TABLE fixture(value TEXT)');
    writable.prepare('INSERT INTO fixture(value) VALUES (?)').run('safe');
    writable.pragma('wal_checkpoint(TRUNCATE)');
    writable.close();
    for (const suffix of ['-wal', '-shm']) {
      fs.rmSync(`${databasePath}${suffix}`, { force: true });
    }
    const before = fs.statSync(databasePath, { bigint: true });

    const database = openAnchorDatabase(databasePath);
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

  test('uses writable WAL settings only for an explicitly confirmed apply path', () => {
    const opened = [];
    class FakeDatabase {
      constructor(databasePath, options) {
        this.databasePath = databasePath;
        this.options = options;
        this.pragmas = [];
        opened.push(this);
      }

      pragma(value) {
        this.pragmas.push(value);
      }
    }

    openCloneDatabase(FakeDatabase, '/tmp/clone.sqlite3', true);
    expect(opened[0].options).toEqual({
      readonly: false,
      fileMustExist: true,
    });
    expect(opened[0].pragmas).toContain('journal_mode = WAL');
    expect(opened[0].pragmas).toContain('synchronous = FULL');
    expect(opened[0].pragmas).not.toContain('query_only = ON');
  });

  test('hash-verifies the anchor database against its manifest', async () => {
    const anchorPath = path.join(root, 'anchor.sqlite3');
    const manifestPath = path.join(root, 'anchor-manifest.json');
    const bytes = Buffer.from('immutable synthetic anchor');
    fs.writeFileSync(anchorPath, bytes);
    const databaseSha256 = crypto
      .createHash('sha256')
      .update(bytes)
      .digest('hex');
    fs.writeFileSync(manifestPath, JSON.stringify({ databaseSha256 }));

    await expect(
      readVerifiedAnchorManifest(anchorPath, manifestPath)
    ).resolves.toEqual({ databaseSha256 });
    fs.writeFileSync(anchorPath, Buffer.from('changed anchor'));
    await expect(
      readVerifiedAnchorManifest(anchorPath, manifestPath)
    ).rejects.toThrow('GMAIL_REHEARSAL_ANCHOR_DATABASE_HASH_MISMATCH');
  });

  test('refuses an anchor database with uncheckpointed WAL content', async () => {
    const anchorPath = path.join(root, 'anchor-with-wal.sqlite3');
    const manifestPath = path.join(root, 'anchor-with-wal-manifest.json');
    const bytes = Buffer.from('immutable synthetic anchor');
    fs.writeFileSync(anchorPath, bytes);
    fs.writeFileSync(`${anchorPath}-wal`, 'not checkpointed');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        databaseSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      })
    );

    await expect(
      readVerifiedAnchorManifest(anchorPath, manifestPath)
    ).rejects.toThrow('GMAIL_REHEARSAL_ANCHOR_DATABASE_UNSTABLE');
  });

  test.each(['-wal', '-shm'])(
    'refuses an anchor database with an empty %s sidecar',
    async (suffix) => {
      const anchorPath = path.join(
        root,
        `anchor-with-${suffix.slice(1)}.sqlite3`
      );
      const manifestPath = `${anchorPath}.manifest.json`;
      const bytes = Buffer.from('immutable synthetic anchor');
      fs.writeFileSync(anchorPath, bytes);
      fs.writeFileSync(`${anchorPath}${suffix}`, '');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          databaseSha256: crypto
            .createHash('sha256')
            .update(bytes)
            .digest('hex'),
        })
      );

      await expect(
        readVerifiedAnchorManifest(anchorPath, manifestPath)
      ).rejects.toThrow('GMAIL_REHEARSAL_ANCHOR_DATABASE_UNSTABLE');
    }
  );

  test('creates a new Outlook verifier for each independent proof', async () => {
    const account = {
      logicalAccountId: 'vitasci-outlook',
      credentialSlot: 'default-delegated',
    };
    const statuses = [
      safeIdentityStatus('vitasci-outlook', 'default-delegated'),
      safeIdentityStatus('vitasci-outlook', 'default-delegated'),
    ];
    const providers = statuses.map((status) => ({
      assertArchiveIdentity: jest.fn().mockResolvedValue(status),
    }));
    const factory = jest
      .fn()
      .mockReturnValueOnce(providers[0])
      .mockReturnValueOnce(providers[1]);

    await assertFreshOutlookIdentity(account, factory);
    await assertFreshOutlookIdentity(account, factory);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(providers[0].assertArchiveIdentity).toHaveBeenCalledTimes(1);
    expect(providers[1].assertArchiveIdentity).toHaveBeenCalledTimes(1);
  });

  test('reports explicit FTS ownership mismatch, missing, and orphan counts', () => {
    const database = new SqliteDatabase(':memory:');
    database.exec(`
      CREATE TABLE messages(id TEXT PRIMARY KEY, account_id TEXT NOT NULL);
      CREATE TABLE messages_fts(message_id TEXT, account_id TEXT NOT NULL);
      INSERT INTO messages VALUES ('matching', 'gmail-ablative');
      INSERT INTO messages VALUES ('mismatching', 'gmail-personal');
      INSERT INTO messages VALUES ('missing', 'gmail-personal');
      INSERT INTO messages_fts VALUES ('matching', 'gmail-ablative');
      INSERT INTO messages_fts VALUES ('matching', 'gmail-ablative');
      INSERT INTO messages_fts VALUES ('mismatching', 'gmail-ablative');
      INSERT INTO messages_fts VALUES ('orphan', 'gmail-personal');
    `);

    expect(ftsAccountConsistency(database)).toEqual({
      accountMismatches: 1,
      missingRows: 1,
      orphanRows: 1,
      duplicateRows: 1,
      messageRows: 3,
      ftsRows: 4,
      passed: false,
    });
    database.close();
  });

  test('verifies every clone blob against the manifest and database inventory', async () => {
    const bytes = Buffer.from('synthetic restored raw message');
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const relativePath = path.join('raw-messages', hash.slice(0, 2), hash);
    fs.mkdirSync(path.dirname(path.join(cloneRoot, relativePath)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(cloneRoot, relativePath), bytes);
    const blobs = [
      {
        hash,
        kind: 'raw-message',
        relativePath,
        size: bytes.length,
      },
    ];
    const blobInventorySha256 = crypto
      .createHash('sha256')
      .update(JSON.stringify(blobs))
      .digest('hex');
    const manifest = {
      formatVersion: 1,
      blobCount: 1,
      blobInventorySha256,
      blobs,
    };
    const database = {
      prepare: jest.fn().mockReturnValue({
        all: jest.fn().mockReturnValue(blobs),
      }),
    };

    const progress = [];
    await expect(
      verifyCloneBlobManifest(database, cloneRoot, manifest, {
        onProgress: (event) => progress.push(event),
        progressEvery: 1,
      })
    ).resolves.toEqual({
      passed: true,
      verifiedBlobCount: 1,
      blobInventorySha256,
    });
    expect(progress.map((event) => event.phase)).toEqual([
      'clone_blob_verification_started',
      'clone_blob_verification_progress',
      'clone_blob_verification_completed',
    ]);
    expect(progress[1]).toEqual(
      expect.objectContaining({
        verifiedBlobs: 1,
        totalBlobs: 1,
        verifiedBytes: bytes.length,
      })
    );
    fs.writeFileSync(
      path.join(cloneRoot, relativePath),
      Buffer.from('same-size-corrupted-message!!')
    );
    await expect(
      verifyCloneBlobManifest(database, cloneRoot, manifest)
    ).rejects.toThrow('GMAIL_REHEARSAL_CLONE_BLOB_HASH_MISMATCH');
  });

  test('collects every provider page behind identity checks', async () => {
    const provider = {
      assertArchiveIdentity: jest
        .fn()
        .mockResolvedValue(safeIdentityStatus('gmail-ablative', 'personal')),
      listInventoryPage: jest
        .fn()
        .mockResolvedValueOnce({
          refs: [{ id: 'one' }],
          nextCursor: 'next-page',
          complete: false,
        })
        .mockResolvedValueOnce({
          refs: [{ id: 'two' }],
          nextCursor: null,
          complete: true,
        }),
    };

    const progress = [];
    const result = await collectProviderInventory(
      provider,
      {
        logicalAccountId: 'gmail-ablative',
      },
      { onProgress: (event) => progress.push(event) }
    );
    expect([...result.providerMessageIds]).toEqual(['one', 'two']);
    expect(provider.assertArchiveIdentity).toHaveBeenCalledTimes(2);
    expect(provider.listInventoryPage).toHaveBeenNthCalledWith(1, null, {
      pageSize: 500,
    });
    expect(provider.listInventoryPage).toHaveBeenNthCalledWith(2, 'next-page', {
      pageSize: 500,
    });
    expect(progress.map((event) => event.phase)).toEqual([
      'provider_inventory_started',
      'provider_inventory_page',
      'provider_inventory_page',
      'provider_inventory_completed',
    ]);
    expect(JSON.stringify(progress)).not.toContain('@');
  });

  test('requires the independently collected logical inventories to be disjoint', async () => {
    const accounts = [
      {
        logicalAccountId: 'gmail-ablative',
        credentialSlot: 'personal',
      },
      {
        logicalAccountId: 'gmail-personal',
        credentialSlot: 'ablative',
      },
    ];
    const providerFactory = (account) => ({
      assertArchiveIdentity: jest
        .fn()
        .mockResolvedValue(
          safeIdentityStatus(account.logicalAccountId, account.credentialSlot)
        ),
      listInventoryPage: jest.fn().mockResolvedValue({
        refs: [{ id: 'overlap' }],
        nextCursor: null,
        complete: true,
      }),
    });

    await expect(
      collectGmailInventories({ accounts, env: {}, providerFactory })
    ).rejects.toThrow('GMAIL_REHEARSAL_PROVIDER_INVENTORY_OVERLAP');
  });

  test('loads only the database-declared raw blob within the content root', () => {
    const rawRoot = path.join(root, 'content');
    const relativePath = path.join('raw-messages', 'aa', 'fixture');
    const content = Buffer.from('From: fixture\r\n\r\nbody');
    fs.mkdirSync(path.dirname(path.join(rawRoot, relativePath)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(rawRoot, relativePath), content);
    const database = {
      prepare: jest.fn().mockReturnValue({
        get: jest.fn().mockReturnValue({
          kind: 'raw-message',
          relative_path: relativePath,
          size: content.length,
        }),
      }),
    };

    expect(
      rawMessageLoader(database, rawRoot)({ raw_blob_hash: 'a'.repeat(64) })
    ).toEqual(content);
  });
});
