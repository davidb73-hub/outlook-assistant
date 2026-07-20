const crypto = require('crypto');
const { createReadStream } = require('fs');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { ArchiveDatabase } = require('./database');
const { ContentStore, sha256 } = require('./storage');

const KEYCHAIN_SERVICE = 'Email Assistant Archive Restic';
const KEYCHAIN_ACCOUNT = 'email-assistant-archive';

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-1_000_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-100_000);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }
      const error = new Error(
        `${path.basename(command)} exited with code ${code}: ${stderr
          .trim()
          .slice(0, 1000)}`
      );
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function keychainPassword({ create = false, runner = runProcess } = {}) {
  try {
    const result = await runner(
      '/usr/bin/security',
      [
        'find-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        KEYCHAIN_ACCOUNT,
        '-w',
      ],
      { env: process.env }
    );
    return result.stdout.trim();
  } catch (error) {
    if (!create) {
      throw new Error(
        'The encrypted-backup password is missing from macOS Keychain. Run the backup command once to create it.',
        { cause: error }
      );
    }
  }

  const password = crypto.randomBytes(48).toString('base64url');
  await runner(
    '/usr/bin/security',
    [
      'add-generic-password',
      '-U',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      KEYCHAIN_ACCOUNT,
      '-w',
      password,
    ],
    { env: process.env }
  );
  return password;
}

async function fileHash(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

class BackupManager {
  constructor({
    config,
    database,
    runner = runProcess,
    passwordProvider = keychainPassword,
    resticPath = '/opt/homebrew/bin/restic',
  }) {
    this.config = config;
    this.database = database;
    this.runner = runner;
    this.passwordProvider = passwordProvider;
    this.resticPath = resticPath;
  }

  markerPath() {
    return path.join(
      this.config.manifestsDir || path.join(this.config.root, 'manifests'),
      'last-backup.json'
    );
  }

  async isBackupDue({
    now = Date.now(),
    intervalMs = 24 * 60 * 60 * 1000,
  } = {}) {
    try {
      const marker = JSON.parse(await fs.readFile(this.markerPath(), 'utf8'));
      const completedAt = new Date(marker.completedAt).getTime();
      return !Number.isFinite(completedAt) || now - completedAt >= intervalMs;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return true;
      throw error;
    }
  }

  async writeBackupMarker(summary) {
    const markerPath = this.markerPath();
    await fs.mkdir(path.dirname(markerPath), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${markerPath}.tmp`;
    await fs.writeFile(
      temporary,
      `${JSON.stringify(
        {
          completedAt: new Date().toISOString(),
          snapshotId: summary.snapshotId,
          tableCounts: summary.manifest.tableCounts,
          blobCount: summary.manifest.blobCount,
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
    await fs.rename(temporary, markerPath);
    await fs.chmod(markerPath, 0o600);
  }

  async createSnapshot() {
    const snapshotRoot = path.join(this.config.root, 'snapshots', 'current');
    await fs.rm(snapshotRoot, { recursive: true, force: true });
    await fs.mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
    const databasePath = path.join(snapshotRoot, 'archive.sqlite3');
    await this.database.db.backup(databasePath);
    await fs.chmod(databasePath, 0o600);

    const blobs = this.database.listBlobs();
    const tableCounts = {};
    for (const table of ['accounts', 'messages', 'attachments', 'blobs']) {
      tableCounts[table] = this.database.db
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get().count;
    }
    const blobInventory = blobs.map((blob) => ({
      hash: blob.hash,
      kind: blob.kind,
      relativePath: blob.relative_path,
      size: blob.size,
    }));
    const manifest = {
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      databaseSha256: await fileHash(databasePath),
      tableCounts,
      blobCount: blobInventory.length,
      blobInventorySha256: sha256(
        Buffer.from(JSON.stringify(blobInventory), 'utf8')
      ),
      blobs: blobInventory,
    };
    const manifestPath = path.join(snapshotRoot, 'manifest.json');
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    return { snapshotRoot, databasePath, manifestPath, manifest };
  }

  resticEnvironment(password) {
    return {
      ...process.env,
      RESTIC_REPOSITORY: this.config.backupRepository,
      RESTIC_PASSWORD: password,
      RESTIC_CACHE_DIR: path.join(this.config.root, 'cache', 'restic'),
    };
  }

  async ensureRepository(password) {
    await fs.mkdir(path.join(this.config.root, 'cache', 'restic'), {
      recursive: true,
      mode: 0o700,
    });
    const configPath = path.join(this.config.backupRepository, 'config');
    try {
      await fs.access(configPath);
      return false;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.mkdir(this.config.backupRepository, {
      recursive: true,
      mode: 0o700,
    });
    await this.runner(this.resticPath, ['init'], {
      cwd: this.config.root,
      env: this.resticEnvironment(password),
    });
    return true;
  }

  async backup() {
    const password = await this.passwordProvider({ create: true });
    const repositoryCreated = await this.ensureRepository(password);
    const snapshot = await this.createSnapshot();
    const result = await this.runner(
      this.resticPath,
      [
        'backup',
        '--json',
        '--tag',
        'email-assistant-archive',
        'snapshots/current/archive.sqlite3',
        'snapshots/current/manifest.json',
        'raw-messages',
        'attachments',
      ],
      {
        cwd: this.config.root,
        env: this.resticEnvironment(password),
      }
    );
    await this.runner(this.resticPath, ['check'], {
      cwd: this.config.root,
      env: this.resticEnvironment(password),
    });
    const summary = result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((item) => item?.message_type === 'summary');
    const backupSummary = {
      repositoryCreated,
      snapshotId: summary?.snapshot_id || null,
      filesNew: summary?.files_new || 0,
      filesChanged: summary?.files_changed || 0,
      dataAdded: summary?.data_added || 0,
      manifest: {
        formatVersion: snapshot.manifest.formatVersion,
        createdAt: snapshot.manifest.createdAt,
        databaseSha256: snapshot.manifest.databaseSha256,
        tableCounts: snapshot.manifest.tableCounts,
        blobCount: snapshot.manifest.blobCount,
        blobInventorySha256: snapshot.manifest.blobInventorySha256,
      },
    };
    await this.writeBackupMarker(backupSummary);
    return backupSummary;
  }

  async snapshots() {
    const password = await this.passwordProvider({ create: false });
    const result = await this.runner(this.resticPath, ['snapshots', '--json'], {
      cwd: this.config.root,
      env: this.resticEnvironment(password),
    });
    return JSON.parse(result.stdout || '[]');
  }

  async restore(target) {
    const resolvedTarget = path.resolve(target);
    const existing = await fs.readdir(resolvedTarget).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (existing.length > 0) {
      throw new Error('Restore target must be an empty directory');
    }
    await fs.mkdir(resolvedTarget, { recursive: true, mode: 0o700 });
    const password = await this.passwordProvider({ create: false });
    await this.runner(
      this.resticPath,
      ['restore', 'latest', '--target', resolvedTarget],
      {
        cwd: this.config.root,
        env: this.resticEnvironment(password),
      }
    );
    return this.verifyRestore(resolvedTarget);
  }

  async verifyRestore(target) {
    const resolvedTarget = path.resolve(target);
    const manifestPath = path.join(
      resolvedTarget,
      'snapshots',
      'current',
      'manifest.json'
    );
    const databasePath = path.join(
      resolvedTarget,
      'snapshots',
      'current',
      'archive.sqlite3'
    );
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const databaseHashMatches =
      (await fileHash(databasePath)) === manifest.databaseSha256;
    const restoredDatabase = new ArchiveDatabase(databasePath);
    let integrity;
    const counts = {};
    try {
      integrity = restoredDatabase.db.pragma('integrity_check', {
        simple: true,
      });
      for (const table of ['accounts', 'messages', 'attachments', 'blobs']) {
        counts[table] = restoredDatabase.db
          .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
          .get().count;
      }
    } finally {
      restoredDatabase.close();
    }
    const contentStore = new ContentStore(resolvedTarget);
    const failedHashes = [];
    for (const blob of manifest.blobs) {
      if (
        !(await contentStore.verify({
          hash: blob.hash,
          relativePath: blob.relativePath,
          size: blob.size,
        }))
      ) {
        failedHashes.push(blob.hash);
      }
    }
    const countsMatch = Object.entries(manifest.tableCounts).every(
      ([table, count]) => counts[table] === count
    );
    return {
      target: resolvedTarget,
      integrity,
      databaseHashMatches,
      countsMatch,
      verifiedBlobCount: manifest.blobs.length - failedHashes.length,
      failedHashes,
      ok:
        integrity === 'ok' &&
        databaseHashMatches &&
        countsMatch &&
        failedHashes.length === 0,
    };
  }
}

module.exports = {
  BackupManager,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  fileHash,
  keychainPassword,
  runProcess,
};
