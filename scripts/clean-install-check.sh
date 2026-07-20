#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/email-assistant-clean.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT

cp "$repo_dir/package.json" "$repo_dir/package-lock.json" "$temp_dir/"
mkdir -p "$temp_dir/archive-worker"
cp "$repo_dir"/archive-worker/*.js "$temp_dir/archive-worker/"

NPM_CONFIG_CACHE="$temp_dir/npm-cache" npm ci --prefix "$temp_dir" --ignore-scripts --no-audit --no-fund >/dev/null
node - "$temp_dir" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const { ArchiveDatabase } = require(path.join(root, 'archive-worker/database'));
const dbPath = path.join(root, 'archive.sqlite3');
const db = new ArchiveDatabase(dbPath);
if (db.db.pragma('integrity_check', { simple: true }) !== 'ok') process.exit(1);
db.close();
fs.unlinkSync(dbPath);
console.log('clean-install archive initialization: PASS');
NODE
