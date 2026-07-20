const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BackupManager, fileHash } = require('../../archive-worker/backup');
const { ArchiveService } = require('../../archive-worker/archive-service');
const { ArchiveDatabase } = require('../../archive-worker/database');
const { ContentStore } = require('../../archive-worker/storage');

describe('encrypted backup and restore', () => {
  let workspace;
  let archiveRoot;
  let repository;
  let database;
  let service;
  let manager;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'email-backup-test-'));
    archiveRoot = path.join(workspace, 'archive');
    repository = path.join(workspace, 'restic-repository');
    database = new ArchiveDatabase(path.join(archiveRoot, 'archive.sqlite3'));
    service = new ArchiveService({
      database,
      contentStore: new ContentStore(archiveRoot),
    });
    await service.initialise([
      {
        id: 'gmail-ablative',
        provider: 'gmail',
        displayName: 'Ablative Gmail',
      },
    ]);
    const archived = await service.stageMessage(
      'gmail-ablative',
      {
        providerMessageId: 'backup-fixture',
        subject: 'Backup verification fixture',
        bodyText: 'Synthetic content only',
        recipients: [],
        locations: [
          {
            providerLocationId: 'INBOX',
            displayName: 'Inbox',
            kind: 'inbox',
          },
        ],
        attachments: [
          {
            providerAttachmentId: 'fixture-attachment',
            fileName: 'fixture.bin',
          },
        ],
      },
      Buffer.from('Synthetic raw message')
    );
    await service.completeAttachment(
      archived.id,
      'fixture-attachment',
      Buffer.from('Synthetic attachment'),
      'application/octet-stream'
    );
    manager = new BackupManager({
      config: { root: archiveRoot, backupRepository: repository },
      database,
      passwordProvider: jest
        .fn()
        .mockResolvedValue('fixture-password-not-used-outside-tests'),
      resticPath: '/opt/homebrew/bin/restic',
    });
  });

  afterEach(async () => {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  test('creates a consistent SQLite snapshot and hash manifest', async () => {
    const snapshot = await manager.createSnapshot();
    expect(snapshot.manifest.tableCounts).toEqual({
      accounts: 1,
      messages: 1,
      attachments: 1,
      blobs: 2,
    });
    expect(await fileHash(snapshot.databasePath)).toBe(
      snapshot.manifest.databaseSha256
    );
    const snapshotDatabase = new ArchiveDatabase(snapshot.databasePath);
    expect(
      snapshotDatabase.db.pragma('integrity_check', { simple: true })
    ).toBe('ok');
    snapshotDatabase.close();
  });

  test('encrypts, deduplicates, restores and verifies a fixture archive', async () => {
    const first = await manager.backup();
    expect(await manager.isBackupDue()).toBe(false);
    expect(
      await manager.isBackupDue({
        now: Date.now() + 25 * 60 * 60 * 1000,
      })
    ).toBe(true);
    const second = await manager.backup();
    expect(first.repositoryCreated).toBe(true);
    expect(first.snapshotId).toBeTruthy();
    expect(second.repositoryCreated).toBe(false);
    expect(second.snapshotId).toBeTruthy();
    expect(second.dataAdded).toBeLessThan(first.dataAdded);

    const restoreTarget = path.join(workspace, 'restored');
    const restored = await manager.restore(restoreTarget);
    expect(restored).toEqual(
      expect.objectContaining({
        integrity: 'ok',
        databaseHashMatches: true,
        countsMatch: true,
        verifiedBlobCount: 2,
        failedHashes: [],
        ok: true,
      })
    );
  }, 30_000);
});
