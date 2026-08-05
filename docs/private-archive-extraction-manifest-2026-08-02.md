# Private Email Assistant extraction manifest

**Status:** Planning record only; no files moved, no repository created, and no
changes pushed.

## Boundary decision

The public `@littlebearapps/outlook-assistant` repository remains the Outlook MCP
connector. The deterministic local archive, its operations, and its future local
processing pipeline belong in a separately approved private repository.

## Move as complete private file sets

The following path rules resolve to complete files, excluding ignored dependencies
and runtime data:

| Current path | Private-repository destination | Treatment |
| --- | --- | --- |
| `archive-worker/**` | `archive-worker/**` initially | Move every source, package, lock, README, provider, migration, repair, backup, scheduler, and delivery file. Exclude `node_modules/**`. |
| `local-worker/**` | `local-worker/**` | Move every source file. Keep the whole deferred local-LLM area disabled until separately approved. |
| `test/archive-worker/**` | `test/archive-worker/**` | Move all deterministic archive tests and synthetic fixtures. |
| `test/local-worker/**` | `test/local-worker/**` | Move all local-worker tests and synthetic fixtures. |
| `scripts/install-email-archive-launchd.js` | `scripts/install-email-archive-launchd.js` | Move with its tests and operations documentation. |
| `scripts/clean-install-check.sh` | `scripts/clean-install-check.sh` | Move after it passes from a standalone private checkout. |
| `PRODUCT.md` | `PRODUCT.md` | Move the private archive product contract. |
| `PLAN.md` | `PLAN.md` | Move the private delivery plan and current status. |
| `ACCEPTANCE.md` | `ACCEPTANCE.md` | Move the private acceptance contract. |
| `docs/acceptance-evidence-2026-07-18.md` | same relative path | Preserve as immutable historical evidence. |
| `docs/archive-operations-runbook.md` | same relative path | Move the private production runbook. |
| `docs/delivery-contract.md` | same relative path | Move the downstream package contract. |
| `docs/local-email-archive-pipeline.md` | same relative path | Move the private architecture document. |
| `docs/remediation/**` | same relative path | Move content-free remediation evidence only. |
| `docs/private-archive-extraction-manifest-2026-08-02.md` | same relative path | Move this planning record. |

## Split at extraction time

These files contain both public and private concerns and must not be copied or
deleted wholesale:

| Shared file | Public-repository result | Private-repository result |
| --- | --- | --- |
| `package.json` | Retain MCP scripts, dependencies, metadata, and npm `files` allowlist; remove `archive:*` and `triage:*` scripts after the private checkout works. | Promote the archive package metadata and add only private application scripts. |
| `package-lock.json` | Regenerate from the retained public package. | Generate from the private package; do not hand-edit either lockfile. |
| `.env.example` | Retain public Outlook MCP examples only. | Copy only empty archive/local-worker variable names. Never copy `.env` or values. |
| `.gitignore` | Retain the public exclusions. | Start with explicit exclusions for `.env`, tokens, databases, SQLite sidecars, blobs, raw messages, attachments, manifests, logs, restores, evidence scratch files, and dependencies. |
| `AGENTS.md` | Replace with public MCP repository rules. | Preserve the private archive safety, read-only-mail, recovery, acceptance, and no-public-push rules. |
| `docs/proposed-AGENTS.md` | Remove the obsolete combined-repository approval copy after owner review. | Preserve only if required as historical governance evidence. |
| `config.js` | Retain the public MCP authentication configuration. | Replace archive imports of this file with a narrow private read-only Outlook-auth adapter; do not import the public MCP mutation surface. |

## Keep in the public repository

The public connector implementation and tests remain: `index.js`,
`outlook-auth-server.js`, `auth/**`, `advanced/**`, `calendar/**`, `categories/**`,
`contacts/**`, `email/**`, `folder/**`, `rules/**`, `settings/**`, `tasks/**`,
`utils/**`, their matching non-archive tests, npm/public documentation and assets,
`README.md`, `LICENSE`, `llms.txt`, `llms-install.md`, and `server.json`.

## Never copy into either Git history

- `.env` or any credential/token store;
- the live archive, SQLite database/sidecars, raw messages, attachments, or blobs;
- operational logs, notification state, generated plans containing private runtime
  evidence, backup passwords, Restic cache, or restored snapshots;
- `node_modules`, coverage, temporary directories, IDE state, or agent runtime
  state.

## Required extraction gate

Extraction is a separately approved operation. Before any remote is created or any
history is published:

1. create the private checkout locally from an owner-reviewed file list;
2. remove the archive's dependency on the public root `config.js`;
3. demonstrate the private clean-install, full archive tests, lint, format,
   synthetic fixture ingestion, backup, and empty-directory restore;
4. demonstrate the public connector tests and `npm pack --dry-run --json` with no
   private file in the package;
5. scan both tracked trees for secrets and private runtime data;
6. review exact staged files and focused commits;
7. obtain explicit owner approval before creating or pushing any remote.
