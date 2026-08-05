const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ArchiveDatabase } = require('../../archive-worker/database');
const {
  inspectFtsConsistency,
  messageKey,
} = require('../../archive-worker/fts-index');
const {
  remapGmailIdentityIds,
} = require('../../archive-worker/remap-gmail-identities');
const {
  GMAIL_PARTITION_REHEARSAL_CONFIRMATION,
  GMAIL_PARTITION_REPAIR_CONFIRMATION,
  GMAIL_PARTITION_REPAIR_ID,
  QUARANTINE_ACCOUNT_ID,
  buildGmailPartitionRepairPlan,
  partitionRepairPlanDigest,
  repairGmailPartitions,
  validateOwnerApprovalMetadata,
} = require('../../archive-worker/repair-gmail-partitions');

const NOW = Date.parse('2026-08-02T11:30:00.000Z');
const WINDOW = {
  startedAt: '2026-07-25T00:00:00.000Z',
  endedAt: '2026-07-30T23:59:59.999Z',
};
const EXPECTED_IDENTITIES = Object.freeze({
  'gmail-ablative': 'ablative@example.test',
  'gmail-personal': 'personal@example.test',
});
const PROVIDER_INVENTORIES = Object.freeze({
  'gmail-ablative': ['anchored-a', 'correct-a'],
  'gmail-personal': ['post-p'],
});
const TOMBSTONE_RAW = Buffer.from(
  [
    'Delivered-To: ablative@example.test',
    'To: Archive Owner <ablative@example.test>',
    'From: Synthetic <sender@example.test>',
    'Subject: Synthetic tombstone',
    '',
    'Synthetic body',
  ].join('\r\n')
);

function identityProof(verifiedAt = new Date(NOW).toISOString()) {
  return {
    passed: true,
    accounts: [
      {
        logicalAccountId: 'gmail-ablative',
        credentialSlot: 'personal',
        expectedIdentityConfigured: true,
        identityMatch: true,
        verifiedAt,
        errorCode: null,
      },
      {
        logicalAccountId: 'gmail-personal',
        credentialSlot: 'ablative',
        expectedIdentityConfigured: true,
        identityMatch: true,
        verifiedAt,
        errorCode: null,
      },
    ],
  };
}

function blob(label, bytes = Buffer.from(`raw-${label}`)) {
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  return {
    hash,
    kind: 'raw-message',
    relativePath: `raw-messages/${hash}`,
    size: bytes.length,
    mediaType: 'message/rfc822',
  };
}

function fixtureMessage(providerMessageId, subject, attachments = []) {
  return {
    providerMessageId,
    subject,
    bodyText: subject,
    receivedAt: '2026-07-18T00:00:00.000Z',
    direction: 'inbound',
    currentEligible: true,
    recipients: [
      {
        type: 'from',
        address: 'synthetic@example.test',
        displayName: 'Synthetic',
      },
    ],
    locations: [
      {
        providerLocationId: 'inbox',
        displayName: 'Inbox',
        kind: 'inbox',
      },
    ],
    attachments,
    hasAttachments: attachments.length > 0,
  };
}

describe('targeted Gmail mixed-partition repair', () => {
  let root;
  let database;
  let anchor;
  let ids;
  let rawMessages;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-partition-repair-'));
    database = new ArchiveDatabase(path.join(root, 'current.sqlite3'));
    anchor = new ArchiveDatabase(path.join(root, 'anchor.sqlite3'));
    rawMessages = new Map();
    for (const db of [database, anchor]) {
      db.upsertAccount({
        id: 'gmail-ablative',
        provider: 'gmail',
        displayName: 'Ablative Gmail',
      });
      db.upsertAccount({
        id: 'gmail-personal',
        provider: 'gmail',
        displayName: 'Personal Gmail',
      });
    }

    const anchoredBlob = blob('anchored');
    const anchored = database.stageMessage(
      'gmail-ablative',
      fixtureMessage('anchored-a', 'canonical anchored'),
      anchoredBlob
    );
    const anchorCanonical = anchor.stageMessage(
      'gmail-ablative',
      fixtureMessage('anchored-a', 'canonical anchored'),
      anchoredBlob
    );
    expect(anchorCanonical.id).toBe(anchored.id);
    const anchoredWrong = database.stageMessage(
      'gmail-personal',
      fixtureMessage('anchored-a', 'wrongcopytoken'),
      anchoredBlob
    );

    const postBlob = blob('post-anchor');
    const postCanonical = database.stageMessage(
      'gmail-personal',
      fixtureMessage('post-p', 'post canonical'),
      postBlob
    );
    const postWrong = database.stageMessage(
      'gmail-ablative',
      fixtureMessage('post-p', 'secondwrongcopytoken', [
        {
          providerAttachmentId: 'attachment-1',
          fileName: 'fixture.txt',
          mediaType: 'text/plain',
        },
      ]),
      postBlob
    );

    const correct = database.stageMessage(
      'gmail-ablative',
      fixtureMessage('correct-a', 'already correct'),
      blob('correct')
    );
    const tombstoneBlob = blob('tombstone', TOMBSTONE_RAW);
    rawMessages.set(tombstoneBlob.hash, TOMBSTONE_RAW);
    const tombstone = database.stageMessage(
      'gmail-personal',
      fixtureMessage('deleted-only-a', 'proved tombstone'),
      tombstoneBlob
    );
    database.recordTombstone('gmail-personal', 'deleted-only-a', {
      reason: 'synthetic fixture',
    });

    database.upsertFolder('gmail-ablative', {
      providerFolderId: 'inbox-a',
      displayName: 'Inbox',
      kind: 'inbox',
    });
    database.upsertFolder('gmail-personal', {
      providerFolderId: 'inbox-p',
      displayName: 'Inbox',
      kind: 'inbox',
    });
    database.setCursor('gmail-ablative', 'incremental', 'fixture-a');
    database.setCursor('gmail-personal', 'reconciliation', 'fixture-p');
    const runId = database.beginRun('gmail-ablative', 'scheduled_cycle');
    database.finishRun(runId, 'failed', { errors: 1 });
    database.db
      .prepare(
        `UPDATE ingestion_runs
         SET started_at = '2026-07-26T00:00:00.000Z',
             finished_at = '2026-07-26T00:01:00.000Z'
         WHERE id = ?`
      )
      .run(runId);
    database.recordIngestionError({
      runId,
      accountId: 'gmail-ablative',
      stage: 'account_cycle',
      code: 'GMAIL_AUTH',
      message: 'synthetic safe failure',
    });
    database.db
      .prepare(
        `UPDATE ingestion_errors
         SET created_at = '2026-07-26T00:00:30.000Z'
         WHERE run_id = ?`
      )
      .run(runId);
    database.recordIngestionError({
      runId,
      accountId: 'gmail-personal',
      providerMessageId: 'anchored-a',
      stage: 'message_fetch',
      code: 'WRONG_BINDING_FIXTURE',
      message: 'synthetic wrong-binding fixture',
    });
    database.db
      .prepare(
        `UPDATE ingestion_errors
         SET created_at = '2026-07-26T00:00:40.000Z'
         WHERE error_code = 'WRONG_BINDING_FIXTURE'`
      )
      .run();
    database.enqueueDelivery(anchoredWrong.id, ['hannibal-briefs']);

    ids = {
      anchored: anchored.id,
      anchoredWrong: anchoredWrong.id,
      postCanonical: postCanonical.id,
      postWrong: postWrong.id,
      correct: correct.id,
      tombstone: tombstone.id,
      runId,
    };
  });

  afterEach(() => {
    database.close();
    anchor.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function buildPlan(
    ownerApprovalRecorded = false,
    providerInventories = PROVIDER_INVENTORIES
  ) {
    const plan = buildGmailPartitionRepairPlan({
      database,
      anchorDatabase: anchor,
      providerInventories,
      identityProof: identityProof(),
      expectedIdentities: EXPECTED_IDENTITIES,
      rawMessageLoader: (row) => rawMessages.get(row.raw_blob_hash),
      anchorSnapshotId: 'a'.repeat(64),
      contaminationWindow: WINDOW,
      generatedAt: new Date(NOW).toISOString(),
      ownerApprovalRecorded,
    });
    return { plan, digest: partitionRepairPlanDigest(plan) };
  }

  function repair(options = {}) {
    return repairGmailPartitions(database, {
      expectedIdentities: EXPECTED_IDENTITIES,
      rawMessageLoader: (row) => rawMessages.get(row.raw_blob_hash),
      independentProviderInventories: PROVIDER_INVENTORIES,
      independentAnchorDatabase: anchor,
      ...options,
    });
  }

  test('builds a content-free dry-run that covers every duplicate and the proved tombstone', () => {
    const ownershipBefore = database.db
      .prepare('SELECT id, account_id FROM messages ORDER BY id')
      .all();
    const { plan, digest } = buildPlan();
    const result = repair({
      plan,
      planDigest: digest,
      identityProof: identityProof(),
      now: NOW,
    });

    expect(result).toEqual(
      expect.objectContaining({
        mode: 'dry-run',
        applied: false,
        changedRows: 0,
        preconditionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        counts: {
          quarantineDuplicates: 2,
          moveProvedCanonicals: 1,
          restoreCanonicalStates: 0,
          providerOnlyNewMessages: 0,
          contaminatedRuns: 1,
          contaminatedErrors: 2,
        },
        derivedStateToReset: { folders: 2, syncCursors: 2 },
        projectedActiveOverlap: 0,
        integrity: 'ok',
        foreignKeyProblems: 0,
      })
    );
    expect(
      database.db
        .prepare('SELECT id, account_id FROM messages ORDER BY id')
        .all()
    ).toEqual(ownershipBefore);
    expect(
      database.db
        .prepare(
          'SELECT COUNT(*) AS count FROM identity_partition_repair_receipts'
        )
        .get().count
    ).toBe(0);
    expect(JSON.stringify(result)).not.toContain('anchored-a');
    expect(JSON.stringify(result)).not.toContain('deleted-only-a');
  });

  test('refuses repair when message and FTS account ownership disagree', () => {
    const { plan, digest } = buildPlan();
    database.db
      .prepare('UPDATE messages_fts SET account_id = ? WHERE message_id = ?')
      .run('gmail-personal', ids.correct);

    expect(() =>
      repair({
        plan,
        planDigest: digest,
        identityProof: identityProof(),
        now: NOW,
      })
    ).toThrow('GMAIL_PARTITION_REPAIR_FTS_ACCOUNT_MISMATCH');
  });

  test('refuses repair when the FTS table is not demonstrably searchable', () => {
    const { plan, digest } = buildPlan();
    database.db
      .prepare(
        `UPDATE messages_fts
         SET subject = '', body = '', participants = ''`
      )
      .run();

    expect(() =>
      repair({
        plan,
        planDigest: digest,
        identityProof: identityProof(),
        now: NOW,
      })
    ).toThrow('GMAIL_PARTITION_REPAIR_FTS_SEARCH_FAILED');
  });

  test('restores only provider-proved canonical tombstones and records new provider-only mail', () => {
    const originalLastSeenAt = '2026-07-26T00:00:00.000Z';
    const originalUpdatedAt = '2026-07-26T00:00:01.000Z';
    database.db
      .prepare(
        `UPDATE messages
         SET current_eligible = 0, deleted_remote = 1,
             last_seen_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(originalLastSeenAt, originalUpdatedAt, ids.anchored);
    const providerInventories = {
      ...PROVIDER_INVENTORIES,
      'gmail-ablative': [
        ...PROVIDER_INVENTORIES['gmail-ablative'],
        'new-provider-only',
      ],
    };
    const { plan, digest } = buildPlan(false, providerInventories);

    expect(plan.counts).toEqual({
      quarantineDuplicates: 2,
      moveProvedCanonicals: 1,
      restoreCanonicalStates: 1,
      providerOnlyNewMessages: 1,
      contaminatedRuns: 1,
      contaminatedErrors: 2,
    });
    expect(plan.providerOnlyEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logicalAccountId: 'gmail-ablative',
          count: 1,
          messageIdHashes: [expect.stringMatching(/^[a-f0-9]{64}$/)],
        }),
      ])
    );
    expect(plan.canonicalStateRepairs).toEqual([
      expect.objectContaining({
        messageId: ids.anchored,
        originalAccountId: 'gmail-ablative',
        targetAccountId: 'gmail-ablative',
        originalCurrentEligible: 0,
        originalDeletedRemote: 1,
        originalLastSeenAt,
        originalUpdatedAt,
        restoredCurrentEligible: 1,
        restoredDeletedRemote: 0,
        evidenceCode: 'LIVE_PROVIDER_OWNERSHIP',
      }),
    ]);

    const dryRun = repair({
      plan,
      planDigest: digest,
      identityProof: identityProof(),
      now: NOW,
    });
    const result = repair({
      plan,
      planDigest: digest,
      preconditionDigest: dryRun.preconditionDigest,
      identityProof: identityProof(),
      independentProviderInventories: providerInventories,
      apply: true,
      rehearsal: true,
      confirmation: GMAIL_PARTITION_REHEARSAL_CONFIRMATION,
      now: NOW,
    });

    expect(result).toEqual(
      expect.objectContaining({
        applied: true,
        changedRows: 4,
        ftsAccountMismatches: 0,
      })
    );
    expect(
      database.db
        .prepare(
          `SELECT account_id, current_eligible, deleted_remote,
                  last_seen_at, updated_at
           FROM messages WHERE id = ?`
        )
        .get(ids.anchored)
    ).toEqual({
      account_id: 'gmail-ablative',
      current_eligible: 1,
      deleted_remote: 0,
      last_seen_at: plan.generatedAt,
      updated_at: plan.generatedAt,
    });
    expect(
      database.db
        .prepare(
          `SELECT original_current_eligible, original_deleted_remote,
                  original_last_seen_at, original_updated_at,
                  restored_last_seen_at, restored_updated_at
           FROM identity_partition_repair_canonical_state
           WHERE migration_id = ? AND message_id = ?`
        )
        .get(GMAIL_PARTITION_REPAIR_ID, ids.anchored)
    ).toEqual({
      original_current_eligible: 0,
      original_deleted_remote: 1,
      original_last_seen_at: originalLastSeenAt,
      original_updated_at: originalUpdatedAt,
      restored_last_seen_at: plan.generatedAt,
      restored_updated_at: plan.generatedAt,
    });

    database.db
      .prepare(
        `UPDATE messages
         SET current_eligible = 0, deleted_remote = 1,
             last_seen_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        '2026-08-03T00:00:00.000Z',
        '2026-08-03T00:00:00.000Z',
        ids.anchored
      );
    expect(repair()).toEqual(
      expect.objectContaining({ status: 'already_applied', applied: false })
    );

    const canonicalEvidence = database.db
      .prepare(
        `SELECT evidence_digest
         FROM identity_partition_repair_canonical_state
         WHERE migration_id = ? AND message_id = ?`
      )
      .get(GMAIL_PARTITION_REPAIR_ID, ids.anchored).evidence_digest;
    database.db
      .prepare(
        `UPDATE identity_partition_repair_canonical_state
         SET evidence_digest = ?
         WHERE migration_id = ? AND message_id = ?`
      )
      .run('f'.repeat(64), GMAIL_PARTITION_REPAIR_ID, ids.anchored);
    expect(() => repair()).toThrow('GMAIL_PARTITION_REPAIR_POST_STATE_DRIFT');
    database.db
      .prepare(
        `UPDATE identity_partition_repair_canonical_state
         SET evidence_digest = ?
         WHERE migration_id = ? AND message_id = ?`
      )
      .run(canonicalEvidence, GMAIL_PARTITION_REPAIR_ID, ids.anchored);
    expect(repair()).toEqual(
      expect.objectContaining({ status: 'already_applied', applied: false })
    );

    database.db
      .prepare('UPDATE messages SET account_id = ? WHERE id = ?')
      .run('gmail-personal', ids.anchored);
    database.db
      .prepare('UPDATE messages_fts SET account_id = ? WHERE message_id = ?')
      .run('gmail-personal', ids.anchored);
    expect(() => repair()).toThrow('GMAIL_PARTITION_REPAIR_POST_STATE_DRIFT');
  });

  test('rejects a redigested plan that omits a required canonical state restoration', () => {
    database.db
      .prepare(
        `UPDATE messages
         SET current_eligible = 0, deleted_remote = 1
         WHERE id = ?`
      )
      .run(ids.anchored);
    const { plan } = buildPlan();
    plan.canonicalStateRepairs = [];
    plan.counts.restoreCanonicalStates = 0;

    expect(() =>
      repair({
        plan,
        planDigest: partitionRepairPlanDigest(plan),
        identityProof: identityProof(),
        now: NOW,
      })
    ).toThrow(
      'GMAIL_PARTITION_PLAN_INCOMPLETE: provider-proved canonical state is not restored exactly once'
    );
  });

  test('rejects a redigested plan that hides provider-only new mail', () => {
    const providerInventories = {
      ...PROVIDER_INVENTORIES,
      'gmail-ablative': [
        ...PROVIDER_INVENTORIES['gmail-ablative'],
        'new-provider-only',
      ],
    };
    const { plan } = buildPlan(false, providerInventories);
    const evidence = plan.providerOnlyEvidence.find(
      (item) => item.logicalAccountId === 'gmail-ablative'
    );
    evidence.messageIdHashes = [];
    evidence.count = 0;
    evidence.digest = crypto
      .createHash('sha256')
      .update(JSON.stringify([]))
      .digest('hex');
    plan.counts.providerOnlyNewMessages = 0;

    expect(() =>
      repair({
        plan,
        planDigest: partitionRepairPlanDigest(plan),
        identityProof: identityProof(),
        now: NOW,
      })
    ).toThrow(
      'GMAIL_PARTITION_PLAN_INCOMPLETE: provider-only new mail evidence changed'
    );
  });

  test.each([
    'actions',
    'canonicalStateRepairs',
    'providerInventoryEvidence',
    'providerOnlyEvidence',
    'anchorOwnershipEvidence',
  ])('requires %s to remain an explicit array', (field) => {
    const { plan } = buildPlan();
    plan[field] = null;

    expect(() =>
      repair({
        plan,
        planDigest: partitionRepairPlanDigest(plan),
        identityProof: identityProof(),
        now: NOW,
      })
    ).toThrow(
      'GMAIL_PARTITION_PLAN_INVALID: required evidence and action arrays are malformed'
    );
  });

  test('rehearses non-destructively, preserves children/blobs, and excludes quarantine from ordinary use', () => {
    const before = {
      blobs: database.db.prepare('SELECT COUNT(*) AS count FROM blobs').get()
        .count,
      recipients: database.db
        .prepare('SELECT COUNT(*) AS count FROM recipients')
        .get().count,
      attachments: database.db
        .prepare('SELECT COUNT(*) AS count FROM attachments')
        .get().count,
      messages: database.db
        .prepare('SELECT COUNT(*) AS count FROM messages')
        .get().count,
    };
    const { plan, digest } = buildPlan();
    const dryRun = repair({
      plan,
      planDigest: digest,
      identityProof: identityProof(),
      now: NOW,
    });
    const result = repair({
      plan,
      planDigest: digest,
      preconditionDigest: dryRun.preconditionDigest,
      identityProof: identityProof(),
      apply: true,
      rehearsal: true,
      confirmation: GMAIL_PARTITION_REHEARSAL_CONFIRMATION,
      now: NOW,
    });

    expect(result).toEqual(
      expect.objectContaining({
        migrationId: GMAIL_PARTITION_REPAIR_ID,
        mode: 'rehearsal',
        status: 'applied',
        applied: true,
        changedRows: 3,
        stableMessageIdsPreserved: true,
        childRowsPreserved: true,
        blobsPreserved: true,
        activeOverlap: 0,
        integrity: 'ok',
        foreignKeyProblems: 0,
      })
    );
    expect(
      database.db
        .prepare('SELECT account_id FROM messages WHERE id = ?')
        .get(ids.anchoredWrong)
    ).toEqual({ account_id: QUARANTINE_ACCOUNT_ID });
    expect(
      database.db
        .prepare('SELECT account_id FROM messages WHERE id = ?')
        .get(ids.postWrong)
    ).toEqual({ account_id: QUARANTINE_ACCOUNT_ID });
    expect(
      database.db
        .prepare('SELECT account_id FROM messages WHERE id = ?')
        .get(ids.tombstone)
    ).toEqual({ account_id: 'gmail-ablative' });
    expect(
      database.db
        .prepare('SELECT message_id FROM attachments WHERE message_id = ?')
        .get(ids.postWrong)
    ).toEqual({ message_id: ids.postWrong });
    expect({
      blobs: database.db.prepare('SELECT COUNT(*) AS count FROM blobs').get()
        .count,
      recipients: database.db
        .prepare('SELECT COUNT(*) AS count FROM recipients')
        .get().count,
      attachments: database.db
        .prepare('SELECT COUNT(*) AS count FROM attachments')
        .get().count,
      messages: database.db
        .prepare('SELECT COUNT(*) AS count FROM messages')
        .get().count,
    }).toEqual(before);
    expect(database.db.pragma('foreign_key_check')).toEqual([]);
    expect(database.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(
      database.db
        .prepare('SELECT enabled FROM accounts WHERE id = ?')
        .get(QUARANTINE_ACCOUNT_ID)
    ).toEqual({ enabled: 0 });
    expect(database.status().accounts.map((row) => row.id)).not.toContain(
      QUARANTINE_ACCOUNT_ID
    );
    expect(database.status().disabledAccounts).toEqual([
      expect.objectContaining({
        id: QUARANTINE_ACCOUNT_ID,
        message_count: 2,
      }),
    ]);
    expect(database.search('wrongcopytoken')).toEqual([]);
    expect(
      database.search('wrongcopytoken', { includeDisabled: true })
    ).toHaveLength(1);
    expect(database.listDeliveryJobs('pending')).toEqual([]);
    expect(
      database.db.prepare('SELECT COUNT(*) AS count FROM folders').get().count
    ).toBe(0);
    expect(
      database.db.prepare('SELECT COUNT(*) AS count FROM sync_cursors').get()
        .count
    ).toBe(0);
    expect(
      database.db
        .prepare(
          'SELECT COUNT(*) AS count FROM identity_partition_repair_state'
        )
        .get().count
    ).toBe(4);
    expect(
      database.db
        .prepare(
          'SELECT COUNT(*) AS count FROM identity_partition_repair_operational_records'
        )
        .get().count
    ).toBe(3);
    expect(
      database.db
        .prepare(
          `SELECT original_account_id, target_account_id, action
           FROM identity_partition_repair_operational_records
           WHERE table_name = 'ingestion_runs' AND row_id = ?`
        )
        .get(ids.runId)
    ).toEqual({
      original_account_id: 'gmail-ablative',
      target_account_id: 'gmail-ablative',
      action: 'provenance_only',
    });
    expect(
      database.db
        .prepare(
          `SELECT account_id FROM ingestion_errors
           WHERE error_code = 'WRONG_BINDING_FIXTURE'`
        )
        .get()
    ).toEqual({ account_id: QUARANTINE_ACCOUNT_ID });
    expect(
      database
        .unresolvedErrors(50)
        .some((error) => error.error_code === 'WRONG_BINDING_FIXTURE')
    ).toBe(false);
    expect(
      database
        .unresolvedErrors(50, { includeDisabled: true })
        .some((error) => error.error_code === 'WRONG_BINDING_FIXTURE')
    ).toBe(true);

    expect(repair()).toEqual(
      expect.objectContaining({
        status: 'already_applied',
        applied: false,
        changedRows: 0,
      })
    );
    const repairedOwnership = database.db
      .prepare('SELECT id, account_id FROM messages ORDER BY id')
      .all();
    expect(() => remapGmailIdentityIds(database, { apply: true })).toThrow(
      'GMAIL_REMAP_SUPERSEDED'
    );
    expect(remapGmailIdentityIds(database)).toEqual(
      expect.objectContaining({
        status: 'superseded',
        applied: false,
        changedRows: 0,
      })
    );
    expect(
      database.db
        .prepare('SELECT id, account_id FROM messages ORDER BY id')
        .all()
    ).toEqual(repairedOwnership);
  });

  test('permanent receipt rejects immutable audit-trail tampering', () => {
    const { plan, digest } = buildPlan();
    const dryRun = repair({
      plan,
      planDigest: digest,
      identityProof: identityProof(),
      now: NOW,
    });
    repair({
      plan,
      planDigest: digest,
      preconditionDigest: dryRun.preconditionDigest,
      identityProof: identityProof(),
      apply: true,
      rehearsal: true,
      confirmation: GMAIL_PARTITION_REHEARSAL_CONFIRMATION,
      now: NOW,
    });

    const mutations = [
      {
        select: database.db.prepare(
          `SELECT evidence_digest AS value
           FROM identity_partition_repair_messages
           WHERE migration_id = ? LIMIT 1`
        ),
        update: database.db.prepare(
          `UPDATE identity_partition_repair_messages
           SET evidence_digest = ?
           WHERE migration_id = ? AND message_id = (
             SELECT message_id FROM identity_partition_repair_messages
             WHERE migration_id = ? LIMIT 1
           )`
        ),
        changed: 'f'.repeat(64),
        migrationParameterCount: 2,
      },
      {
        select: database.db.prepare(
          `SELECT row_json AS value
           FROM identity_partition_repair_state
           WHERE migration_id = ? LIMIT 1`
        ),
        update: database.db.prepare(
          `UPDATE identity_partition_repair_state
           SET row_json = ?
           WHERE migration_id = ? AND table_name = (
             SELECT table_name FROM identity_partition_repair_state
             WHERE migration_id = ? LIMIT 1
           ) AND row_ordinal = (
             SELECT row_ordinal FROM identity_partition_repair_state
             WHERE migration_id = ? LIMIT 1
           )`
        ),
        changed: '{"tampered":true}',
        migrationParameterCount: 3,
      },
      {
        select: database.db.prepare(
          `SELECT target_account_id AS value
           FROM identity_partition_repair_operational_records
           WHERE migration_id = ? LIMIT 1`
        ),
        update: database.db.prepare(
          `UPDATE identity_partition_repair_operational_records
           SET target_account_id = ?
           WHERE migration_id = ? AND table_name = (
             SELECT table_name
             FROM identity_partition_repair_operational_records
             WHERE migration_id = ? LIMIT 1
           ) AND row_id = (
             SELECT row_id FROM identity_partition_repair_operational_records
             WHERE migration_id = ? LIMIT 1
           )`
        ),
        changed: 'tampered-account',
        migrationParameterCount: 3,
      },
      {
        select: database.db.prepare(
          `SELECT details_json AS value
           FROM identity_partition_repair_receipts
           WHERE migration_id = ?`
        ),
        update: database.db.prepare(
          `UPDATE identity_partition_repair_receipts
           SET details_json = ? WHERE migration_id = ?`
        ),
        changed: '{"tampered":true}',
        migrationParameterCount: 1,
      },
    ];

    for (const mutation of mutations) {
      const original = mutation.select.get(GMAIL_PARTITION_REPAIR_ID).value;
      const parameters = [
        mutation.changed,
        ...Array.from(
          { length: mutation.migrationParameterCount },
          () => GMAIL_PARTITION_REPAIR_ID
        ),
      ];
      mutation.update.run(...parameters);
      expect(() => repair()).toThrow('GMAIL_PARTITION_REPAIR_POST_STATE_DRIFT');
      parameters[0] = original;
      mutation.update.run(...parameters);
      expect(repair()).toEqual(
        expect.objectContaining({ status: 'already_applied' })
      );
    }
  });

  test('allows normal FTS growth and rowid refresh after repair', () => {
    const { plan, digest } = buildPlan();
    const dryRun = repair({
      plan,
      planDigest: digest,
      identityProof: identityProof(),
      now: NOW,
    });
    repair({
      plan,
      planDigest: digest,
      preconditionDigest: dryRun.preconditionDigest,
      identityProof: identityProof(),
      apply: true,
      rehearsal: true,
      confirmation: GMAIL_PARTITION_REHEARSAL_CONFIRMATION,
      now: NOW,
    });

    database.stageMessage(
      'gmail-ablative',
      fixtureMessage('normal-new-message', 'normal new message'),
      blob('normal-new-message')
    );
    expect(repair()).toEqual(
      expect.objectContaining({ status: 'already_applied', applied: false })
    );

    const ftsBefore = inspectFtsConsistency(database).rowsByMessageId.get(
      messageKey(ids.tombstone)
    ).fts_rowid;
    database.stageMessage(
      'gmail-ablative',
      fixtureMessage('deleted-only-a', 'legitimate refreshed message'),
      null
    );
    const ftsAfter = inspectFtsConsistency(database).rowsByMessageId.get(
      messageKey(ids.tombstone)
    ).fts_rowid;
    expect(ftsAfter).not.toBe(ftsBefore);
    expect(repair()).toEqual(
      expect.objectContaining({ status: 'already_applied', applied: false })
    );

    database.db
      .prepare('UPDATE messages_fts SET account_id = ? WHERE rowid = ?')
      .run('gmail-personal', ftsAfter);
    expect(() => repair()).toThrow(
      'GMAIL_PARTITION_REPAIR_FTS_ACCOUNT_MISMATCH'
    );
  });

  test('live mode remains owner-approval and confirmation gated', () => {
    const { plan, digest } = buildPlan(false);
    expect(() =>
      repair({
        plan,
        planDigest: digest,
        identityProof: identityProof(),
        apply: true,
        confirmation: GMAIL_PARTITION_REPAIR_CONFIRMATION,
        now: NOW,
      })
    ).toThrow('GMAIL_PARTITION_REPAIR_OWNER_APPROVAL_REQUIRED');
  });

  test.each([
    ['planDigest', '0'.repeat(64)],
    ['preconditionDigest', '1'.repeat(64)],
  ])(
    'core approval validation rejects a clone rehearsal bound to another %s',
    (field, mismatchedDigest) => {
      const plan = { generatedAt: new Date(NOW - 60_000).toISOString() };
      const planDigest = 'a'.repeat(64);
      const preconditionDigest = 'b'.repeat(64);
      const metadata = {
        schemaVersion: 1,
        operation: 'gmail-partition-live-repair',
        migrationId: GMAIL_PARTITION_REPAIR_ID,
        approved: true,
        approvalRole: 'archive-owner',
        approvalId: 'owner-approval:core-binding-test',
        approvedAt: new Date(NOW).toISOString(),
        planDigest,
        preconditionDigest,
        cloneRehearsal: {
          code: 'GMAIL_REHEARSAL_APPLIED_AND_VERIFIED',
          appliedToClone: true,
          secondInvocationNoOp: true,
          planDigest,
          preconditionDigest,
          postStateDigest: 'c'.repeat(64),
          [field]: mismatchedDigest,
        },
      };

      expect(() =>
        validateOwnerApprovalMetadata(metadata, {
          plan,
          planDigest,
          preconditionDigest,
          now: NOW,
        })
      ).toThrow('GMAIL_PARTITION_REPAIR_OWNER_APPROVAL_REQUIRED');
    }
  );

  test('rehearsal refuses self-consistent plan evidence without independent provider and anchor inputs', () => {
    const { plan, digest } = buildPlan();
    const dryRun = repair({
      plan,
      planDigest: digest,
      identityProof: identityProof(),
      now: NOW,
    });
    expect(() =>
      repairGmailPartitions(database, {
        plan,
        planDigest: digest,
        preconditionDigest: dryRun.preconditionDigest,
        identityProof: identityProof(),
        expectedIdentities: EXPECTED_IDENTITIES,
        rawMessageLoader: (row) => rawMessages.get(row.raw_blob_hash),
        apply: true,
        rehearsal: true,
        confirmation: GMAIL_PARTITION_REHEARSAL_CONFIRMATION,
        now: NOW,
      })
    ).toThrow('GMAIL_PARTITION_INDEPENDENT_EVIDENCE_REQUIRED');
  });

  test('rehearsal rejects an independently recollected provider inventory mismatch', () => {
    const { plan, digest } = buildPlan();
    const dryRun = repair({
      plan,
      planDigest: digest,
      identityProof: identityProof(),
      now: NOW,
    });
    expect(() =>
      repair({
        plan,
        planDigest: digest,
        preconditionDigest: dryRun.preconditionDigest,
        identityProof: identityProof(),
        independentProviderInventories: {
          ...PROVIDER_INVENTORIES,
          'gmail-ablative': ['anchored-a'],
        },
        apply: true,
        rehearsal: true,
        confirmation: GMAIL_PARTITION_REHEARSAL_CONFIRMATION,
        now: NOW,
      })
    ).toThrow('GMAIL_PARTITION_INDEPENDENT_EVIDENCE_MISMATCH');
  });

  test('allows independently observed additions only as archive-absent new-mail backlog', () => {
    const { plan, digest } = buildPlan();
    const dryRun = repair({
      plan,
      planDigest: digest,
      identityProof: identityProof(),
      now: NOW,
    });
    const result = repair({
      plan,
      planDigest: digest,
      preconditionDigest: dryRun.preconditionDigest,
      identityProof: identityProof(),
      independentProviderInventories: {
        ...PROVIDER_INVENTORIES,
        'gmail-ablative': [
          ...PROVIDER_INVENTORIES['gmail-ablative'],
          'arrived-after-plan',
        ],
      },
      apply: true,
      rehearsal: true,
      confirmation: GMAIL_PARTITION_REHEARSAL_CONFIRMATION,
      now: NOW,
    });

    expect(result).toEqual(
      expect.objectContaining({
        applied: true,
        independentProviderAdditions: 1,
      })
    );
  });

  test('rejects a fresh provider addition that collides with a local header-owned row', () => {
    const { plan, digest } = buildPlan();
    const dryRun = repair({
      plan,
      planDigest: digest,
      identityProof: identityProof(),
      now: NOW,
    });

    expect(() =>
      repair({
        plan,
        planDigest: digest,
        preconditionDigest: dryRun.preconditionDigest,
        identityProof: identityProof(),
        independentProviderInventories: {
          ...PROVIDER_INVENTORIES,
          'gmail-ablative': [
            ...PROVIDER_INVENTORIES['gmail-ablative'],
            'deleted-only-a',
          ],
        },
        apply: true,
        rehearsal: true,
        confirmation: GMAIL_PARTITION_REHEARSAL_CONFIRMATION,
        now: NOW,
      })
    ).toThrow(
      'GMAIL_PARTITION_INDEPENDENT_EVIDENCE_MISMATCH: provider addition collides with planned archive ownership'
    );
  });

  test('rejects a conflicting duplicate hash before producing a plan', () => {
    const conflictingBlob = blob('conflict');
    database.registerBlob(conflictingBlob);
    database.db
      .prepare(`UPDATE messages SET raw_blob_hash = ? WHERE id = ?`)
      .run(conflictingBlob.hash, ids.anchoredWrong);

    expect(() => buildPlan()).toThrow('GMAIL_PARTITION_PLAN_CONFLICT');
  });

  test('rejects provider evidence that no longer matches projected active ownership', () => {
    const { plan } = buildPlan();
    plan.providerInventoryEvidence.find(
      (item) => item.logicalAccountId === 'gmail-ablative'
    ).messageIdHashes = [];
    const digest = partitionRepairPlanDigest(plan);

    expect(() =>
      repair({
        plan,
        planDigest: digest,
        identityProof: identityProof(),
        now: NOW,
      })
    ).toThrow('GMAIL_PARTITION_PLAN_INVALID');
  });

  test('rejects anchor evidence that does not independently contain the canonical row', () => {
    const { plan } = buildPlan();
    const evidence = plan.anchorOwnershipEvidence.find(
      (item) => item.logicalAccountId === 'gmail-ablative'
    );
    evidence.messageIdHashes = [];
    evidence.count = 0;
    evidence.digest = crypto
      .createHash('sha256')
      .update(JSON.stringify([]))
      .digest('hex');

    expect(() =>
      repair({
        plan,
        planDigest: partitionRepairPlanDigest(plan),
        identityProof: identityProof(),
        now: NOW,
      })
    ).toThrow('GMAIL_PARTITION_PLAN_INVALID');
  });

  test('rejects provider evidence not tied to the fresh credential proof', () => {
    const { plan } = buildPlan();
    plan.providerInventoryEvidence[0].credentialSlot = 'different-slot';

    expect(() =>
      repair({
        plan,
        planDigest: partitionRepairPlanDigest(plan),
        identityProof: identityProof(),
        now: NOW,
      })
    ).toThrow('GMAIL_PARTITION_PLAN_INVALID');
  });

  test('dry-run identifies a pre-v10 schema and apply refuses it', () => {
    const { plan, digest } = buildPlan();
    for (const table of [
      'identity_partition_repair_canonical_state',
      'identity_partition_repair_operational_records',
      'identity_partition_repair_state',
      'identity_partition_repair_messages',
      'identity_partition_repair_receipts',
    ]) {
      database.db.exec(`DROP TABLE ${table}`);
    }
    const dryRun = repair({
      plan,
      planDigest: digest,
      identityProof: identityProof(),
      now: NOW,
    });
    expect(dryRun.repairSchemaConfigured).toBe(false);

    expect(() =>
      repair({
        plan,
        planDigest: digest,
        preconditionDigest: dryRun.preconditionDigest,
        identityProof: identityProof(),
        apply: true,
        rehearsal: true,
        confirmation: GMAIL_PARTITION_REHEARSAL_CONFIRMATION,
        now: NOW,
      })
    ).toThrow('GMAIL_PARTITION_REPAIR_SCHEMA_MISSING');
  });

  test('accepts a newly refreshed proof with the same approved logical binding', () => {
    const { plan, digest } = buildPlan();
    const later = NOW + 2 * 60 * 1000;

    expect(
      repair({
        plan,
        planDigest: digest,
        identityProof: identityProof(new Date(later).toISOString()),
        now: later,
      })
    ).toEqual(expect.objectContaining({ status: 'not_applied' }));
  });

  test('rejects forged-true exact-header facts after re-reading archived raw bytes', () => {
    const { plan } = buildPlan();
    const action = plan.actions.find(
      (item) => item.evidenceCode === 'EXACT_IDENTITY_HEADER'
    );
    const hostileRaw = Buffer.from(
      [
        'To: unrelated@example.test',
        'From: Synthetic <sender@example.test>',
        'Subject: Missing ownership headers',
        '',
        'Synthetic body',
      ].join('\r\n')
    );
    const hostileBlob = blob('hostile-header', hostileRaw);
    database.registerBlob(hostileBlob);
    database.db
      .prepare('UPDATE messages SET raw_blob_hash = ? WHERE id = ?')
      .run(hostileBlob.hash, ids.tombstone);
    rawMessages.set(hostileBlob.hash, hostileRaw);
    action.rawBlobHash = hostileBlob.hash;
    action.headerEvidence.rawBlobHash = hostileBlob.hash;
    // These values are deliberately left true. Before apply-time raw parsing,
    // a matching plan digest could make fabricated booleans look authoritative.
    action.headerEvidence.providerDeliveredToExactTarget = true;
    action.headerEvidence.toHeaderExactTarget = true;
    action.evidenceDigest = crypto
      .createHash('sha256')
      .update(JSON.stringify(action.headerEvidence))
      .digest('hex');

    expect(() =>
      repair({
        plan,
        planDigest: partitionRepairPlanDigest(plan),
        identityProof: identityProof(),
        now: NOW,
      })
    ).toThrow('GMAIL_PARTITION_HEADER_PROOF_UNAVAILABLE');
  });
});
