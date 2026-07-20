# Private Email Archive Worker

This private worker archives eligible mail from VitaSci Outlook, Ablative
Gmail, and Personal Gmail. It is intentionally excluded from the public npm
package.

Deterministic code performs authentication, retrieval, hashing, checkpointing,
database commits, reconciliation, backup, and restore. No LLM is required or
permitted in this integrity path.

## Install and fixture verification

```bash
npm ci
npm ci --prefix archive-worker
npm run archive:test
```

Fixture tests use temporary directories and never connect to live mailboxes.
If npm reports an `EACCES` error for the user's global `~/.npm` cache on this
Mac, use the documented isolated cache instead of changing global ownership:

```bash
npm_config_cache=/tmp/email-assistant-npm-cache npm ci
npm_config_cache=/tmp/email-assistant-npm-cache npm ci --prefix archive-worker
```

## Operator commands

```bash
npm run archive:init
npm run archive:status
npm run archive:acceptance-status
node archive-worker/index.js latency-report --input /path/to/private-latency-samples.json
node archive-worker/index.js build-delivery-package --manifest /path/manifest.json \
  --raw /path/original.eml --output /path/out \
  --attachment-123 /path/attachment.pdf
npm run archive:sync
npm run archive:reconcile
npm run archive:verify
npm run archive:backup
npm run archive:backup-status
npm run archive:restore -- /path/to/new-empty-directory
npm run archive:schedule:install
```

Account-specific sync is available with:

```bash
node archive-worker/index.js sync --account gmail-personal
```

See `docs/archive-operations-runbook.md` for recovery and restore instructions.

## Attachment security

Archived email and attachments are untrusted. The archive stores them as
immutable bytes; it does not execute or open them. The security gate blocks
active-content extensions and requires a successful local ClamAV scan before
an attachment is eligible for triage or downstream ingestion. If ClamAV is
missing, unavailable, or uncertain, the attachment is fail-closed and must be
reviewed. Install ClamAV separately on the Mac (`brew install clamav`) and
keep its virus definitions current before enabling automated downstream
processing. The configured scanner path is `/opt/homebrew/bin/clamscan` and
the security gate remains fail-closed if that executable is unavailable.
