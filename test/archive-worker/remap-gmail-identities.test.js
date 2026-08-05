const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ArchiveDatabase } = require('../../archive-worker/database');
const {
  GMAIL_IDENTITY_REMAP_CONFIRMATION,
  GMAIL_IDENTITY_REMAP_ID,
  RECEIPT_TABLE,
  accountScopedColumns,
  identityMatrixDigest,
  ownershipManifestDigest,
  providerIdDigestForAccount,
  providerIdHashesForAccount,
  remapGmailIdentityIds,
  validateIdentityProof,
} = require('../../archive-worker/remap-gmail-identities');

const NOW = Date.parse('2026-08-02T10:30:00.000Z');

const digestJson = (value) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

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

function message(providerMessageId) {
  return {
    providerMessageId,
    subject: 'fixture',
    receivedAt: '2026-07-18T00:00:00.000Z',
    direction: 'inbound',
    locations: [],
  };
}

describe('guarded Gmail identity remapping', () => {
  let root;
  let database;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-remap-test-'));
    database = new ArchiveDatabase(path.join(root, 'archive.sqlite3'));
    database.upsertAccount({
      id: 'gmail-ablative',
      provider: 'gmail',
      displayName: 'Ablative Gmail',
    });
    database.upsertAccount({
      id: 'gmail-personal',
      provider: 'gmail',
      displayName: 'Personal Gmail',
    });
    database.upsertFolder('gmail-ablative', {
      providerFolderId: 'inbox',
      displayName: 'Inbox',
      kind: 'inbox',
    });
    database.stageMessage('gmail-ablative', message('personal-message'), null);
    database.stageMessage('gmail-personal', message('ablative-message'), null);
    database.db.exec(`
      CREATE TABLE synthetic_account_state (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id),
        state TEXT NOT NULL
      );
      INSERT INTO synthetic_account_state(account_id, state)
      VALUES ('gmail-ablative', 'belongs-to-source');
    `);
  });

  afterEach(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function messageOwnership() {
    return database.db
      .prepare(
        `SELECT account_id, provider_message_id
         FROM messages
         ORDER BY provider_message_id`
      )
      .all();
  }

  function ownershipManifest() {
    const manifest = {
      schemaVersion: 1,
      migrationId: GMAIL_IDENTITY_REMAP_ID,
      planType: 'complete_account_swap',
      state: 'STATE_C',
      evidenceKind: 'provider_plus_immutable_anchor',
      evidenceCreatedAt: new Date(NOW).toISOString(),
      sourceSnapshotId: 'a'.repeat(64),
      ownerApprovalRecorded: true,
      movements: Object.entries({
        'gmail-ablative': 'gmail-personal',
        'gmail-personal': 'gmail-ablative',
      }).map(([fromAccountId, toAccountId]) => {
        const digest = providerIdDigestForAccount(database.db, fromAccountId);
        const hashes = providerIdHashesForAccount(database.db, fromAccountId);
        const providerInventory = {
          logicalAccountId: toAccountId,
          count: hashes.length,
          messageIdHashes: hashes,
          digest: digestJson(hashes),
        };
        const anchorCanonical = {
          logicalAccountId: toAccountId,
          snapshotId: 'a'.repeat(64),
          count: hashes.length,
          messageIdHashes: hashes,
          digest: digestJson(hashes),
        };
        const unionDigest = digestJson(hashes);
        return {
          fromAccountId,
          toAccountId,
          messageCount: database.db
            .prepare(
              'SELECT COUNT(*) AS count FROM messages WHERE account_id = ?'
            )
            .get(fromAccountId).count,
          archiveProviderIdDigest: digest,
          ownershipUnionCount: hashes.length,
          ownershipUnionDigest: unionDigest,
          ownershipEvidenceDigest: digestJson({
            targetLogicalAccountId: toAccountId,
            providerInventoryDigest: providerInventory.digest,
            anchorCanonicalDigest: anchorCanonical.digest,
            sourceSnapshotId: 'a'.repeat(64),
            unionDigest,
          }),
          evidence: { providerInventory, anchorCanonical },
        };
      }),
    };
    return {
      manifest,
      digest: ownershipManifestDigest(manifest),
    };
  }

  function dryRun() {
    const ownership = ownershipManifest();
    return remapGmailIdentityIds(database, {
      identityProof: identityProof(),
      ownershipManifest: ownership.manifest,
      ownershipPlanDigest: ownership.digest,
      now: NOW,
    });
  }

  function apply(preconditionDigest) {
    const ownership = ownershipManifest();
    return remapGmailIdentityIds(database, {
      apply: true,
      confirmation: GMAIL_IDENTITY_REMAP_CONFIRMATION,
      identityProof: identityProof(),
      preconditionDigest,
      ownershipManifest: ownership.manifest,
      ownershipPlanDigest: ownership.digest,
      now: NOW,
    });
  }

  test('is a read-only dry-run by default and inventories dynamic account columns', () => {
    const before = messageOwnership();
    const result = dryRun();

    expect(result).toEqual(
      expect.objectContaining({
        migrationId: GMAIL_IDENTITY_REMAP_ID,
        mode: 'dry-run',
        status: 'not_applied',
        applied: false,
        changedRows: 0,
        preconditionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        ownershipStatus: expect.objectContaining({ ready: true }),
        receiptSchemaConfigured: true,
        integrity: 'ok',
        foreignKeyProblems: 0,
      })
    );
    expect(result.accountScopedInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'synthetic_account_state',
          column: 'account_id',
        }),
        expect.objectContaining({ table: 'messages', column: 'account_id' }),
        expect.objectContaining({
          table: 'messages_fts',
          column: 'account_id',
        }),
      ])
    );
    expect(messageOwnership()).toEqual(before);
    expect(
      database.db
        .prepare(`SELECT COUNT(*) AS count FROM ${RECEIPT_TABLE}`)
        .get().count
    ).toBe(0);
  });

  test('refuses apply without explicit STATE_C confirmation or fresh identity proof', () => {
    const digest = dryRun().preconditionDigest;
    expect(() =>
      remapGmailIdentityIds(database, {
        apply: true,
        identityProof: identityProof(),
        preconditionDigest: digest,
        now: NOW,
      })
    ).toThrow('GMAIL_REMAP_CONFIRMATION_REQUIRED');
    expect(() =>
      remapGmailIdentityIds(database, {
        apply: true,
        confirmation: GMAIL_IDENTITY_REMAP_CONFIRMATION,
        identityProof: identityProof('2026-08-02T10:00:00.000Z'),
        preconditionDigest: digest,
        ownershipManifest: ownershipManifest().manifest,
        ownershipPlanDigest: ownershipManifest().digest,
        now: NOW,
      })
    ).toThrow('GMAIL_REMAP_IDENTITY_UNPROVED');
    expect(messageOwnership()).toEqual([
      {
        account_id: 'gmail-personal',
        provider_message_id: 'ablative-message',
      },
      {
        account_id: 'gmail-ablative',
        provider_message_id: 'personal-message',
      },
    ]);
  });

  test('accepts an additional proved Outlook row without changing the Gmail plan digest', () => {
    const gmailOnly = identityProof();
    const withOutlook = {
      ...gmailOnly,
      accounts: [
        ...gmailOnly.accounts,
        {
          logicalAccountId: 'vitasci-outlook',
          credentialSlot: 'default-delegated',
          expectedIdentityConfigured: true,
          identityMatch: true,
          verifiedAt: new Date(NOW).toISOString(),
          errorCode: null,
        },
      ],
    };

    expect(() =>
      validateIdentityProof(withOutlook, { now: NOW })
    ).not.toThrow();
    expect(identityMatrixDigest(withOutlook)).toBe(
      identityMatrixDigest(gmailOnly)
    );
  });

  test('rejects an approved digest after the database precondition changes', () => {
    const digest = dryRun().preconditionDigest;
    database.stageMessage('gmail-personal', message('later-message'), null);

    expect(() => apply(digest)).toThrow(
      'GMAIL_REMAP_PRECONDITION_DIGEST_MISMATCH'
    );
    expect(
      database.db
        .prepare(`SELECT COUNT(*) AS count FROM ${RECEIPT_TABLE}`)
        .get().count
    ).toBe(0);
  });

  test('refuses a whole-account swap when the archive has mixed duplicate partitions', () => {
    database.stageMessage('gmail-personal', message('personal-message'), null);
    const ownership = ownershipManifest();

    expect(() =>
      remapGmailIdentityIds(database, {
        apply: true,
        confirmation: GMAIL_IDENTITY_REMAP_CONFIRMATION,
        identityProof: identityProof(),
        ownershipManifest: ownership.manifest,
        ownershipPlanDigest: ownership.digest,
        preconditionDigest: 'a'.repeat(64),
        now: NOW,
      })
    ).toThrow('GMAIL_REMAP_MIXED_PARTITIONS');
  });

  test.each(['providerInventory', 'anchorCanonical'])(
    'rejects independently inconsistent %s ownership evidence',
    (evidenceName) => {
      const ownership = ownershipManifest();
      const movement = ownership.manifest.movements[0];
      const evidence = movement.evidence[evidenceName];
      const extraHash = 'f'.repeat(64);
      evidence.messageIdHashes = [
        ...evidence.messageIdHashes,
        extraHash,
      ].sort();
      evidence.count = evidence.messageIdHashes.length;
      evidence.digest = digestJson(evidence.messageIdHashes);
      const suppliedDigest = ownershipManifestDigest(ownership.manifest);

      expect(() =>
        remapGmailIdentityIds(database, {
          identityProof: identityProof(),
          ownershipManifest: ownership.manifest,
          ownershipPlanDigest: suppliedDigest,
          now: NOW,
        })
      ).toThrow('GMAIL_REMAP_OWNERSHIP_UNPROVED');
    }
  );

  test('applies once transactionally without changing stable message identities', () => {
    const beforeProviderIds = messageOwnership()
      .map((row) => row.provider_message_id)
      .sort();
    const result = apply(dryRun().preconditionDigest);
    const after = messageOwnership();

    expect(result).toEqual(
      expect.objectContaining({
        migrationId: GMAIL_IDENTITY_REMAP_ID,
        mode: 'apply',
        status: 'applied',
        applied: true,
        integrity: 'ok',
        foreignKeyProblems: 0,
        stableProviderMessageIdentityPreserved: true,
      })
    );
    expect(after).toEqual([
      {
        account_id: 'gmail-ablative',
        provider_message_id: 'ablative-message',
      },
      {
        account_id: 'gmail-personal',
        provider_message_id: 'personal-message',
      },
    ]);
    expect(after.map((row) => row.provider_message_id).sort()).toEqual(
      beforeProviderIds
    );
    expect(
      database.db
        .prepare('SELECT account_id FROM synthetic_account_state')
        .get()
    ).toEqual({ account_id: 'gmail-personal' });
    expect(database.db.pragma('foreign_key_check')).toEqual([]);
    expect(database.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(
      database.db
        .prepare(
          `SELECT migration_id, precondition_digest
           FROM ${RECEIPT_TABLE}`
        )
        .get()
    ).toEqual({
      migration_id: GMAIL_IDENTITY_REMAP_ID,
      precondition_digest: result.preconditionDigest,
    });
  });

  test('a second apply is a verified no-op and cannot toggle the data back', () => {
    const first = apply(dryRun().preconditionDigest);
    const afterFirst = messageOwnership();
    const second = remapGmailIdentityIds(database, {
      apply: true,
      migrationId: GMAIL_IDENTITY_REMAP_ID,
    });

    expect(first.status).toBe('applied');
    expect(second).toEqual(
      expect.objectContaining({
        status: 'already_applied',
        applied: false,
        changedRows: 0,
        integrity: 'ok',
        foreignKeyProblems: 0,
      })
    );
    expect(messageOwnership()).toEqual(afterFirst);
  });

  test('allows later mail while retaining a verified already-applied no-op', () => {
    apply(dryRun().preconditionDigest);
    database.stageMessage(
      'gmail-ablative',
      message('post-receipt-drift'),
      null
    );

    expect(remapGmailIdentityIds(database, { apply: true })).toEqual(
      expect.objectContaining({
        status: 'already_applied',
        applied: false,
        changedRows: 0,
      })
    );
  });

  test('fails closed when ownership of a migration-time row is tampered', () => {
    apply(dryRun().preconditionDigest);
    database.db
      .prepare(
        `UPDATE messages SET account_id = 'gmail-personal'
         WHERE provider_message_id = 'ablative-message'`
      )
      .run();

    expect(() => remapGmailIdentityIds(database, { apply: true })).toThrow(
      'GMAIL_REMAP_POST_STATE_DRIFT'
    );
  });

  test('an alternative migration ID cannot bypass the one-shot marker', () => {
    expect(() =>
      remapGmailIdentityIds(database, {
        migrationId: 'try-to-toggle-it-again',
      })
    ).toThrow('GMAIL_REMAP_MIGRATION_ID_INVALID');
  });

  test('discovers every current direct account_id column', () => {
    const actual = accountScopedColumns(database).map(
      ({ table, column }) => `${table}.${column}`
    );
    const expected = database.db
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`
      )
      .all()
      .flatMap(({ name }) =>
        database.db
          .pragma(`table_info("${name.replaceAll('"', '""')}")`)
          .filter((column) => column.name === 'account_id')
          .map((column) => `${name}.${column.name}`)
      );

    expect(actual.sort()).toEqual(expected.sort());
  });
});
