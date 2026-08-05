#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/email-assistant-clean.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT

cp "$repo_dir/package.json" "$repo_dir/package-lock.json" "$temp_dir/"
mkdir -p "$temp_dir/archive-worker"
cp \
  "$repo_dir/archive-worker/package.json" \
  "$repo_dir/archive-worker/package-lock.json" \
  "$temp_dir/archive-worker/"
cp "$repo_dir"/archive-worker/*.js "$temp_dir/archive-worker/"
cp -R "$repo_dir/archive-worker/providers" "$temp_dir/archive-worker/"

mkdir -p "$temp_dir/npm-cache"
npm_config_cache="$temp_dir/npm-cache" npm ci --prefix "$temp_dir" --ignore-scripts --no-audit --no-fund --cache "$temp_dir/npm-cache" >/dev/null
npm_config_cache="$temp_dir/npm-cache" npm ci --prefix "$temp_dir/archive-worker" --no-audit --no-fund --cache "$temp_dir/npm-cache" >/dev/null

EMAIL_ARCHIVE_ROOT="$temp_dir/archive" \
node - "$temp_dir" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const { ArchiveDatabase } = require(path.join(root, 'archive-worker/database'));
const { ContentStore } = require(path.join(root, 'archive-worker/storage'));
const { ArchiveService } = require(path.join(root, 'archive-worker/archive-service'));
const { MIGRATIONS } = require(path.join(root, 'archive-worker/migrations'));

const archiveRoot = path.join(root, 'archive');
const dbPath = path.join(archiveRoot, 'archive.sqlite3');
if (path.resolve(process.env.EMAIL_ARCHIVE_ROOT) !== path.resolve(archiveRoot)) {
  process.exit(1);
}

let networkAttempted = false;
globalThis.fetch = async () => {
  networkAttempted = true;
  throw new Error('A clean-install fixture must never access a live provider');
};

const db = new ArchiveDatabase(dbPath);
const store = new ContentStore(archiveRoot);
const service = new ArchiveService({ database: db, contentStore: store });

(async () => {
  try {
    await service.initialise([
      {
        id: 'fixture-outlook',
        provider: 'outlook',
        displayName: 'Synthetic Outlook fixture',
      },
    ]);
    const message = {
      providerMessageId: 'fixture-provider-message-1',
      subject: 'Synthetic clean installation marker',
      bodyText: 'searchable fixture body',
      direction: 'inbound',
      recipients: [
        {
          type: 'from',
          address: 'sender@example.test',
          displayName: 'Synthetic sender',
        },
      ],
      locations: [
        {
          providerLocationId: 'fixture-inbox',
          displayName: 'Inbox',
          kind: 'inbox',
        },
      ],
      attachments: [],
    };
    const raw = Buffer.from('From: sender@example.test\n\nSynthetic fixture body');
    const first = await service.stageMessage('fixture-outlook', message, raw);
    const repeated = await service.stageMessage('fixture-outlook', message, raw);
    const versions = db.db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => row.version);
    const search = db.search('searchable', { accountId: 'fixture-outlook' });
    const accountMessageCount = db.db
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE account_id = ?')
      .get('fixture-outlook').count;

    if (versions.length !== MIGRATIONS.length) process.exitCode = 1;
    if (first.id !== repeated.id || accountMessageCount !== 1) process.exitCode = 1;
    if (search.length !== 1 || search[0].id !== first.id) process.exitCode = 1;
    if (db.db.pragma('integrity_check', { simple: true }) !== 'ok') process.exitCode = 1;
    if (db.db.pragma('foreign_key_check').length !== 0) process.exitCode = 1;
    if (networkAttempted) process.exitCode = 1;

    const files = [];
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else files.push(absolute);
      }
    };
    walk(archiveRoot);
    if (
      files.length === 0 ||
      files.some((file) => {
        const relative = path.relative(archiveRoot, file);
        return relative.startsWith('..') || path.isAbsolute(relative);
      })
    ) {
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }

  if (process.exitCode) throw new Error('clean-install archive verification failed');
  console.log('clean-install archive fixture ingestion and search: PASS');
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
NODE
