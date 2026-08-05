'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

function immutableSqliteError(code, message = null, cause = null) {
  const error = new Error(message ? `${code}: ${message}` : code, {
    cause: cause || undefined,
  });
  error.code = code;
  return error;
}

function loadNodeSqlite() {
  try {
    return require('node:sqlite');
  } catch (error) {
    throw immutableSqliteError(
      'IMMUTABLE_SQLITE_RUNTIME_UNAVAILABLE',
      'guarded live archive reads require a Node.js runtime with node:sqlite support',
      error
    );
  }
}

function fileIdentity(filePath) {
  const stat = fs.statSync(filePath, { bigint: true });
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
  };
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function assertNoSqliteSidecars(databasePath) {
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.lstatSync(`${databasePath}${suffix}`);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    throw immutableSqliteError(
      'IMMUTABLE_SQLITE_SIDECAR_PRESENT',
      'immutable reads require both SQLite sidecar paths to be absent'
    );
  }
}

function resolveImmutableDatabase(databasePath) {
  const requested = path.resolve(databasePath || '');
  const stat = fs.lstatSync(requested);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw immutableSqliteError(
      'IMMUTABLE_SQLITE_DATABASE_UNSAFE',
      'the database must be one regular, non-symlink, non-hard-linked file'
    );
  }
  const resolved = fs.realpathSync(requested);
  assertNoSqliteSidecars(resolved);
  return resolved;
}

function immutableDatabaseUrl(databasePath) {
  const url = pathToFileURL(databasePath);
  url.searchParams.set('mode', 'ro');
  url.searchParams.set('immutable', '1');
  return url;
}

class ImmutableSqliteDatabase {
  constructor(databasePath, options = {}) {
    if (options.readonly !== true || options.fileMustExist !== true) {
      throw immutableSqliteError(
        'IMMUTABLE_SQLITE_OPTIONS_REQUIRED',
        'immutable databases must be explicitly read-only and pre-existing'
      );
    }
    const resolved = resolveImmutableDatabase(databasePath);
    const { DatabaseSync, backup } = loadNodeSqlite();
    this.databasePath = resolved;
    this.beforeIdentity = fileIdentity(resolved);
    this.backupImpl = backup;
    this.database = new DatabaseSync(immutableDatabaseUrl(resolved), {
      readOnly: true,
    });
    this.closed = false;
  }

  prepare(sql) {
    return this.database.prepare(sql);
  }

  exec(sql) {
    return this.database.exec(sql);
  }

  pragma(source, options = {}) {
    if (
      typeof source !== 'string' ||
      source.length === 0 ||
      source.includes(';') ||
      /[\r\n\0]/.test(source)
    ) {
      throw immutableSqliteError('IMMUTABLE_SQLITE_PRAGMA_UNSAFE');
    }
    const rows = this.database.prepare(`PRAGMA ${source}`).all();
    if (options.simple === true) {
      return rows.length === 0 ? undefined : Object.values(rows[0])[0];
    }
    return rows;
  }

  transaction(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Expected transaction callback to be a function');
    }
    return (...args) => {
      this.database.exec('BEGIN');
      try {
        const result = callback(...args);
        this.database.exec('COMMIT');
        return result;
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    };
  }

  backup(destinationPath) {
    return this.backupImpl(this.database, destinationPath);
  }

  close() {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
    assertNoSqliteSidecars(this.databasePath);
    if (!sameIdentity(this.beforeIdentity, fileIdentity(this.databasePath))) {
      throw immutableSqliteError(
        'IMMUTABLE_SQLITE_DATABASE_CHANGED',
        'the database identity or metadata changed during the immutable read'
      );
    }
  }
}

module.exports = {
  ImmutableSqliteDatabase,
  assertNoSqliteSidecars,
  immutableDatabaseUrl,
  immutableSqliteError,
  resolveImmutableDatabase,
};
