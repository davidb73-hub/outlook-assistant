const crypto = require('crypto');

const ACCOUNT_ID_PAIRS = Object.freeze({
  'gmail-ablative': 'gmail-personal',
  'gmail-personal': 'gmail-ablative',
});
const EXPECTED_CREDENTIAL_BINDINGS = Object.freeze({
  'gmail-ablative': 'personal',
  'gmail-personal': 'ablative',
});
const GMAIL_IDENTITY_REMAP_ID = '2026-07-18-gmail-semantic-account-id-remap-v1';
const GMAIL_IDENTITY_REMAP_CONFIRMATION = `APPLY_STATE_C:${GMAIL_IDENTITY_REMAP_ID}`;
const RECEIPT_TABLE = 'identity_migration_receipts';
const PARTITION_REPAIR_RECEIPT_TABLE = 'identity_partition_repair_receipts';
const PARTITION_REPAIR_MIGRATION_ID =
  '2026-08-02-gmail-mixed-partition-repair-v1';
const DEFAULT_IDENTITY_PROOF_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_OWNERSHIP_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function dbHandle(database) {
  const db = database?.db || database;
  if (!db?.prepare || !db?.transaction || !db?.pragma) {
    throw new Error('A SQLite database handle is required');
  }
  return db;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sha256Json(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function identityMatrixDigest(identityProof) {
  const accounts = [...(identityProof?.accounts || [])]
    // This digest is a Gmail-remediation contract. Outlook must pass the
    // top-level audit before apply, but adding its independently guarded row
    // must not invalidate an already reviewed Gmail ownership plan.
    .filter((account) =>
      Object.hasOwn(ACCOUNT_ID_PAIRS, account.logicalAccountId)
    )
    .map((account) => ({
      logicalAccountId: account.logicalAccountId,
      credentialSlot: account.credentialSlot,
      expectedIdentityConfigured: account.expectedIdentityConfigured === true,
      identityMatch: account.identityMatch === true,
      errorCode: account.errorCode || null,
    }))
    .sort((left, right) =>
      String(left.logicalAccountId).localeCompare(
        String(right.logicalAccountId)
      )
    );
  return sha256Json(accounts);
}

function ownershipManifestDigest(ownershipManifest) {
  return sha256Json(ownershipManifest);
}

function providerMessageIdHash(providerMessageId) {
  return crypto
    .createHash('sha256')
    .update(String(providerMessageId))
    .digest('hex');
}

function receiptTableExists(db) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM sqlite_schema
         WHERE type = 'table' AND name = ?`
      )
      .get(RECEIPT_TABLE)
  );
}

function readAppliedReceipt(db) {
  if (!receiptTableExists(db)) return null;
  return (
    db
      .prepare(
        `SELECT migration_id, precondition_digest, applied_at, details_json
         FROM ${quoteIdentifier(RECEIPT_TABLE)}
         WHERE migration_id = ?`
      )
      .get(GMAIL_IDENTITY_REMAP_ID) || null
  );
}

function targetedRepairSupersedesWholeRemap(db) {
  const tableExists = Boolean(
    db
      .prepare(
        `SELECT 1 FROM sqlite_schema
         WHERE type = 'table' AND name = ?`
      )
      .get(PARTITION_REPAIR_RECEIPT_TABLE)
  );
  if (!tableExists) return false;
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM ${quoteIdentifier(PARTITION_REPAIR_RECEIPT_TABLE)}
         WHERE migration_id = ?`
      )
      .get(PARTITION_REPAIR_MIGRATION_ID)
  );
}

function accountScopedColumns(database) {
  const db = dbHandle(database);
  const columns = [];
  const tables = db
    .prepare(
      `SELECT name
       FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all();

  for (const { name: table } of tables) {
    if (table === 'accounts' || table === RECEIPT_TABLE) continue;
    const tableIdentifier = quoteIdentifier(table);
    const tableColumns = db.pragma(`table_info(${tableIdentifier})`);
    const foreignKeys = db.pragma(`foreign_key_list(${tableIdentifier})`);
    for (const column of tableColumns) {
      const directAccountColumn = column.name === 'account_id';
      const accountForeignKey = foreignKeys.some(
        (foreignKey) =>
          foreignKey.table === 'accounts' &&
          foreignKey.from === column.name &&
          foreignKey.to === 'id'
      );
      if (directAccountColumn || accountForeignKey) {
        columns.push({ table, column: column.name });
      }
    }
  }
  return columns;
}

function inventoryAccountScopedRows(database, columns = null) {
  const db = dbHandle(database);
  const scopedColumns = columns || accountScopedColumns(db);
  return scopedColumns.map(({ table, column }) => {
    const tableIdentifier = quoteIdentifier(table);
    const columnIdentifier = quoteIdentifier(column);
    const statement = db.prepare(
      `SELECT COUNT(*) AS row_count
       FROM ${tableIdentifier}
       WHERE ${columnIdentifier} = ?`
    );
    return {
      table,
      column,
      rows: Object.fromEntries(
        Object.keys(ACCOUNT_ID_PAIRS).map((accountId) => [
          accountId,
          statement.get(accountId).row_count,
        ])
      ),
    };
  });
}

function tableCounts(db, scopedColumns) {
  return Object.fromEntries(
    [...new Set(scopedColumns.map(({ table }) => table))].map((table) => [
      table,
      db
        .prepare(`SELECT COUNT(*) AS row_count FROM ${quoteIdentifier(table)}`)
        .get().row_count,
    ])
  );
}

function stableMessageIdentityDigest(db) {
  const rows = db
    .prepare(
      `SELECT id, provider_message_id, raw_blob_hash
       FROM messages
       ORDER BY id`
    )
    .all();
  return sha256Json(rows);
}

function providerIdDigestForAccount(db, accountId) {
  return sha256Json(providerIdHashesForAccount(db, accountId));
}

function providerIdHashesForAccount(db, accountId) {
  return db
    .prepare(
      `SELECT provider_message_id
         FROM messages
         WHERE account_id = ?
         ORDER BY provider_message_id`
    )
    .all(accountId)
    .map((row) => providerMessageIdHash(row.provider_message_id))
    .sort();
}

function validatedEvidenceSet(evidence, label) {
  const hashes = evidence?.messageIdHashes;
  if (
    !Array.isArray(hashes) ||
    hashes.some((hash) => !/^[a-f0-9]{64}$/.test(String(hash)))
  ) {
    throw new Error(
      `GMAIL_REMAP_OWNERSHIP_UNPROVED: ${label} evidence IDs are invalid`
    );
  }
  const sorted = [...new Set(hashes)].sort();
  if (
    sorted.length !== hashes.length ||
    evidence.count !== sorted.length ||
    evidence.digest !== sha256Json(sorted)
  ) {
    throw new Error(
      `GMAIL_REMAP_OWNERSHIP_UNPROVED: ${label} evidence digest disagrees`
    );
  }
  return sorted;
}

function mixedPartitionStats(db) {
  return db
    .prepare(
      `SELECT COUNT(*) AS duplicate_provider_ids,
              COALESCE(SUM(
                CASE WHEN left_message.raw_blob_hash IS NOT right_message.raw_blob_hash
                     THEN 1 ELSE 0 END
              ), 0) AS conflicting_raw_hashes
       FROM messages AS left_message
       JOIN messages AS right_message
         ON right_message.provider_message_id = left_message.provider_message_id
        AND right_message.account_id = 'gmail-personal'
       WHERE left_message.account_id = 'gmail-ablative'`
    )
    .get();
}

function validateOwnershipManifest(
  database,
  ownershipManifest,
  {
    now = Date.now(),
    maxAgeMs = DEFAULT_OWNERSHIP_EVIDENCE_MAX_AGE_MS,
    suppliedDigest = null,
  } = {}
) {
  const db = dbHandle(database);
  const stats = mixedPartitionStats(db);
  if (stats.duplicate_provider_ids > 0 || stats.conflicting_raw_hashes > 0) {
    throw new Error(
      `GMAIL_REMAP_MIXED_PARTITIONS: whole-account swap is forbidden while ${stats.duplicate_provider_ids} provider IDs occur in both partitions`
    );
  }
  if (
    ownershipManifest?.schemaVersion !== 1 ||
    ownershipManifest?.migrationId !== GMAIL_IDENTITY_REMAP_ID ||
    ownershipManifest?.planType !== 'complete_account_swap' ||
    ownershipManifest?.state !== 'STATE_C' ||
    ownershipManifest?.evidenceKind !== 'provider_plus_immutable_anchor' ||
    ownershipManifest?.ownerApprovalRecorded !== true ||
    !/^[a-f0-9]{32,128}$/.test(
      String(ownershipManifest?.sourceSnapshotId || '')
    )
  ) {
    throw new Error(
      'GMAIL_REMAP_OWNERSHIP_UNPROVED: a complete provider-and-anchor ownership manifest is required'
    );
  }
  const evidenceTime = new Date(
    ownershipManifest.evidenceCreatedAt || ''
  ).getTime();
  if (
    !Number.isFinite(evidenceTime) ||
    evidenceTime > now + 30_000 ||
    now - evidenceTime > maxAgeMs
  ) {
    throw new Error(
      'GMAIL_REMAP_OWNERSHIP_UNPROVED: ownership evidence is absent or stale'
    );
  }
  const movements = ownershipManifest.movements || [];
  if (movements.length !== 2) {
    throw new Error(
      'GMAIL_REMAP_OWNERSHIP_UNPROVED: both account movements must be specified'
    );
  }
  const seenSources = new Set();
  for (const movement of movements) {
    const expectedTarget = ACCOUNT_ID_PAIRS[movement.fromAccountId];
    if (!expectedTarget || movement.toAccountId !== expectedTarget) {
      throw new Error(
        'GMAIL_REMAP_OWNERSHIP_UNPROVED: the ownership movement is incomplete'
      );
    }
    seenSources.add(movement.fromAccountId);
    const count = db
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE account_id = ?')
      .get(movement.fromAccountId).count;
    const archiveDigest = providerIdDigestForAccount(
      db,
      movement.fromAccountId
    );
    const archiveHashes = providerIdHashesForAccount(
      db,
      movement.fromAccountId
    );
    const providerEvidence = movement.evidence?.providerInventory;
    const anchorEvidence = movement.evidence?.anchorCanonical;
    if (
      providerEvidence?.logicalAccountId !== movement.toAccountId ||
      anchorEvidence?.logicalAccountId !== movement.toAccountId ||
      anchorEvidence?.snapshotId !== ownershipManifest.sourceSnapshotId
    ) {
      throw new Error(
        `GMAIL_REMAP_OWNERSHIP_UNPROVED: evidence targets disagree for ${movement.fromAccountId}`
      );
    }
    const providerHashes = validatedEvidenceSet(
      providerEvidence,
      'provider inventory'
    );
    const anchorHashes = validatedEvidenceSet(
      anchorEvidence,
      'immutable anchor'
    );
    const evidenceUnion = [
      ...new Set([...providerHashes, ...anchorHashes]),
    ].sort();
    const evidenceUnionDigest = sha256Json(evidenceUnion);
    if (
      movement.messageCount !== count ||
      movement.archiveProviderIdDigest !== archiveDigest ||
      movement.ownershipEvidenceDigest !==
        sha256Json({
          targetLogicalAccountId: movement.toAccountId,
          providerInventoryDigest: providerEvidence.digest,
          anchorCanonicalDigest: anchorEvidence.digest,
          sourceSnapshotId: ownershipManifest.sourceSnapshotId,
          unionDigest: evidenceUnionDigest,
        }) ||
      movement.ownershipUnionCount !== evidenceUnion.length ||
      movement.ownershipUnionDigest !== evidenceUnionDigest ||
      JSON.stringify(evidenceUnion) !== JSON.stringify(archiveHashes)
    ) {
      throw new Error(
        `GMAIL_REMAP_OWNERSHIP_UNPROVED: provider-and-anchor ownership does not match ${movement.fromAccountId}`
      );
    }
  }
  if (seenSources.size !== 2) {
    throw new Error(
      'GMAIL_REMAP_OWNERSHIP_UNPROVED: account movements are duplicated or missing'
    );
  }
  const digest = ownershipManifestDigest(ownershipManifest);
  if (
    typeof suppliedDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(suppliedDigest) ||
    suppliedDigest !== digest
  ) {
    throw new Error(
      'GMAIL_REMAP_OWNERSHIP_DIGEST_MISMATCH: the approved ownership plan changed'
    );
  }
  return { digest, stats };
}

function remapPreconditionDigest(
  database,
  identityProof,
  { ownershipPlanDigest, scopedColumns = null, inventory = null } = {}
) {
  const db = dbHandle(database);
  const resolvedColumns = scopedColumns || accountScopedColumns(db);
  const resolvedInventory =
    inventory || inventoryAccountScopedRows(db, resolvedColumns);
  return sha256Json({
    identityMatrixDigest: identityMatrixDigest(identityProof),
    ownershipPlanDigest,
    accountScopedInventory: resolvedInventory,
    tableCounts: tableCounts(db, resolvedColumns),
    stableMessageIdentityDigest: stableMessageIdentityDigest(db),
    integrity: db.pragma('integrity_check', { simple: true }),
    foreignKeyProblems: db.pragma('foreign_key_check').length,
  });
}

function appliedRemapStateDigest(database, { messageIdCutoff } = {}) {
  const db = dbHandle(database);
  if (!Number.isSafeInteger(messageIdCutoff) || messageIdCutoff < 0) {
    throw new Error(
      'GMAIL_REMAP_RECEIPT_UNVERIFIABLE: message cutoff is invalid'
    );
  }
  return sha256Json({
    messageIdCutoff,
    accounts: db
      .prepare(
        `SELECT id, provider, enabled
         FROM accounts
         WHERE id IN (?, ?)
         ORDER BY id`
      )
      .all(...Object.keys(ACCOUNT_ID_PAIRS)),
    messageOwnership: db
      .prepare(
        `SELECT id, account_id, provider_message_id, raw_blob_hash
         FROM messages
         WHERE account_id IN (?, ?)
           AND id <= ?
         ORDER BY id`
      )
      .all(...Object.keys(ACCOUNT_ID_PAIRS), messageIdCutoff)
      .map((row) => ({
        id: row.id,
        accountId: row.account_id,
        providerMessageIdHash: providerMessageIdHash(row.provider_message_id),
        rawBlobHash: row.raw_blob_hash,
      })),
    integrity: db.pragma('integrity_check', { simple: true }),
    foreignKeyProblems: db.pragma('foreign_key_check').length,
  });
}

function validateIdentityProof(
  identityProof,
  { now = Date.now(), maxAgeMs = DEFAULT_IDENTITY_PROOF_MAX_AGE_MS } = {}
) {
  if (!identityProof?.passed) {
    throw new Error(
      'GMAIL_REMAP_IDENTITY_UNPROVED: both Gmail identities must pass immediately before apply'
    );
  }
  const accounts = new Map(
    (identityProof.accounts || []).map((account) => [
      account.logicalAccountId,
      account,
    ])
  );
  const gmailRows = (identityProof.accounts || []).filter((account) =>
    Object.hasOwn(ACCOUNT_ID_PAIRS, account.logicalAccountId)
  );
  if (
    gmailRows.length !== Object.keys(ACCOUNT_ID_PAIRS).length ||
    new Set(gmailRows.map((account) => account.logicalAccountId)).size !==
      Object.keys(ACCOUNT_ID_PAIRS).length
  ) {
    throw new Error(
      'GMAIL_REMAP_IDENTITY_UNPROVED: the identity matrix is incomplete'
    );
  }
  for (const [logicalAccountId, credentialSlot] of Object.entries(
    EXPECTED_CREDENTIAL_BINDINGS
  )) {
    const account = accounts.get(logicalAccountId);
    const verifiedAt = new Date(account?.verifiedAt || '').getTime();
    if (
      !account ||
      account.credentialSlot !== credentialSlot ||
      account.expectedIdentityConfigured !== true ||
      account.identityMatch !== true ||
      account.errorCode ||
      !Number.isFinite(verifiedAt) ||
      verifiedAt > now + 30_000 ||
      now - verifiedAt > maxAgeMs
    ) {
      throw new Error(
        `GMAIL_REMAP_IDENTITY_UNPROVED: fresh proof is missing for ${logicalAccountId}`
      );
    }
  }
  return identityMatrixDigest(identityProof);
}

function assertDatabasePreconditions(db, scopedColumns) {
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') {
    throw new Error('GMAIL_REMAP_PRECONDITION_FAILED: integrity check failed');
  }
  const foreignKeyProblems = db.pragma('foreign_key_check');
  if (foreignKeyProblems.length > 0) {
    throw new Error(
      `GMAIL_REMAP_PRECONDITION_FAILED: ${foreignKeyProblems.length} foreign-key problems exist`
    );
  }
  const accounts = db
    .prepare(
      `SELECT id, provider FROM accounts
       WHERE id IN (?, ?)
       ORDER BY id`
    )
    .all(...Object.keys(ACCOUNT_ID_PAIRS));
  if (
    accounts.length !== 2 ||
    accounts.some((account) => account.provider !== 'gmail')
  ) {
    throw new Error(
      'GMAIL_REMAP_PRECONDITION_FAILED: both Gmail archive accounts are required'
    );
  }

  const temporaryIds = Object.fromEntries(
    Object.keys(ACCOUNT_ID_PAIRS).map((accountId) => [
      accountId,
      `__${GMAIL_IDENTITY_REMAP_ID}_${accountId}`,
    ])
  );
  const temporaryValues = Object.values(temporaryIds);
  const accountConflicts = db
    .prepare('SELECT COUNT(*) AS count FROM accounts WHERE id IN (?, ?)')
    .get(...temporaryValues).count;
  if (accountConflicts > 0) {
    throw new Error(
      'GMAIL_REMAP_PRECONDITION_FAILED: temporary account IDs already exist'
    );
  }
  for (const { table, column } of scopedColumns) {
    const conflicts = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM ${quoteIdentifier(table)}
         WHERE ${quoteIdentifier(column)} IN (?, ?)`
      )
      .get(...temporaryValues).count;
    if (conflicts > 0) {
      throw new Error(
        `GMAIL_REMAP_PRECONDITION_FAILED: temporary IDs exist in ${table}.${column}`
      );
    }
  }
  return temporaryIds;
}

function remapGmailIdentityIds(
  database,
  {
    apply = false,
    confirmation = null,
    identityProof = null,
    preconditionDigest = null,
    ownershipManifest = null,
    ownershipPlanDigest = null,
    migrationId = GMAIL_IDENTITY_REMAP_ID,
    now = Date.now(),
    identityProofMaxAgeMs = DEFAULT_IDENTITY_PROOF_MAX_AGE_MS,
  } = {}
) {
  const db = dbHandle(database);
  if (migrationId !== GMAIL_IDENTITY_REMAP_ID) {
    throw new Error(
      'GMAIL_REMAP_MIGRATION_ID_INVALID: this operation has one immutable migration ID'
    );
  }

  // The targeted mixed-partition repair is the terminal successor to this
  // historical whole-account swap. Once its immutable receipt exists, a swap
  // could only reverse known-correct partitions and is permanently disabled.
  if (targetedRepairSupersedesWholeRemap(db)) {
    if (apply) {
      throw new Error(
        'GMAIL_REMAP_SUPERSEDED: targeted partition repair permanently disabled the whole-account swap'
      );
    }
    return {
      migrationId: GMAIL_IDENTITY_REMAP_ID,
      mode: 'dry-run',
      status: 'superseded',
      applied: false,
      changedRows: 0,
      supersededBy: PARTITION_REPAIR_MIGRATION_ID,
      integrity: db.pragma('integrity_check', { simple: true }),
      foreignKeyProblems: db.pragma('foreign_key_check').length,
    };
  }

  const existingReceipt = readAppliedReceipt(db);
  if (existingReceipt) {
    let receiptDetails;
    try {
      receiptDetails = JSON.parse(existingReceipt.details_json);
    } catch {
      throw new Error(
        'GMAIL_REMAP_RECEIPT_UNVERIFIABLE: receipt details are invalid'
      );
    }
    const currentStateDigest = appliedRemapStateDigest(db, {
      messageIdCutoff: receiptDetails.messageIdCutoff,
    });
    if (
      !receiptDetails.postApplyStateDigest ||
      receiptDetails.postApplyStateDigest !== currentStateDigest
    ) {
      throw new Error(
        'GMAIL_REMAP_POST_STATE_DRIFT: applied state no longer matches its receipt'
      );
    }
    return {
      migrationId: GMAIL_IDENTITY_REMAP_ID,
      mode: apply ? 'apply' : 'dry-run',
      status: 'already_applied',
      applied: false,
      changedRows: 0,
      appliedAt: existingReceipt.applied_at,
      preconditionDigest: existingReceipt.precondition_digest,
      integrity: db.pragma('integrity_check', { simple: true }),
      foreignKeyProblems: db.pragma('foreign_key_check').length,
      postApplyStateDigest: currentStateDigest,
    };
  }

  const scopedColumns = accountScopedColumns(db);
  const inventory = inventoryAccountScopedRows(db, scopedColumns);
  let currentPreconditionDigest = null;
  let ownershipStatus = {
    ready: false,
    errorCode: 'GMAIL_REMAP_OWNERSHIP_MANIFEST_REQUIRED',
    mixedPartitions: mixedPartitionStats(db),
  };
  if (identityProof && ownershipManifest && ownershipPlanDigest) {
    validateIdentityProof(identityProof, {
      now,
      maxAgeMs: identityProofMaxAgeMs,
    });
    const ownership = validateOwnershipManifest(db, ownershipManifest, {
      now,
      suppliedDigest: ownershipPlanDigest,
    });
    ownershipStatus = {
      ready: true,
      errorCode: null,
      mixedPartitions: ownership.stats,
    };
    currentPreconditionDigest = remapPreconditionDigest(db, identityProof, {
      ownershipPlanDigest: ownership.digest,
      scopedColumns,
      inventory,
    });
  }
  const dryRun = {
    migrationId: GMAIL_IDENTITY_REMAP_ID,
    mode: 'dry-run',
    status: 'not_applied',
    applied: false,
    changedRows: 0,
    preconditionDigest: currentPreconditionDigest,
    ownershipStatus,
    receiptSchemaConfigured: receiptTableExists(db),
    accountScopedInventory: inventory,
    integrity: db.pragma('integrity_check', { simple: true }),
    foreignKeyProblems: db.pragma('foreign_key_check').length,
  };
  if (!apply) return dryRun;

  if (confirmation !== GMAIL_IDENTITY_REMAP_CONFIRMATION) {
    throw new Error(
      'GMAIL_REMAP_CONFIRMATION_REQUIRED: explicit STATE_C confirmation is required'
    );
  }
  validateIdentityProof(identityProof, {
    now,
    maxAgeMs: identityProofMaxAgeMs,
  });
  const ownership = validateOwnershipManifest(db, ownershipManifest, {
    now,
    suppliedDigest: ownershipPlanDigest,
  });
  if (!receiptTableExists(db)) {
    throw new Error(
      'GMAIL_REMAP_RECEIPT_SCHEMA_MISSING: apply the reviewed schema migration first'
    );
  }
  if (
    typeof preconditionDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(preconditionDigest) ||
    preconditionDigest !== currentPreconditionDigest
  ) {
    throw new Error(
      'GMAIL_REMAP_PRECONDITION_DIGEST_MISMATCH: rerun the identity matrix and obtain approval'
    );
  }

  const temporaryIds = assertDatabasePreconditions(db, scopedColumns);
  const beforeCounts = tableCounts(db, scopedColumns);
  const beforeMessageIdentityDigest = stableMessageIdentityDigest(db);
  const messageIdCutoff = db
    .prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages')
    .get().id;
  const appliedAt = new Date(now).toISOString();

  const applyTransaction = db.transaction(() => {
    db.pragma('defer_foreign_keys = ON');
    if (readAppliedReceipt(db)) {
      throw new Error(
        'GMAIL_REMAP_ALREADY_APPLIED: the persistent migration marker already exists'
      );
    }

    for (const [source, temporary] of Object.entries(temporaryIds)) {
      db.prepare('UPDATE accounts SET id = ? WHERE id = ?').run(
        temporary,
        source
      );
    }
    for (const { table, column } of scopedColumns) {
      const statement = db.prepare(
        `UPDATE ${quoteIdentifier(table)}
         SET ${quoteIdentifier(column)} = ?
         WHERE ${quoteIdentifier(column)} = ?`
      );
      for (const [source, temporary] of Object.entries(temporaryIds)) {
        statement.run(temporary, source);
      }
    }
    for (const [source, temporary] of Object.entries(temporaryIds)) {
      db.prepare('UPDATE accounts SET id = ? WHERE id = ?').run(
        ACCOUNT_ID_PAIRS[source],
        temporary
      );
    }
    for (const { table, column } of scopedColumns) {
      const statement = db.prepare(
        `UPDATE ${quoteIdentifier(table)}
         SET ${quoteIdentifier(column)} = ?
         WHERE ${quoteIdentifier(column)} = ?`
      );
      for (const [source, temporary] of Object.entries(temporaryIds)) {
        statement.run(ACCOUNT_ID_PAIRS[source], temporary);
      }
    }

    const afterCounts = tableCounts(db, scopedColumns);
    if (JSON.stringify(afterCounts) !== JSON.stringify(beforeCounts)) {
      throw new Error(
        'GMAIL_REMAP_POSTCONDITION_FAILED: account-scoped table counts changed'
      );
    }
    if (stableMessageIdentityDigest(db) !== beforeMessageIdentityDigest) {
      throw new Error(
        'GMAIL_REMAP_POSTCONDITION_FAILED: stable provider message identity changed'
      );
    }
    const foreignKeyProblems = db.pragma('foreign_key_check');
    if (foreignKeyProblems.length > 0) {
      throw new Error(
        `GMAIL_REMAP_POSTCONDITION_FAILED: ${foreignKeyProblems.length} foreign-key problems`
      );
    }
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new Error(
        'GMAIL_REMAP_POSTCONDITION_FAILED: integrity check failed'
      );
    }
    const details = {
      accountScopedInventory: inventory,
      ownershipPlanDigest: ownership.digest,
      messageIdCutoff,
      tableCounts: beforeCounts,
      stableProviderMessageIdentityPreserved: true,
      foreignKeyProblems: 0,
      integrity: 'ok',
    };
    details.postApplyStateDigest = appliedRemapStateDigest(db, {
      messageIdCutoff,
    });
    db.prepare(
      `INSERT INTO ${quoteIdentifier(RECEIPT_TABLE)}(
         migration_id, precondition_digest, applied_at, details_json
       ) VALUES (?, ?, ?, ?)`
    ).run(
      GMAIL_IDENTITY_REMAP_ID,
      preconditionDigest,
      appliedAt,
      JSON.stringify(details)
    );
    return details;
  });

  const details = applyTransaction();
  return {
    migrationId: GMAIL_IDENTITY_REMAP_ID,
    mode: 'apply',
    status: 'applied',
    applied: true,
    changedRows: Object.values(inventory).reduce(
      (total, item) =>
        total + Object.values(item.rows).reduce((sum, value) => sum + value, 0),
      0
    ),
    appliedAt,
    preconditionDigest,
    ...details,
  };
}

module.exports = {
  ACCOUNT_ID_PAIRS,
  DEFAULT_IDENTITY_PROOF_MAX_AGE_MS,
  DEFAULT_OWNERSHIP_EVIDENCE_MAX_AGE_MS,
  EXPECTED_CREDENTIAL_BINDINGS,
  GMAIL_IDENTITY_REMAP_CONFIRMATION,
  GMAIL_IDENTITY_REMAP_ID,
  PARTITION_REPAIR_MIGRATION_ID,
  PARTITION_REPAIR_RECEIPT_TABLE,
  RECEIPT_TABLE,
  accountScopedColumns,
  appliedRemapStateDigest,
  identityMatrixDigest,
  inventoryAccountScopedRows,
  mixedPartitionStats,
  ownershipManifestDigest,
  providerIdDigestForAccount,
  providerIdHashesForAccount,
  providerMessageIdHash,
  remapPreconditionDigest,
  remapGmailIdentityIds,
  targetedRepairSupersedesWholeRemap,
  validateIdentityProof,
  validateOwnershipManifest,
};
