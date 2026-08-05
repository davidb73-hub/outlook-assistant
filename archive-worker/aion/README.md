# Aion integration for the private email archive

This directory contains three deliberately separate Aion workflows:

1. `three_account_archive_cycle.awl` is a complete synthetic lifecycle test.
   Its Node adapter cannot read the network, environment, filesystem,
   credentials, mailboxes, archive, or backup destination.
2. `email_archive_identity_preflight.awl` is a guarded live credential test.
   It performs provider-profile reads only through the existing archive
   providers. It does not open the archive database, advance cursors, download
   messages, persist refreshed tokens, create backups, or change mailboxes.
3. `email_archive_clone_commissioning.awl` exercises the production repair,
   reconciliation, backup, and restore implementations against a disposable
   archive and invented provider inventories. It reads only filesystem metadata
   from the live archive to prove the disposable path is distinct and unchanged.

There is intentionally no live full-cycle worker profile. The archive is currently
paused for the reviewed Gmail identity remediation described in `PLAN.md`.
Adding a live synchronization path before that remediation, reconciliation,
backup, and restore are approved would be unsafe.

## Files

| File | Purpose |
| --- | --- |
| `three_account_archive_cycle.awl` | Eleven-step synthetic lifecycle |
| `synthetic-action.js` | Deterministic Node implementation of all eight synthetic actions |
| `synthetic-input.json` | Invented three-account fixture |
| `email_archive_identity_preflight.awl` | One-step live identity gate |
| `identity-preflight-action.js` | Privacy-safe adapter to existing provider identity audits |
| `email_archive_clone_commissioning.awl` | Six-step disposable commissioning workflow |
| `clone-commissioning-action.js` | Narrow adapter to production archive code using synthetic evidence |
| `../disposable-commissioning.js` | Strict temporary-path fixture, repair, reconciliation, backup, and restore harness |
| `worker/` | Narrow Rust liminal-transport wrapper for the reviewed Node adapters |

The transport wrapper is Rust because the active Aion server dispatches through
its liminal outbox. The built-in gRPC shell worker registered during validation
but never became dispatch-eligible on that path. The wrapper contains no email
or archive domain logic; it compiles descriptors from these AWL files and calls
only the three literal Node adapter paths above with a cleared child environment.

These files are under `archive-worker/`, which is excluded from the public npm
package allowlist in the root `package.json`.

The live preflight imports the current `archive-worker/identity-status.js` and
provider identity guards. Those remediation files are not all committed in the
present working tree. Do not publish the Aion directory alone: first preserve
and review the archive remediation change set it depends on, then commit the
integration with that compatible state. Otherwise a fresh clone will be
synthetic-capable but its live preflight will be incomplete.

## Prerequisites

- Work from the repository root.
- Node.js, Rust, and installed repository dependencies.
- Aion CLI/server 0.11.0 with deployment and workers enabled.
- Namespace `Practice` for testing.
- For the live preflight only: the existing local `.env` and OAuth token files.
  Never copy their values into AWL, Git, Aion input, or Aion history.

Set the local Aion binary path once in each terminal:

```sh
cd /Users/davidbasseal/Developer/EMAIL-Assistant-Repos/outlook-assistant
export AION_BIN=/Users/davidbasseal/Developer/ablative/aion/target/release/aion
```

## Validate locally

These checks do not contact providers or the Aion server:

```sh
"$AION_BIN" awl check archive-worker/aion/three_account_archive_cycle.awl
"$AION_BIN" awl check archive-worker/aion/email_archive_identity_preflight.awl
"$AION_BIN" awl check archive-worker/aion/email_archive_clone_commissioning.awl
npm test -- --runInBand test/archive-worker/aion-integration.test.js
cargo fmt --all --manifest-path archive-worker/aion/worker/Cargo.toml -- --check
cargo test --locked --all-targets --manifest-path archive-worker/aion/worker/Cargo.toml
cargo clippy --locked --all-targets --manifest-path archive-worker/aion/worker/Cargo.toml -- -D warnings
```

Success evidence is three `ok:` lines, a passing Jest file, and green Rust gates.

Build all temporary worker binaries:

```sh
cargo build --locked --bins --manifest-path archive-worker/aion/worker/Cargo.toml
export EMAIL_ARCHIVE_NODE_BIN="$(command -v node)"
```

## Run the synthetic lifecycle

Start the synthetic worker from the repository root in Terminal 1. Every
operator-controlled setting is explicit, and the process receives no OAuth
configuration:

```sh
env -i \
  AION_WORKER_ENDPOINT=127.0.0.1:7400 \
  AION_WORKER_NAMESPACE=Practice \
  AION_WORKER_IDENTITY=email-archive \
  AION_WORKER_CONCURRENCY=4 \
  AION_RECONNECT_INITIAL_BACKOFF_SECONDS=1 \
  AION_RECONNECT_MAX_BACKOFF_SECONDS=5 \
  AION_RECONNECT_MAX_ATTEMPTS=1000000 \
  EMAIL_ARCHIVE_NODE_BIN="$EMAIL_ARCHIVE_NODE_BIN" \
  EMAIL_ARCHIVE_REPO_ROOT="$PWD" \
  EMAIL_ARCHIVE_HOME=/Users/davidbasseal \
  RUST_LOG=info \
  archive-worker/aion/worker/target/debug/email-archive-synthetic-worker
```

Wait for `liminal worker registered`, then confirm Aion's two-ping dispatch
probation has completed in Aion Ops before starting a run. A live process alone
is not proof of service.

In Terminal 2, from the same repository root:

```sh
"$AION_BIN" \
  --endpoint 127.0.0.1:50051 \
  --namespace Practice \
  run archive-worker/aion/three_account_archive_cycle.awl \
  --input "$(cat archive-worker/aion/synthetic-input.json)" \
  --timeout 2m
```

The expected final result has `status: "completed"`, three synchronized
accounts, zero discrepancies, and `synthetic-snapshot-9`. Stop the worker with
Control-C after inspecting the durable history.

## Run disposable commissioning

This path uses the real database, repair, synchronization, Restic backup, and
restore implementations. All messages, identities, provider inventories,
backup credentials, and backup destinations are disposable fixtures. It does
not contact providers, open the live database, apply the live Gmail repair, or
enable scheduling.

Start the dedicated worker from the repository root:

```sh
env -i \
  AION_WORKER_ENDPOINT=127.0.0.1:7400 \
  AION_WORKER_NAMESPACE=Practice \
  AION_WORKER_IDENTITY=email-archive \
  AION_WORKER_CONCURRENCY=1 \
  AION_RECONNECT_INITIAL_BACKOFF_SECONDS=1 \
  AION_RECONNECT_MAX_BACKOFF_SECONDS=5 \
  AION_RECONNECT_MAX_ATTEMPTS=1000000 \
  EMAIL_ARCHIVE_NODE_BIN="$EMAIL_ARCHIVE_NODE_BIN" \
  EMAIL_ARCHIVE_REPO_ROOT="$PWD" \
  EMAIL_ARCHIVE_HOME=/Users/davidbasseal \
  RUST_LOG=info \
  archive-worker/aion/worker/target/debug/email-archive-clone-commissioning-worker
```

Confirm `/awl/workers/availability` reports one connected worker for task queue
`email_archive_clone_commissioning`, then run with a new lowercase session ID:

```sh
"$AION_BIN" \
  --endpoint 127.0.0.1:50051 \
  --namespace Practice \
  run archive-worker/aion/email_archive_clone_commissioning.awl \
  --input '{"session_id":"commissioning-example-0001","confirmation":"DISPOSABLE_ARCHIVE_COMMISSIONING_ONLY"}' \
  --timeout 5m
```

A successful result is `commissioned_disposable`, with three reconciled
accounts, zero differences, verified backup and restore, no live email
retrieval, and a verified-unchanged live archive fingerprint. Stop the worker
after inspecting history. Preserve the redacted receipt before deleting the
matching directory below `/private/tmp/email-archive-aion-commissioning/`.

### Verified synthetic evidence

Verified in namespace `Practice` on 5 August 2026:

- Workflow ID: `cf5ee995-da42-4c26-8dc7-5b68077efe02`
- Run ID: `9334394f-7ffd-4977-bc95-4eb24d1c148b`
- Status: `Completed`
- Durable events: 36
- Activities: 11 completed, zero failed
- Result: three synchronized, zero discrepancies, `synthetic-snapshot-9`

### Verified live identity-preflight evidence

Verified in namespace `Practice` on 6 August 2026:

- Workflow ID: `cd33aae4-0f73-492e-a1a6-bbbbabaad102`
- Run ID: `d5e07c58-6124-4020-8148-ecd446565fc8`
- Status: `Completed`
- Durable events: 6
- Activity: one identity audit completed on its first attempt
- Result: `ready`; all three configured profile identities matched
- Safety evidence: protected before/after fingerprints proved `.env`, all
  credential files, the archive database, and its sidecars were unchanged
- Shutdown evidence: the dedicated worker was stopped and availability returned
  to zero connected workers

This proves only live provider-profile identity reads. It does not authorize
mail retrieval, archive access, Gmail repair, scheduling, or backup operations.

### Verified disposable commissioning evidence

Verified in namespace `Practice` on 6 August 2026:

- Workflow ID: `c24635f9-71c1-4705-abd2-568c6762eaea`
- Run ID: `4d3e0469-8ce9-4fd6-a947-6bf473de6530`
- Status: `Completed`
- Durable events: 21
- Activities: six completed on their first attempts, zero failed
- Repair: two duplicates quarantined, one canonical moved, second invocation a no-op
- Reconciliation: three accounts, nine synthetic inventory items, zero differences
- Backup/restore: two local encrypted Restic snapshots, deduplication observed,
  restored database/counts and all 11 blobs verified
- Safety: the Aion run retrieved no live email and did not change the live
  database or its post-diagnostic filesystem fingerprint

The full evidence and the separate diagnostic-sidecar finding are recorded in
`docs/remediation/aion-disposable-commissioning-2026-08-06.md`.

## Prepare credentials for the live identity preflight

This integration reuses existing configuration; it does not create OAuth apps
or credentials. Follow the repository's existing provider setup and keep all
values local:

- Outlook setup: `docs/how-to/getting-started/connect-outlook-to-claude.md`
- Gmail setup: `local-worker/gmail-auth.js` and `.env.example`
- Semantic identity variables:
  `EMAIL_ARCHIVE_OUTLOOK_EXPECTED_IDENTITY`,
  `EMAIL_ARCHIVE_GMAIL_ABLATIVE_EXPECTED_IDENTITY`, and
  `EMAIL_ARCHIVE_GMAIL_PERSONAL_EXPECTED_IDENTITY`

The expected identities are secrets-adjacent personal configuration. They
belong in the ignored local `.env`, never in an input fixture or commit.

## Run the guarded live identity preflight

This operation contacts Microsoft Graph and Gmail only for authenticated
profile identity. It may refresh an expired access token in memory, but the
preflight path explicitly does not persist that refresh. It outputs logical
account IDs, slot names, booleans, timestamps, and safe error codes—not email
addresses, tokens, or provider response bodies.

Build as shown above, stop any synthetic worker, then start the dedicated
preflight worker in Terminal 1:

```sh
env -i \
  AION_WORKER_ENDPOINT=127.0.0.1:7400 \
  AION_WORKER_NAMESPACE=Practice \
  AION_WORKER_IDENTITY=email-archive \
  AION_WORKER_CONCURRENCY=1 \
  AION_RECONNECT_INITIAL_BACKOFF_SECONDS=1 \
  AION_RECONNECT_MAX_BACKOFF_SECONDS=5 \
  AION_RECONNECT_MAX_ATTEMPTS=1000000 \
  EMAIL_ARCHIVE_NODE_BIN="$EMAIL_ARCHIVE_NODE_BIN" \
  EMAIL_ARCHIVE_REPO_ROOT="$PWD" \
  EMAIL_ARCHIVE_HOME=/Users/davidbasseal \
  RUST_LOG=info \
  archive-worker/aion/worker/target/debug/email-archive-identity-preflight-worker
```

After confirming availability in Aion Ops, run this in Terminal 2:

```sh
"$AION_BIN" \
  --endpoint 127.0.0.1:50051 \
  --namespace Practice \
  run archive-worker/aion/email_archive_identity_preflight.awl \
  --input '{"confirmation":"IDENTITY_ONLY_NO_ARCHIVE_WRITE"}' \
  --timeout 1m
```

A successful result routes to `ready` with exactly three matched accounts,
`archive_opened: false`, and `credentials_persisted: false`. Any missing,
expired, mismatched, or misconfigured credential routes to `blocked`. Stop the
worker with Control-C afterward.

## What this still does not authorize

- Running the eleven-step workflow against real accounts
- Opening or changing the live archive through Aion
- Advancing provider checkpoints
- Applying the pending Gmail repair
- Enabling scheduling
- Creating or restoring the production backup

Those operations remain gated by `PLAN.md` and `ACCEPTANCE.md`. The next live
integration stage is to implement and test action adapters against disposable
archive clones, then obtain explicit approval before touching live state.

The repository's `npm audit --omit=dev` gate passes after patch-level
transitive dependency updates, including the reviewed Hono security override.
