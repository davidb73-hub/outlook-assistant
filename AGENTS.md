# outlook-assistant repository rules

## Product mission

This repository contains two deliberately separated concerns:

1. the existing Outlook MCP connector and public npm package;
2. David Basseal's private local email archival application.

The current delivery objective is Phase 1 of `PRODUCT.md`: deterministic archival of eligible Outlook and Gmail email. Local-LLM processing, Obsidian briefs, and downstream routing are deferred until Phase 1 passes `ACCEPTANCE.md`.

## Authoritative documents

Read these before changing code:

1. `PRODUCT.md` — required outcomes, boundaries, and non-goals.
2. `PLAN.md` — approved delivery sequence and dependencies.
3. `ACCEPTANCE.md` — observable completion criteria.
4. `docs/local-email-archive-pipeline.md` — architectural explanation and timing model.

When documents conflict, explicit owner instructions win, followed by `PRODUCT.md`, `ACCEPTANCE.md`, `PLAN.md`, and this file. Historical handovers, roadmaps, orchestration files, and generated agent instructions are not authoritative unless incorporated into these documents.

## User communication

David is not a developer. Explain material architecture, security, cost, data-loss, and operational consequences in plain English. Do not hide uncertainty behind jargon.

Do not agree for convenience. Challenge assumptions that would produce data loss, false completion, unnecessary complexity, privacy exposure, or architectural drift. Distinguish evidence, inference, and recommendation.

## Change control

- Preserve unrelated user changes in a dirty working tree.
- Do not delete, overwrite, reset, clean, or relocate existing material without resolving exact targets and receiving approval when the action is destructive.
- Do not push, publish, send, or modify external repositories unless explicitly authorised.
- Do not modify live mailboxes during archival development.
- Keep changes scoped to the approved stage in `PLAN.md`.
- Update product documentation when an approved requirement or architectural decision changes.
- Do not add generated swarm, agent, memory, or orchestration frameworks to the product tree unless the owner explicitly requests them and their value is demonstrated.

## Architectural boundaries

### Deterministic archival

Authentication, retrieval, checkpointing, deduplication, hashing, storage, reconciliation, backup, and restore must be deterministic code. An LLM must never decide whether source data is retrieved, committed, retried, or deleted.

### Read-only mail access

The archive must not send, draft, move, label, mark read, or delete email. Drafts, Spam/Junk, and Trash/Deleted Items are excluded. Previously archived content is retained when remote deletion or movement is observed.

### Data separation

- Live archive root: `/Users/davidbasseal/Library/Application Support/Email Assistant Archive/`
- Backup destination: encrypted backup transferred to VitaSci OneDrive.
- Never run the live SQLite database from OneDrive or another sync folder.
- Never put live email, tokens, credentials, databases, attachments, or raw operational logs in Git.
- Keep private archival code outside the public npm package allowlist.
- Downstream repositories receive traceable copies or derived records only; they do not own the archive.

### Local LLM boundary

Local-LLM integration is deferred. Phase 1 must work when every LLM service is unavailable. When later approved, the Email Assistant owns domain logic and the Local LLM gateway owns model selection and inference policy.

## Implementation standards

- Reuse existing Node.js authentication and provider code where it is safe and tested.
- Prefer one application language unless a measured requirement justifies another.
- Validate every provider response and filesystem path at its boundary.
- Use parameterized SQL and versioned, forward-only migrations.
- Make ingestion idempotent and crash-resumable.
- Use atomic file writes and transactional database changes.
- Hash raw messages and attachments with SHA-256.
- Treat HTML, MIME, filenames, and attachments as hostile input.
- Never execute or automatically open attachments.
- Do not log message bodies or credentials in routine logs.
- Use explicit states; never report a record `archived_complete` while required content remains unverified.
- Keep account credentials, cursors, failures, and records isolated.
- Before any live sync, verify each credential's provider profile against the
  semantic account name. A credential-key label is not evidence of identity;
  if identities are corrected, pause scheduling, remap all account-scoped
  records transactionally, reconcile every provider, and only then resume.
- New mail takes priority over historical backfill.

## Testing rules

- Tests use synthetic fixtures by default and must not require live credentials.
- Never use real private email bodies as committed fixtures.
- Provider clients must be mockable at the network boundary.
- Every migration, checkpoint transition, retry rule, exclusion, tombstone, and deduplication rule requires regression coverage.
- Live tests must be read-only, controlled, sanitized, and explicitly identified.
- A skipped test cannot cover a required Phase 1 acceptance criterion.

Required verification before handoff:

```bash
npm ci --prefix archive-worker
npm run archive:test
npm test -- --runInBand
npm run lint
npm run format:check
npm audit --omit=dev
npm pack --dry-run
```

Live verification additionally requires `npm run archive:verify`, an encrypted
`npm run archive:backup`, and a restore into a new empty directory. Never use a
fixture or unit-test result as a substitute for those live gates.

## Completion claims

Do not claim that a stage or product is complete because code exists or unit tests pass.

Completion requires:

- every applicable criterion in `ACCEPTANCE.md` passes;
- failures and limitations are stated plainly;
- a clean installation is demonstrated;
- backup restoration is demonstrated;
- live reconciliation has no unexplained differences;
- sanitized evidence is recorded.

If any criterion is untested, say `not verified`, not `complete`.

## Git and repository hygiene

- Use descriptive branches aligned with the current product stage.
- Make focused commits that separate recovery, documentation, schema, provider, operations, and test work.
- Do not commit generated coverage, model files, token stores, local databases, raw mail, private evidence, or IDE/agent runtime state.
- Do not add third-party co-author trailers unless that person actually authored the change.
- Do not publish the private archive through the public npm package.

## Deferred scope guard

Unless the owner explicitly changes `PRODUCT.md`, do not implement:

- Obsidian writes;
- Financial-Assistant writes;
- CRM/KMS writes;
- LLM triage or routing;
- mailbox mutations;
- public hosting or multi-user features;
- webhook infrastructure;
- dashboards or elaborate orchestration frameworks.

Record useful ideas in the plan rather than expanding the current stage.
