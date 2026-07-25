const os = require('os');
const path = require('path');
require('dotenv').config({
  path: path.join(__dirname, '..', '.env'),
  quiet: true,
});

const DEFAULT_ARCHIVE_ROOT = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Email Assistant Archive'
);
const DEFAULT_ONEDRIVE_ROOT = path.join(
  os.homedir(),
  'Library',
  'CloudStorage',
  'OneDrive-VitaSciConsulting'
);

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveArchiveRoot(value) {
  if (!value) return DEFAULT_ARCHIVE_ROOT;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function buildArchiveConfig(env = process.env) {
  const root = resolveArchiveRoot(env.EMAIL_ARCHIVE_ROOT);
  return {
    root,
    databasePath: path.join(root, 'archive.sqlite3'),
    rawMessagesDir: path.join(root, 'raw-messages'),
    attachmentsDir: path.join(root, 'attachments'),
    manifestsDir: path.join(root, 'manifests'),
    logsDir: path.join(root, 'logs'),
    backupRepository:
      env.EMAIL_ARCHIVE_BACKUP_REPOSITORY ||
      path.join(DEFAULT_ONEDRIVE_ROOT, 'Email Assistant Archive Backup'),
    pollMinutes: parsePositiveInteger(env.EMAIL_ARCHIVE_POLL_MINUTES, 15),
    incrementalBatchSize: parsePositiveInteger(
      env.EMAIL_ARCHIVE_INCREMENTAL_BATCH_SIZE,
      50
    ),
    backfillBatchSize: parsePositiveInteger(
      env.EMAIL_ARCHIVE_BACKFILL_BATCH_SIZE,
      100
    ),
    attachmentRetryBatchSize: parsePositiveInteger(
      env.EMAIL_ARCHIVE_ATTACHMENT_RETRY_BATCH_SIZE,
      25
    ),
    clamScanPath:
      env.EMAIL_ARCHIVE_CLAMSCAN_PATH || '/opt/homebrew/bin/clamscan',
    deliveryDestinations: {
      'financial-assistant':
        env.EMAIL_ARCHIVE_FINANCIAL_INBOX ||
        path.join(
          os.homedir(),
          'Developer',
          'Financial-Assistant',
          'ruvocal',
          'email-inbox'
        ),
      // LOCAL tree, not OneDrive. The VitaSci platform moved on 2026-07-20 because
      // background reads from the FileProvider mount fail with EDEADLK. Its delivery
      // adapter now runs from ~/Developer/01-Vitasci, so packages written to the old
      // OneDrive path were never acknowledged — 25 packages sat there against 7
      // receipts while the adapter processed a different directory entirely.
      'vitasci-crm':
        env.EMAIL_ARCHIVE_VITASCI_INBOX ||
        path.join(
          os.homedir(),
          'Developer',
          '01-Vitasci',
          '_status',
          'email-assistant-inbox'
        ),
      // Deliver into the LIVE vault, not the Voice-and-Visualiser repo copy.
      // vault-source/ is a hand-deployed source tree with no sync step, while
      // brain.py runs the session with cwd = ~/Developer/Assistant-Vault. Briefs
      // written to the repo copy are invisible to Hannibal.
      'hannibal-briefs':
        env.EMAIL_ARCHIVE_BRIEFS_INBOX ||
        path.join(
          os.homedir(),
          'Developer',
          'Assistant-Vault',
          'Business',
          'Email Briefs'
        ),
    },
    deliveryReceiptRoots: {
      // Ruvocal writes receipts under its own app root, not the repo root:
      // receiver.py resolves DEFAULT_PROVENANCE_DIR to ruvocal/delivery-provenance
      // and _write_receipt appends /receipts. Reading anywhere else leaves every
      // financial delivery permanently pending on awaiting-destination-receipt.
      'financial-assistant':
        env.EMAIL_ARCHIVE_FINANCIAL_RECEIPTS ||
        path.join(
          os.homedir(),
          'Developer',
          'Financial-Assistant',
          'ruvocal',
          'delivery-provenance',
          'receipts'
        ),
      'vitasci-crm':
        env.EMAIL_ARCHIVE_VITASCI_RECEIPTS ||
        path.join(
          os.homedir(),
          'Developer',
          '01-Vitasci',
          '_status',
          'email-assistant-receipts'
        ),
    },
    accounts: [
      {
        id: 'vitasci-outlook',
        provider: 'outlook',
        displayName: 'VitaSci Outlook',
      },
      {
        id: 'gmail-ablative',
        provider: 'gmail',
        displayName: env.GMAIL_ACCOUNT_LABEL || 'Ablative Gmail',
        accountKey: 'personal',
      },
      {
        id: 'gmail-personal',
        provider: 'gmail',
        displayName: env.GMAIL_PERSONAL_ACCOUNT_LABEL || 'Personal Gmail',
        accountKey: 'ablative',
      },
    ],
  };
}

module.exports = {
  DEFAULT_ARCHIVE_ROOT,
  DEFAULT_ONEDRIVE_ROOT,
  buildArchiveConfig,
  parsePositiveInteger,
  resolveArchiveRoot,
};
