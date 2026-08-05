const crypto = require('crypto');
const {
  identityMatrixDigest,
  providerMessageIdHash,
  validateIdentityProof,
} = require('./remap-gmail-identities');
const { parseAddresses } = require('./providers/normalization');
const {
  FTS_ACCOUNT_UPDATE_SQL,
  inspectFtsConsistency,
  messageKey,
  scanFtsIndex,
} = require('./fts-index');

const GMAIL_PARTITION_REPAIR_ID = '2026-08-02-gmail-mixed-partition-repair-v1';
const GMAIL_PARTITION_REPAIR_CONFIRMATION = `APPLY_APPROVED:${GMAIL_PARTITION_REPAIR_ID}`;
const GMAIL_PARTITION_REHEARSAL_CONFIRMATION = `APPLY_REHEARSAL:${GMAIL_PARTITION_REPAIR_ID}`;
const OWNER_APPROVAL_SCHEMA_VERSION = 1;
const OWNER_APPROVAL_OPERATION = 'gmail-partition-live-repair';
const QUARANTINE_ACCOUNT_ID = 'gmail-identity-quarantine-2026-07-25';
const LOGICAL_ACCOUNT_IDS = Object.freeze(['gmail-ablative', 'gmail-personal']);
const EVIDENCE_CODES = new Set([
  'IMMUTABLE_ANCHOR_CANONICAL',
  'LIVE_PROVIDER_OWNERSHIP',
  'EXACT_IDENTITY_HEADER',
]);
const DURABLE_CONTENT_TABLES = Object.freeze([
  'blobs',
  'messages',
  'messages_fts',
  'recipients',
  'message_locations',
  'attachments',
  'message_events',
  'processing_queue',
  'attachment_security',
  'security_events',
  'attachment_security_blob',
  'delivery_jobs',
  'delivery_events',
]);

function dbHandle(database) {
  const db = database?.db || database;
  if (!db?.prepare || !db?.transaction || !db?.pragma) {
    throw new Error('A SQLite database handle is required');
  }
  return db;
}

function sha256Json(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function partitionRepairPlanDigest(plan) {
  return sha256Json(plan);
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function validateOwnerApprovalMetadata(
  metadata,
  {
    plan,
    planDigest,
    preconditionDigest,
    now = Date.now(),
    maxAgeMs = 24 * 60 * 60 * 1000,
  } = {}
) {
  const approvedAt = new Date(metadata?.approvedAt || '').getTime();
  const generatedAt = new Date(plan?.generatedAt || '').getTime();
  const rehearsal = metadata?.cloneRehearsal;
  if (
    metadata?.schemaVersion !== OWNER_APPROVAL_SCHEMA_VERSION ||
    metadata?.operation !== OWNER_APPROVAL_OPERATION ||
    metadata?.migrationId !== GMAIL_PARTITION_REPAIR_ID ||
    metadata?.approved !== true ||
    metadata?.approvalRole !== 'archive-owner' ||
    !/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(
      String(metadata?.approvalId || '')
    ) ||
    metadata?.planDigest !== planDigest ||
    metadata?.preconditionDigest !== preconditionDigest ||
    !Number.isFinite(approvedAt) ||
    !Number.isFinite(generatedAt) ||
    approvedAt < generatedAt ||
    approvedAt > now + 30_000 ||
    now - approvedAt > maxAgeMs ||
    rehearsal?.code !== 'GMAIL_REHEARSAL_APPLIED_AND_VERIFIED' ||
    rehearsal?.appliedToClone !== true ||
    rehearsal?.secondInvocationNoOp !== true ||
    rehearsal?.planDigest !== planDigest ||
    rehearsal?.preconditionDigest !== preconditionDigest ||
    !/^[a-f0-9]{64}$/.test(String(rehearsal?.postStateDigest || ''))
  ) {
    throw new Error(
      'GMAIL_PARTITION_REPAIR_OWNER_APPROVAL_REQUIRED: approval metadata is absent, stale, or not bound to the reviewed plan and clone rehearsal'
    );
  }
  return {
    approvalId: metadata.approvalId,
    approvalRole: metadata.approvalRole,
    approvedAt: new Date(approvedAt).toISOString(),
    cloneRehearsalPostStateDigest: rehearsal.postStateDigest,
  };
}

function tableExists(db, tableName) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM sqlite_schema
         WHERE type = 'table' AND name = ?`
      )
      .get(tableName)
  );
}

function repairSchemaConfigured(db) {
  return [
    'identity_partition_repair_receipts',
    'identity_partition_repair_messages',
    'identity_partition_repair_canonical_state',
    'identity_partition_repair_state',
    'identity_partition_repair_operational_records',
  ].every((tableName) => tableExists(db, tableName));
}

function durableContentCounts(db) {
  return Object.fromEntries(
    DURABLE_CONTENT_TABLES.map((table) => [
      table,
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
    ])
  );
}

function durableContentDigest(db) {
  const hash = crypto.createHash('sha256');
  for (const table of DURABLE_CONTENT_TABLES) {
    hash.update(`table:${table}\n`);
    let largeDerivedColumns = [];
    let allowedMutationColumns = [];
    if (table === 'messages') {
      largeDerivedColumns = [
        'body_text',
        'body_html',
        'body_preview',
        'source_json',
      ];
      allowedMutationColumns = [
        'account_id',
        'current_eligible',
        'deleted_remote',
        'last_seen_at',
        'updated_at',
      ];
    } else if (table === 'messages_fts') {
      largeDerivedColumns = ['subject', 'body', 'participants'];
      allowedMutationColumns = ['account_id'];
    }
    const excluded = new Set([
      ...largeDerivedColumns,
      ...allowedMutationColumns,
    ]);
    const columns = db
      .pragma(`table_info(${table})`)
      .map((column) => column.name)
      .filter((column) => !excluded.has(column));
    if (columns.some((column) => !/^[a-z0-9_]+$/i.test(column))) {
      throw new Error(
        'GMAIL_PARTITION_REPAIR_PRECONDITION_FAILED: unsafe schema identifier'
      );
    }
    const lengthColumns = largeDerivedColumns.map(
      (column) => `length(CAST("${column}" AS BLOB)) AS "${column}_byte_length"`
    );
    const projection = [
      'rowid',
      ...columns.map((column) => `"${column}"`),
      ...lengthColumns,
    ].join(', ');
    for (const row of db
      .prepare(`SELECT ${projection} FROM "${table}" ORDER BY rowid`)
      .iterate()) {
      hash.update(JSON.stringify(row));
      hash.update('\n');
    }
  }
  return hash.digest('hex');
}

function ftsSearchFingerprint(db) {
  const terms = ['the', 'and', 'to', 'from', 'synthetic'];
  const search = db.prepare(
    `SELECT COUNT(*) AS count
     FROM messages_fts
     WHERE messages_fts MATCH ?`
  );
  const counts = terms.map((term) => search.get(term).count);
  const totalHits = counts.reduce((total, count) => total + count, 0);
  return {
    digest: sha256Json(counts),
    searchable: totalHits > 0,
  };
}

function mutableMessageState(db) {
  return db
    .prepare(
      `SELECT id, account_id, current_eligible, deleted_remote,
              last_seen_at, updated_at
       FROM messages
       ORDER BY id`
    )
    .all();
}

function projectedMutableMessageState(beforeRows, actions, stateRepairs) {
  const projected = new Map(beforeRows.map((row) => [row.id, { ...row }]));
  for (const action of actions) {
    const row = projected.get(action.messageId);
    if (!row) {
      throw new Error(
        'GMAIL_PARTITION_REPAIR_PRECONDITION_FAILED: planned mutable row is missing'
      );
    }
    row.account_id = action.toAccountId;
  }
  for (const repair of stateRepairs) {
    const row = projected.get(repair.messageId);
    if (!row) {
      throw new Error(
        'GMAIL_PARTITION_REPAIR_PRECONDITION_FAILED: canonical state row is missing'
      );
    }
    row.current_eligible = 1;
    row.deleted_remote = 0;
    row.last_seen_at = repair.restoredLastSeenAt;
    row.updated_at = repair.restoredUpdatedAt;
  }
  return [...projected.values()];
}

function ftsAccountMismatchCount(db) {
  const summary = inspectFtsConsistency(db).summary;
  return (
    summary.accountMismatches +
    summary.missingRows +
    summary.orphanRows +
    summary.duplicateRows
  );
}

function valuesFor(mapOrObject, key) {
  const value =
    mapOrObject instanceof Map ? mapOrObject.get(key) : mapOrObject?.[key];
  return value instanceof Set ? [...value] : [...(value || [])];
}

function normalizedExpectedIdentities(expectedIdentities) {
  const entries = LOGICAL_ACCOUNT_IDS.map((accountId) => [
    accountId,
    String(
      expectedIdentities instanceof Map
        ? expectedIdentities.get(accountId) || ''
        : expectedIdentities?.[accountId] || ''
    )
      .trim()
      .toLowerCase(),
  ]);
  if (
    entries.some(([, identity]) => !identity) ||
    new Set(entries.map(([, identity]) => identity)).size !== entries.length
  ) {
    throw new Error(
      'GMAIL_PARTITION_HEADER_PROOF_UNAVAILABLE: expected identities are missing or ambiguous'
    );
  }
  return new Map(entries);
}

function expectedIdentityBindingDigest(expectedIdentities) {
  const identities = normalizedExpectedIdentities(expectedIdentities);
  return sha256Json(
    LOGICAL_ACCOUNT_IDS.map((logicalAccountId) => ({
      logicalAccountId,
      identityHash: crypto
        .createHash('sha256')
        .update(identities.get(logicalAccountId))
        .digest('hex'),
    }))
  );
}

function parseRawHeaderMap(rawContent) {
  if (!Buffer.isBuffer(rawContent)) {
    throw new Error(
      'GMAIL_PARTITION_HEADER_PROOF_UNAVAILABLE: raw message bytes are required'
    );
  }
  const separator = rawContent.indexOf(Buffer.from('\r\n\r\n'));
  const fallbackSeparator = rawContent.indexOf(Buffer.from('\n\n'));
  const end = separator >= 0 ? separator : fallbackSeparator;
  if (end < 0 || end > 256 * 1024) {
    throw new Error(
      'GMAIL_PARTITION_HEADER_PROOF_UNAVAILABLE: raw headers are malformed or oversized'
    );
  }
  const text = rawContent.subarray(0, end).toString('latin1');
  if (text.includes('\0')) {
    throw new Error(
      'GMAIL_PARTITION_HEADER_PROOF_UNAVAILABLE: raw headers are malformed'
    );
  }
  const unfolded = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (unfolded.length === 0) {
        throw new Error(
          'GMAIL_PARTITION_HEADER_PROOF_UNAVAILABLE: raw headers are malformed'
        );
      }
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    } else unfolded.push(line);
  }
  const headers = new Map();
  for (const line of unfolded) {
    const delimiter = line.indexOf(':');
    if (delimiter <= 0) {
      throw new Error(
        'GMAIL_PARTITION_HEADER_PROOF_UNAVAILABLE: raw headers are malformed'
      );
    }
    const name = line.slice(0, delimiter).trim().toLowerCase();
    const value = line.slice(delimiter + 1).trim();
    if (!/^[a-z0-9-]+$/.test(name)) {
      throw new Error(
        'GMAIL_PARTITION_HEADER_PROOF_UNAVAILABLE: raw headers are malformed'
      );
    }
    const values = headers.get(name) || [];
    values.push(value);
    headers.set(name, values);
  }
  return headers;
}

function addressesForHeaders(headers, names) {
  return names.flatMap((name) =>
    (headers.get(name) || []).flatMap((value) =>
      parseAddresses(value, name).map((entry) =>
        String(entry.address || '')
          .trim()
          .toLowerCase()
      )
    )
  );
}

function deriveExactHeaderEvidence({
  row,
  rawContent,
  expectedIdentities,
  identityProof,
  inboxPresent,
}) {
  if (
    crypto.createHash('sha256').update(rawContent).digest('hex') !==
    row.raw_blob_hash
  ) {
    throw new Error(
      'GMAIL_PARTITION_HEADER_PROOF_UNAVAILABLE: raw message digest disagrees'
    );
  }
  const identities = normalizedExpectedIdentities(expectedIdentities);
  const headers = parseRawHeaderMap(rawContent);
  const deliveredTo = addressesForHeaders(headers, ['delivered-to']);
  const to = addressesForHeaders(headers, ['to']);
  const allIdentityHeaders = addressesForHeaders(headers, [
    'delivered-to',
    'from',
    'sender',
    'to',
    'cc',
    'bcc',
    'reply-to',
    'return-path',
  ]);
  const forwardingOrResentHeadersPresent = [...headers.keys()].some(
    (name) =>
      name.startsWith('resent-') ||
      ['forwarded', 'x-forwarded-for', 'x-forwarded-to'].includes(name)
  );
  const matches = LOGICAL_ACCOUNT_IDS.filter((logicalAccountId) => {
    const target = identities.get(logicalAccountId);
    const other = identities.get(
      LOGICAL_ACCOUNT_IDS.find((item) => item !== logicalAccountId)
    );
    return (
      deliveredTo.includes(target) &&
      to.includes(target) &&
      !allIdentityHeaders.includes(other)
    );
  });
  if (
    matches.length !== 1 ||
    row.direction !== 'inbound' ||
    inboxPresent !== true ||
    forwardingOrResentHeadersPresent
  ) {
    throw new Error(
      'GMAIL_PARTITION_HEADER_PROOF_UNAVAILABLE: exact ownership facts are not uniquely proved'
    );
  }
  const targetAccountId = matches[0];
  const otherAccountId = LOGICAL_ACCOUNT_IDS.find(
    (item) => item !== targetAccountId
  );
  return {
    targetAccountId,
    evidenceCode: 'EXACT_IDENTITY_HEADER',
    headerEvidence: {
      providerMessageIdHash: providerMessageIdHash(row.provider_message_id),
      rawBlobHash: row.raw_blob_hash,
      targetAccountId,
      identityMatrixDigest: identityMatrixDigest(identityProof),
      expectedIdentityBindingDigest:
        expectedIdentityBindingDigest(expectedIdentities),
      directionInbound: true,
      inboxPresent: true,
      providerDeliveredToExactTarget: true,
      toHeaderExactTarget: true,
      otherIdentityExactMatch: allIdentityHeaders.includes(
        identities.get(otherAccountId)
      ),
      forwardingOrResentHeadersPresent,
    },
  };
}

function gmailMessages(db) {
  return db
    .prepare(
      `SELECT id, account_id, provider_message_id, raw_blob_hash,
              current_eligible, deleted_remote, first_archived_at,
              last_seen_at, updated_at, direction
       FROM messages
       WHERE account_id IN ('gmail-ablative', 'gmail-personal')
       ORDER BY provider_message_id, id`
    )
    .all();
}

function contaminatedOperationalIds(db, window) {
  const startedAt = new Date(window?.startedAt || '').toISOString();
  const endedAt = new Date(window?.endedAt || '').toISOString();
  return {
    ingestionRuns: db
      .prepare(
        `SELECT id FROM ingestion_runs
         WHERE account_id IN ('gmail-ablative', 'gmail-personal')
           AND started_at >= ? AND started_at <= ?
         ORDER BY id`
      )
      .all(startedAt, endedAt)
      .map((row) => row.id),
    ingestionErrors: db
      .prepare(
        `SELECT id FROM ingestion_errors
         WHERE account_id IN ('gmail-ablative', 'gmail-personal')
           AND created_at >= ? AND created_at <= ?
         ORDER BY id`
      )
      .all(startedAt, endedAt)
      .map((row) => row.id),
  };
}

function buildGmailPartitionRepairPlan({
  database,
  anchorDatabase,
  providerInventories,
  identityProof,
  expectedIdentities,
  rawMessageLoader,
  anchorSnapshotId,
  contaminationWindow,
  generatedAt = new Date().toISOString(),
  ownerApprovalRecorded = false,
}) {
  const db = dbHandle(database);
  const anchorDb = dbHandle(anchorDatabase);
  const providerSets = new Map(
    LOGICAL_ACCOUNT_IDS.map((accountId) => [
      accountId,
      new Set(valuesFor(providerInventories, accountId)),
    ])
  );
  for (const providerMessageId of providerSets.get('gmail-ablative')) {
    if (providerSets.get('gmail-personal').has(providerMessageId)) {
      throw new Error(
        'GMAIL_PARTITION_PLAN_AMBIGUOUS: provider inventories overlap'
      );
    }
  }

  const anchorByProviderId = new Map();
  for (const row of anchorDb
    .prepare(
      `SELECT id, account_id, provider_message_id, raw_blob_hash
       FROM messages
       WHERE account_id IN ('gmail-ablative', 'gmail-personal')
       ORDER BY provider_message_id`
    )
    .all()) {
    if (anchorByProviderId.has(row.provider_message_id)) {
      throw new Error(
        'GMAIL_PARTITION_PLAN_AMBIGUOUS: immutable anchor ownership overlaps'
      );
    }
    anchorByProviderId.set(row.provider_message_id, row);
  }

  const currentRows = gmailMessages(db);
  const currentByProviderId = new Map();
  for (const row of currentRows) {
    if (!currentByProviderId.has(row.provider_message_id)) {
      currentByProviderId.set(row.provider_message_id, []);
    }
    currentByProviderId.get(row.provider_message_id).push(row);
  }

  const actions = [];
  const addQuarantine = (wrong, canonical, evidenceCode) => {
    if (wrong.raw_blob_hash !== canonical.raw_blob_hash) {
      throw new Error(
        'GMAIL_PARTITION_PLAN_CONFLICT: duplicate raw hashes disagree'
      );
    }
    actions.push({
      messageId: wrong.id,
      fromAccountId: wrong.account_id,
      toAccountId: QUARANTINE_ACCOUNT_ID,
      canonicalMessageId: canonical.id,
      canonicalAccountId: canonical.account_id,
      action: 'quarantine_duplicate',
      evidenceCode,
      evidenceDigest: null,
      providerMessageIdHash: providerMessageIdHash(wrong.provider_message_id),
      rawBlobHash: wrong.raw_blob_hash,
    });
  };
  const addMove = (
    row,
    targetAccountId,
    evidenceCode,
    evidenceDigest = null,
    headerEvidence = null
  ) => {
    actions.push({
      messageId: row.id,
      fromAccountId: row.account_id,
      toAccountId: targetAccountId,
      canonicalMessageId: null,
      canonicalAccountId: targetAccountId,
      action: 'move_proved_canonical',
      evidenceCode,
      evidenceDigest,
      headerEvidence,
      providerMessageIdHash: providerMessageIdHash(row.provider_message_id),
      rawBlobHash: row.raw_blob_hash,
    });
  };

  for (const [providerMessageId, rows] of currentByProviderId) {
    const providerOwners = LOGICAL_ACCOUNT_IDS.filter((accountId) =>
      providerSets.get(accountId).has(providerMessageId)
    );
    if (providerOwners.length > 1) {
      throw new Error(
        'GMAIL_PARTITION_PLAN_AMBIGUOUS: provider ownership is not unique'
      );
    }
    const anchor = anchorByProviderId.get(providerMessageId);
    if (
      providerOwners.length === 1 &&
      anchor &&
      providerOwners[0] !== anchor.account_id
    ) {
      throw new Error(
        'GMAIL_PARTITION_PLAN_CONFLICT: live provider and immutable anchor disagree'
      );
    }
    let targetAccountId = providerOwners[0] || anchor?.account_id || null;
    let evidenceCode = 'LIVE_PROVIDER_OWNERSHIP';
    let evidenceDigest = null;
    let headerEvidence = null;
    if (!targetAccountId) {
      if (rows.length !== 1 || typeof rawMessageLoader !== 'function') {
        throw new Error(
          'GMAIL_PARTITION_HEADER_PROOF_UNAVAILABLE: raw message loader is required'
        );
      }
      const inboxPresent = Boolean(
        db
          .prepare(
            `SELECT 1 FROM message_locations
             WHERE message_id = ? AND kind = 'inbox'`
          )
          .get(rows[0].id)
      );
      const attribution = deriveExactHeaderEvidence({
        row: rows[0],
        rawContent: rawMessageLoader(rows[0]),
        expectedIdentities,
        identityProof,
        inboxPresent,
      });
      targetAccountId = attribution.targetAccountId;
      evidenceCode = attribution.evidenceCode;
      headerEvidence = attribution.headerEvidence;
      evidenceDigest = sha256Json(headerEvidence);
    }
    if (!LOGICAL_ACCOUNT_IDS.includes(targetAccountId)) {
      throw new Error(
        'GMAIL_PARTITION_PLAN_AMBIGUOUS: a current row has no proved owner'
      );
    }
    let canonical = rows.find((row) => row.account_id === targetAccountId);
    if (anchor) {
      evidenceCode = 'IMMUTABLE_ANCHOR_CANONICAL';
      canonical = rows.find(
        (row) =>
          row.id === anchor.id &&
          row.account_id === anchor.account_id &&
          row.raw_blob_hash === anchor.raw_blob_hash
      );
      if (!canonical) {
        throw new Error(
          'GMAIL_PARTITION_PLAN_CONFLICT: immutable canonical row changed'
        );
      }
    }
    if (canonical) {
      for (const row of rows) {
        if (row.id !== canonical.id) {
          addQuarantine(row, canonical, evidenceCode);
        }
      }
    } else if (rows.length === 1) {
      addMove(
        rows[0],
        targetAccountId,
        evidenceCode,
        evidenceDigest,
        headerEvidence
      );
    } else {
      throw new Error(
        'GMAIL_PARTITION_PLAN_AMBIGUOUS: no unique canonical row exists'
      );
    }
  }

  const providerInventoryEvidence = LOGICAL_ACCOUNT_IDS.map(
    (logicalAccountId) => {
      const messageIdHashes = sortedUnique(
        [...providerSets.get(logicalAccountId)].map(providerMessageIdHash)
      );
      const identity = identityProof.accounts.find(
        (account) => account.logicalAccountId === logicalAccountId
      );
      return {
        logicalAccountId,
        credentialSlot: identity?.credentialSlot || null,
        identityMatrixDigest: identityMatrixDigest(identityProof),
        collectedAt: generatedAt,
        count: messageIdHashes.length,
        digest: sha256Json(messageIdHashes),
        messageIdHashes,
      };
    }
  );
  const anchorOwnershipEvidence = LOGICAL_ACCOUNT_IDS.map(
    (logicalAccountId) => {
      const messageIdHashes = sortedUnique(
        [...anchorByProviderId.values()]
          .filter((row) => row.account_id === logicalAccountId)
          .map((row) => providerMessageIdHash(row.provider_message_id))
      );
      return {
        logicalAccountId,
        snapshotId: anchorSnapshotId,
        count: messageIdHashes.length,
        digest: sha256Json(messageIdHashes),
        messageIdHashes,
      };
    }
  );
  const providerEvidenceByAccount = new Map(
    providerInventoryEvidence.map((evidence) => [
      evidence.logicalAccountId,
      evidence,
    ])
  );
  const anchorEvidenceByAccount = new Map(
    anchorOwnershipEvidence.map((evidence) => [
      evidence.logicalAccountId,
      evidence,
    ])
  );
  for (const action of actions) {
    if (action.evidenceDigest) continue;
    const evidence =
      action.evidenceCode === 'IMMUTABLE_ANCHOR_CANONICAL'
        ? anchorEvidenceByAccount.get(action.canonicalAccountId)
        : providerEvidenceByAccount.get(action.canonicalAccountId);
    action.evidenceDigest = evidence?.digest || null;
  }
  const projectedAccount = new Map(
    currentRows.map((row) => [row.id, row.account_id])
  );
  for (const action of actions) {
    projectedAccount.set(action.messageId, action.toAccountId);
  }
  const providerOnlyEvidence = LOGICAL_ACCOUNT_IDS.map((logicalAccountId) => {
    const messageIdHashes = sortedUnique(
      [...providerSets.get(logicalAccountId)]
        .filter(
          (providerMessageId) => !currentByProviderId.has(providerMessageId)
        )
        .map(providerMessageIdHash)
    );
    return {
      logicalAccountId,
      providerInventoryDigest:
        providerEvidenceByAccount.get(logicalAccountId).digest,
      count: messageIdHashes.length,
      digest: sha256Json(messageIdHashes),
      messageIdHashes,
    };
  });
  const canonicalStateRepairs = [];
  for (const logicalAccountId of LOGICAL_ACCOUNT_IDS) {
    const providerEvidence = providerEvidenceByAccount.get(logicalAccountId);
    for (const providerMessageId of providerSets.get(logicalAccountId)) {
      const rows = currentByProviderId.get(providerMessageId) || [];
      if (rows.length === 0) continue;
      const canonicals = rows.filter(
        (row) => projectedAccount.get(row.id) === logicalAccountId
      );
      if (canonicals.length !== 1) {
        throw new Error(
          'GMAIL_PARTITION_PLAN_AMBIGUOUS: provider-owned canonical row is not unique'
        );
      }
      const canonical = canonicals[0];
      if (canonical.current_eligible === 1 && canonical.deleted_remote === 0) {
        continue;
      }
      if (canonical.current_eligible !== 0 || canonical.deleted_remote !== 1) {
        throw new Error(
          'GMAIL_PARTITION_PLAN_CONFLICT: canonical eligibility state is not a repairable tombstone'
        );
      }
      canonicalStateRepairs.push({
        messageId: canonical.id,
        originalAccountId: canonical.account_id,
        targetAccountId: logicalAccountId,
        providerMessageIdHash: providerMessageIdHash(providerMessageId),
        rawBlobHash: canonical.raw_blob_hash,
        originalCurrentEligible: canonical.current_eligible,
        originalDeletedRemote: canonical.deleted_remote,
        originalLastSeenAt: canonical.last_seen_at,
        originalUpdatedAt: canonical.updated_at,
        restoredCurrentEligible: 1,
        restoredDeletedRemote: 0,
        restoredLastSeenAt: generatedAt,
        restoredUpdatedAt: generatedAt,
        evidenceCode: 'LIVE_PROVIDER_OWNERSHIP',
        evidenceDigest: providerEvidence.digest,
      });
    }
  }
  const operational = contaminatedOperationalIds(db, contaminationWindow);
  return {
    schemaVersion: 2,
    migrationId: GMAIL_PARTITION_REPAIR_ID,
    quarantineAccountId: QUARANTINE_ACCOUNT_ID,
    generatedAt,
    anchorSnapshotId,
    identityMatrixDigest: identityMatrixDigest(identityProof),
    ownerApprovalRecorded,
    contaminationWindow,
    providerInventoryEvidence,
    providerOnlyEvidence,
    anchorOwnershipEvidence,
    actions: actions.sort((left, right) => left.messageId - right.messageId),
    canonicalStateRepairs: canonicalStateRepairs.sort(
      (left, right) => left.messageId - right.messageId
    ),
    contaminatedOperationalRecords: operational,
    counts: {
      quarantineDuplicates: actions.filter(
        (action) => action.action === 'quarantine_duplicate'
      ).length,
      moveProvedCanonicals: actions.filter(
        (action) => action.action === 'move_proved_canonical'
      ).length,
      restoreCanonicalStates: canonicalStateRepairs.length,
      providerOnlyNewMessages: providerOnlyEvidence.reduce(
        (total, evidence) => total + evidence.count,
        0
      ),
      contaminatedRuns: operational.ingestionRuns.length,
      contaminatedErrors: operational.ingestionErrors.length,
    },
  };
}

function validateEvidenceList(evidence) {
  const hashes = evidence?.messageIdHashes;
  if (
    !LOGICAL_ACCOUNT_IDS.includes(evidence?.logicalAccountId) ||
    !Array.isArray(hashes) ||
    hashes.some((hash) => !/^[a-f0-9]{64}$/.test(String(hash)))
  ) {
    throw new Error(
      'GMAIL_PARTITION_PLAN_INVALID: provider evidence is malformed'
    );
  }
  const normalized = sortedUnique(hashes);
  if (
    normalized.length !== hashes.length ||
    evidence.count !== normalized.length ||
    evidence.digest !== sha256Json(normalized) ||
    evidence.identityMatrixDigest?.length !== 64 ||
    !Number.isFinite(new Date(evidence.collectedAt || '').getTime())
  ) {
    throw new Error(
      'GMAIL_PARTITION_PLAN_INVALID: provider evidence digest disagrees'
    );
  }
  return normalized;
}

function validateProviderOnlyEvidence(
  evidence,
  providerHashes,
  providerInventoryDigest
) {
  const hashes = evidence?.messageIdHashes;
  const normalized = Array.isArray(hashes) ? sortedUnique(hashes) : [];
  const providerHashSet = new Set(providerHashes || []);
  if (
    !LOGICAL_ACCOUNT_IDS.includes(evidence?.logicalAccountId) ||
    !Array.isArray(hashes) ||
    normalized.length !== hashes.length ||
    hashes.some((hash) => !/^[a-f0-9]{64}$/.test(String(hash))) ||
    evidence.count !== normalized.length ||
    evidence.digest !== sha256Json(normalized) ||
    evidence.providerInventoryDigest !== providerInventoryDigest ||
    normalized.some((hash) => !providerHashSet.has(hash))
  ) {
    throw new Error(
      'GMAIL_PARTITION_PLAN_INVALID: provider-only evidence disagrees'
    );
  }
  return normalized;
}

function validateAnchorEvidence(evidence, anchorSnapshotId) {
  const hashes = evidence?.messageIdHashes;
  if (
    !LOGICAL_ACCOUNT_IDS.includes(evidence?.logicalAccountId) ||
    evidence?.snapshotId !== anchorSnapshotId ||
    !Array.isArray(hashes) ||
    hashes.some((hash) => !/^[a-f0-9]{64}$/.test(String(hash)))
  ) {
    throw new Error(
      'GMAIL_PARTITION_PLAN_INVALID: anchor evidence is malformed'
    );
  }
  const normalized = sortedUnique(hashes);
  if (
    normalized.length !== hashes.length ||
    evidence.count !== normalized.length ||
    evidence.digest !== sha256Json(normalized)
  ) {
    throw new Error(
      'GMAIL_PARTITION_PLAN_INVALID: anchor evidence digest disagrees'
    );
  }
  return normalized;
}

function hashesFromProviderInventories(providerInventories) {
  return new Map(
    LOGICAL_ACCOUNT_IDS.map((accountId) => [
      accountId,
      sortedUnique(
        valuesFor(providerInventories, accountId).map(providerMessageIdHash)
      ),
    ])
  );
}

function hashesFromAnchorDatabase(anchorDatabase) {
  const anchorDb = dbHandle(anchorDatabase);
  const result = new Map(
    LOGICAL_ACCOUNT_IDS.map((accountId) => [accountId, []])
  );
  const seen = new Set();
  for (const row of anchorDb
    .prepare(
      `SELECT account_id, provider_message_id
       FROM messages
       WHERE account_id IN ('gmail-ablative', 'gmail-personal')
       ORDER BY account_id, provider_message_id`
    )
    .all()) {
    if (seen.has(row.provider_message_id)) {
      throw new Error(
        'GMAIL_PARTITION_PLAN_INVALID: independent anchor ownership overlaps'
      );
    }
    seen.add(row.provider_message_id);
    result
      .get(row.account_id)
      .push(providerMessageIdHash(row.provider_message_id));
  }
  for (const accountId of LOGICAL_ACCOUNT_IDS) {
    result.set(accountId, sortedUnique(result.get(accountId)));
  }
  return result;
}

function assertIndependentEvidence({
  providerEvidence,
  anchorEvidence,
  independentProviderInventories,
  independentAnchorDatabase,
  forbiddenAdditionHashes,
}) {
  if (!independentProviderInventories || !independentAnchorDatabase) {
    throw new Error(
      'GMAIL_PARTITION_INDEPENDENT_EVIDENCE_REQUIRED: fresh provider inventories and anchor database are required'
    );
  }
  const providerHashes = hashesFromProviderInventories(
    independentProviderInventories
  );
  const anchorHashes = hashesFromAnchorDatabase(independentAnchorDatabase);
  const freshOwnerByHash = new Map();
  for (const accountId of LOGICAL_ACCOUNT_IDS) {
    for (const hash of providerHashes.get(accountId)) {
      if (freshOwnerByHash.has(hash)) {
        throw new Error(
          'GMAIL_PARTITION_INDEPENDENT_EVIDENCE_MISMATCH: fresh provider ownership overlaps'
        );
      }
      freshOwnerByHash.set(hash, accountId);
    }
  }
  const additionsByAccount = {};
  for (const accountId of LOGICAL_ACCOUNT_IDS) {
    const baseline = new Set(providerEvidence.get(accountId));
    const fresh = providerHashes.get(accountId);
    const freshSet = new Set(fresh);
    if (providerEvidence.get(accountId).some((hash) => !freshSet.has(hash))) {
      throw new Error(
        'GMAIL_PARTITION_INDEPENDENT_EVIDENCE_MISMATCH: independently collected ownership sets disagree'
      );
    }
    const additions = fresh.filter((hash) => !baseline.has(hash));
    if (additions.some((hash) => forbiddenAdditionHashes.has(hash))) {
      throw new Error(
        'GMAIL_PARTITION_INDEPENDENT_EVIDENCE_MISMATCH: provider addition collides with planned archive ownership'
      );
    }
    additionsByAccount[accountId] = additions.length;
    if (
      JSON.stringify(anchorHashes.get(accountId)) !==
      JSON.stringify(anchorEvidence.get(accountId))
    ) {
      throw new Error(
        'GMAIL_PARTITION_INDEPENDENT_EVIDENCE_MISMATCH: independently collected ownership sets disagree'
      );
    }
  }
  return {
    additionsByAccount,
    totalAdditions: Object.values(additionsByAccount).reduce(
      (total, count) => total + count,
      0
    ),
  };
}

function validatePartitionRepairPlan(
  database,
  plan,
  {
    identityProof,
    suppliedPlanDigest,
    now = Date.now(),
    requireIndependentEvidence = false,
    independentProviderInventories = null,
    independentAnchorDatabase = null,
    expectedIdentities = null,
    rawMessageLoader = null,
  }
) {
  const db = dbHandle(database);
  validateIdentityProof(identityProof, { now });
  if (
    !Array.isArray(plan?.providerInventoryEvidence) ||
    !Array.isArray(plan?.providerOnlyEvidence) ||
    !Array.isArray(plan?.anchorOwnershipEvidence) ||
    !Array.isArray(plan?.actions) ||
    !Array.isArray(plan?.canonicalStateRepairs) ||
    !Array.isArray(plan?.contaminatedOperationalRecords?.ingestionRuns) ||
    !Array.isArray(plan?.contaminatedOperationalRecords?.ingestionErrors)
  ) {
    throw new Error(
      'GMAIL_PARTITION_PLAN_INVALID: required evidence and action arrays are malformed'
    );
  }
  if (
    plan?.schemaVersion !== 2 ||
    plan?.migrationId !== GMAIL_PARTITION_REPAIR_ID ||
    plan?.quarantineAccountId !== QUARANTINE_ACCOUNT_ID ||
    !/^[a-f0-9]{32,128}$/.test(String(plan?.anchorSnapshotId || '')) ||
    plan?.identityMatrixDigest !== identityMatrixDigest(identityProof)
  ) {
    throw new Error(
      'GMAIL_PARTITION_PLAN_INVALID: plan identity or approval metadata disagrees'
    );
  }
  const generatedAt = new Date(plan.generatedAt || '').getTime();
  if (
    !Number.isFinite(generatedAt) ||
    generatedAt > now + 30_000 ||
    now - generatedAt > 24 * 60 * 60 * 1000
  ) {
    throw new Error('GMAIL_PARTITION_PLAN_INVALID: plan is absent or stale');
  }
  const actualPlanDigest = partitionRepairPlanDigest(plan);
  if (
    suppliedPlanDigest !== actualPlanDigest ||
    !/^[a-f0-9]{64}$/.test(String(suppliedPlanDigest || ''))
  ) {
    throw new Error('GMAIL_PARTITION_PLAN_DIGEST_MISMATCH');
  }

  const providerEvidence = new Map();
  for (const evidence of plan.providerInventoryEvidence) {
    const provedIdentity = identityProof.accounts.find(
      (account) => account.logicalAccountId === evidence.logicalAccountId
    );
    if (
      !provedIdentity ||
      evidence.credentialSlot !== provedIdentity.credentialSlot ||
      evidence.identityMatrixDigest !== identityMatrixDigest(identityProof) ||
      new Date(evidence.collectedAt).getTime() !== generatedAt
    ) {
      throw new Error(
        'GMAIL_PARTITION_PLAN_INVALID: provider evidence is not tied to current identity proof'
      );
    }
    providerEvidence.set(
      evidence.logicalAccountId,
      validateEvidenceList(evidence)
    );
  }
  if (
    providerEvidence.size !== 2 ||
    plan.providerInventoryEvidence.length !== 2
  ) {
    throw new Error(
      'GMAIL_PARTITION_PLAN_INVALID: both provider inventories are required'
    );
  }
  const providerOnlyEvidence = new Map();
  for (const evidence of plan.providerOnlyEvidence) {
    const providerPlanEvidence = plan.providerInventoryEvidence.find(
      (item) => item.logicalAccountId === evidence.logicalAccountId
    );
    providerOnlyEvidence.set(
      evidence.logicalAccountId,
      validateProviderOnlyEvidence(
        evidence,
        providerEvidence.get(evidence.logicalAccountId),
        providerPlanEvidence?.digest
      )
    );
  }
  if (
    providerOnlyEvidence.size !== 2 ||
    plan.providerOnlyEvidence.length !== 2
  ) {
    throw new Error(
      'GMAIL_PARTITION_PLAN_INVALID: both provider-only inventories are required'
    );
  }
  const anchorEvidence = new Map();
  for (const evidence of plan.anchorOwnershipEvidence) {
    anchorEvidence.set(
      evidence.logicalAccountId,
      validateAnchorEvidence(evidence, plan.anchorSnapshotId)
    );
  }
  if (anchorEvidence.size !== 2 || plan.anchorOwnershipEvidence.length !== 2) {
    throw new Error(
      'GMAIL_PARTITION_PLAN_INVALID: both anchor ownership sets are required'
    );
  }
  const providerEvidenceSets = new Map(
    [...providerEvidence].map(([accountId, hashes]) => [
      accountId,
      new Set(hashes),
    ])
  );
  const anchorEvidenceSets = new Map(
    [...anchorEvidence].map(([accountId, hashes]) => [
      accountId,
      new Set(hashes),
    ])
  );
  const providerEvidenceMetadata = new Map(
    plan.providerInventoryEvidence.map((evidence) => [
      evidence.logicalAccountId,
      evidence,
    ])
  );
  const anchorEvidenceMetadata = new Map(
    plan.anchorOwnershipEvidence.map((evidence) => [
      evidence.logicalAccountId,
      evidence,
    ])
  );
  const rows = gmailMessages(db);
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const rowsByProviderHash = new Map();
  for (const row of rows) {
    const hash = providerMessageIdHash(row.provider_message_id);
    if (!rowsByProviderHash.has(hash)) rowsByProviderHash.set(hash, []);
    rowsByProviderHash.get(hash).push(row);
  }
  let independentEvidence = {
    additionsByAccount: Object.fromEntries(
      LOGICAL_ACCOUNT_IDS.map((accountId) => [accountId, 0])
    ),
    totalAdditions: 0,
  };
  if (requireIndependentEvidence) {
    const forbiddenAdditionHashes = new Set([
      ...rowsByProviderHash.keys(),
      ...[...anchorEvidence.values()].flat(),
      ...plan.actions.map((action) => action.providerMessageIdHash),
      ...plan.canonicalStateRepairs.map(
        (repair) => repair.providerMessageIdHash
      ),
    ]);
    independentEvidence = assertIndependentEvidence({
      providerEvidence,
      anchorEvidence,
      independentProviderInventories,
      independentAnchorDatabase,
      forbiddenAdditionHashes,
    });
  }
  const acted = new Set();
  const projectedAccount = new Map(rows.map((row) => [row.id, row.account_id]));
  const projectedEligibility = new Map(
    rows.map((row) => [row.id, row.current_eligible])
  );
  const projectedDeletedRemote = new Map(
    rows.map((row) => [row.id, row.deleted_remote])
  );
  const overlapKeys = new Map();
  for (const row of rows) {
    if (!overlapKeys.has(row.provider_message_id)) {
      overlapKeys.set(row.provider_message_id, []);
    }
    overlapKeys.get(row.provider_message_id).push(row);
  }
  const duplicatePairs = [...overlapKeys.values()].filter(
    (group) => group.length > 1
  );
  let plannedDuplicateCount = 0;
  const actionByMessageId = new Map();

  for (const action of plan.actions) {
    if (
      acted.has(action.messageId) ||
      !EVIDENCE_CODES.has(action.evidenceCode) ||
      !/^[a-f0-9]{64}$/.test(String(action.evidenceDigest || '')) ||
      !['quarantine_duplicate', 'move_proved_canonical'].includes(action.action)
    ) {
      throw new Error('GMAIL_PARTITION_PLAN_INVALID: action is duplicated');
    }
    acted.add(action.messageId);
    actionByMessageId.set(action.messageId, action);
    const row = rowsById.get(action.messageId);
    if (
      !row ||
      row.account_id !== action.fromAccountId ||
      providerMessageIdHash(row.provider_message_id) !==
        action.providerMessageIdHash ||
      row.raw_blob_hash !== action.rawBlobHash
    ) {
      throw new Error(
        'GMAIL_PARTITION_PRECONDITION_FAILED: planned source row changed'
      );
    }
    if (action.action === 'quarantine_duplicate') {
      const canonical = rowsById.get(action.canonicalMessageId);
      if (
        action.toAccountId !== QUARANTINE_ACCOUNT_ID ||
        !canonical ||
        canonical.account_id !== action.canonicalAccountId ||
        canonical.provider_message_id !== row.provider_message_id ||
        canonical.raw_blob_hash !== row.raw_blob_hash ||
        canonical.id === row.id
      ) {
        throw new Error(
          'GMAIL_PARTITION_PRECONDITION_FAILED: canonical duplicate proof changed'
        );
      }
      const evidenceSet =
        action.evidenceCode === 'IMMUTABLE_ANCHOR_CANONICAL'
          ? anchorEvidenceSets.get(action.canonicalAccountId)
          : providerEvidenceSets.get(action.canonicalAccountId);
      if (!evidenceSet?.has(action.providerMessageIdHash)) {
        throw new Error(
          'GMAIL_PARTITION_PLAN_INVALID: canonical action lacks independent ownership evidence'
        );
      }
      const expectedEvidence =
        action.evidenceCode === 'IMMUTABLE_ANCHOR_CANONICAL'
          ? anchorEvidenceMetadata.get(action.canonicalAccountId)
          : providerEvidenceMetadata.get(action.canonicalAccountId);
      if (action.evidenceDigest !== expectedEvidence?.digest) {
        throw new Error(
          'GMAIL_PARTITION_PLAN_INVALID: action evidence digest disagrees'
        );
      }
      plannedDuplicateCount += 1;
    } else {
      if (
        !LOGICAL_ACCOUNT_IDS.includes(action.toAccountId) ||
        db
          .prepare(
            `SELECT 1 FROM messages
             WHERE account_id = ? AND provider_message_id = ?`
          )
          .get(action.toAccountId, row.provider_message_id)
      ) {
        throw new Error(
          'GMAIL_PARTITION_PRECONDITION_FAILED: canonical move would collide'
        );
      }
      if (
        action.evidenceCode === 'EXACT_IDENTITY_HEADER' &&
        (row.current_eligible !== 0 || row.deleted_remote !== 1)
      ) {
        throw new Error(
          'GMAIL_PARTITION_PRECONDITION_FAILED: header-attributed row is not the proved tombstone'
        );
      }
      if (action.evidenceCode === 'EXACT_IDENTITY_HEADER') {
        const headerEvidence = action.headerEvidence;
        const inboxPresent = Boolean(
          db
            .prepare(
              `SELECT 1 FROM message_locations
               WHERE message_id = ? AND kind = 'inbox'`
            )
            .get(row.id)
        );
        if (
          headerEvidence?.providerMessageIdHash !==
            action.providerMessageIdHash ||
          headerEvidence?.rawBlobHash !== action.rawBlobHash ||
          headerEvidence?.targetAccountId !== action.toAccountId ||
          headerEvidence?.identityMatrixDigest !== plan.identityMatrixDigest ||
          headerEvidence?.expectedIdentityBindingDigest !==
            expectedIdentityBindingDigest(expectedIdentities) ||
          headerEvidence?.directionInbound !== true ||
          headerEvidence?.inboxPresent !== true ||
          headerEvidence?.providerDeliveredToExactTarget !== true ||
          headerEvidence?.toHeaderExactTarget !== true ||
          headerEvidence?.otherIdentityExactMatch !== false ||
          headerEvidence?.forwardingOrResentHeadersPresent !== false ||
          row.direction !== 'inbound' ||
          !inboxPresent ||
          action.evidenceDigest !== sha256Json(headerEvidence)
        ) {
          throw new Error(
            'GMAIL_PARTITION_PLAN_INVALID: exact-header ownership evidence disagrees'
          );
        }
        if (typeof rawMessageLoader !== 'function') {
          throw new Error(
            'GMAIL_PARTITION_INDEPENDENT_EVIDENCE_REQUIRED: raw message loader is required'
          );
        }
        const recomputed = deriveExactHeaderEvidence({
          row,
          rawContent: rawMessageLoader(row),
          expectedIdentities,
          identityProof,
          inboxPresent,
        });
        if (
          recomputed.targetAccountId !== action.toAccountId ||
          JSON.stringify(recomputed.headerEvidence) !==
            JSON.stringify(headerEvidence) ||
          action.evidenceDigest !== sha256Json(recomputed.headerEvidence)
        ) {
          throw new Error(
            'GMAIL_PARTITION_PLAN_INVALID: archived raw headers do not prove the supplied attribution'
          );
        }
      }
      if (
        action.evidenceCode === 'LIVE_PROVIDER_OWNERSHIP' &&
        !providerEvidenceSets
          .get(action.toAccountId)
          ?.has(action.providerMessageIdHash)
      ) {
        throw new Error(
          'GMAIL_PARTITION_PLAN_INVALID: canonical move lacks live-provider evidence'
        );
      }
      if (
        action.evidenceCode === 'LIVE_PROVIDER_OWNERSHIP' &&
        action.evidenceDigest !==
          providerEvidenceMetadata.get(action.toAccountId)?.digest
      ) {
        throw new Error(
          'GMAIL_PARTITION_PLAN_INVALID: move evidence digest disagrees'
        );
      }
      if (
        action.evidenceCode === 'EXACT_IDENTITY_HEADER' &&
        [...providerEvidenceSets.values(), ...anchorEvidenceSets.values()].some(
          (hashes) => hashes.has(action.providerMessageIdHash)
        )
      ) {
        throw new Error(
          'GMAIL_PARTITION_PLAN_INVALID: header override is not uniquely necessary'
        );
      }
    }
    projectedAccount.set(action.messageId, action.toAccountId);
  }

  const allLocalHashes = new Set(rowsByProviderHash.keys());
  for (const accountId of LOGICAL_ACCOUNT_IDS) {
    const expectedProviderOnly = providerEvidence
      .get(accountId)
      .filter((hash) => !allLocalHashes.has(hash));
    if (
      JSON.stringify(expectedProviderOnly) !==
      JSON.stringify(providerOnlyEvidence.get(accountId))
    ) {
      throw new Error(
        'GMAIL_PARTITION_PLAN_INCOMPLETE: provider-only new mail evidence changed'
      );
    }
  }

  const stateRepairs = plan.canonicalStateRepairs;
  const stateRepairIds = new Set();
  for (const repair of stateRepairs) {
    const row = rowsById.get(repair.messageId);
    const providerPlanEvidence = providerEvidenceMetadata.get(
      repair.targetAccountId
    );
    if (
      stateRepairIds.has(repair.messageId) ||
      !row ||
      repair.originalAccountId !== row.account_id ||
      repair.providerMessageIdHash !==
        providerMessageIdHash(row.provider_message_id) ||
      repair.rawBlobHash !== row.raw_blob_hash ||
      repair.originalCurrentEligible !== row.current_eligible ||
      repair.originalDeletedRemote !== row.deleted_remote ||
      repair.originalLastSeenAt !== row.last_seen_at ||
      repair.originalUpdatedAt !== row.updated_at ||
      repair.originalCurrentEligible !== 0 ||
      repair.originalDeletedRemote !== 1 ||
      repair.restoredCurrentEligible !== 1 ||
      repair.restoredDeletedRemote !== 0 ||
      repair.restoredLastSeenAt !== plan.generatedAt ||
      repair.restoredUpdatedAt !== plan.generatedAt ||
      repair.evidenceCode !== 'LIVE_PROVIDER_OWNERSHIP' ||
      repair.evidenceDigest !== providerPlanEvidence?.digest ||
      projectedAccount.get(row.id) !== repair.targetAccountId ||
      !providerEvidenceSets
        .get(repair.targetAccountId)
        ?.has(repair.providerMessageIdHash)
    ) {
      throw new Error(
        'GMAIL_PARTITION_PLAN_INVALID: canonical state repair disagrees'
      );
    }
    stateRepairIds.add(repair.messageId);
    projectedEligibility.set(repair.messageId, 1);
    projectedDeletedRemote.set(repair.messageId, 0);
  }

  for (const accountId of LOGICAL_ACCOUNT_IDS) {
    const providerOnly = new Set(providerOnlyEvidence.get(accountId));
    for (const hash of providerEvidence.get(accountId)) {
      if (providerOnly.has(hash)) continue;
      const canonicals = (rowsByProviderHash.get(hash) || []).filter(
        (row) => projectedAccount.get(row.id) === accountId
      );
      if (canonicals.length !== 1) {
        throw new Error(
          'GMAIL_PARTITION_PLAN_INCOMPLETE: provider-owned canonical row is not unique'
        );
      }
      const canonical = canonicals[0];
      const needsStateRepair =
        canonical.current_eligible !== 1 || canonical.deleted_remote !== 0;
      if (needsStateRepair !== stateRepairIds.has(canonical.id)) {
        throw new Error(
          'GMAIL_PARTITION_PLAN_INCOMPLETE: provider-proved canonical state is not restored exactly once'
        );
      }
    }
  }

  if (
    plannedDuplicateCount !== duplicatePairs.length ||
    duplicatePairs.some(
      (group) =>
        group.filter(
          (row) =>
            actionByMessageId.get(row.id)?.action === 'quarantine_duplicate'
        ).length !==
        group.length - 1
    )
  ) {
    throw new Error(
      'GMAIL_PARTITION_PLAN_INCOMPLETE: every mixed duplicate needs one canonical survivor'
    );
  }

  for (const accountId of LOGICAL_ACCOUNT_IDS) {
    const projectedHashes = sortedUnique(
      rows
        .filter(
          (row) =>
            projectedEligibility.get(row.id) === 1 &&
            projectedDeletedRemote.get(row.id) === 0 &&
            projectedAccount.get(row.id) === accountId
        )
        .map((row) => providerMessageIdHash(row.provider_message_id))
    );
    const providerOnly = new Set(providerOnlyEvidence.get(accountId));
    const expectedProjectedHashes = providerEvidence
      .get(accountId)
      .filter((hash) => !providerOnly.has(hash));
    if (
      JSON.stringify(projectedHashes) !==
      JSON.stringify(expectedProjectedHashes)
    ) {
      throw new Error(
        `GMAIL_PARTITION_PLAN_INCOMPLETE: projected ${accountId} inventory does not reconcile`
      );
    }
  }

  const operational = contaminatedOperationalIds(db, plan.contaminationWindow);
  if (
    JSON.stringify(operational.ingestionRuns) !==
      JSON.stringify(plan.contaminatedOperationalRecords.ingestionRuns) ||
    JSON.stringify(operational.ingestionErrors) !==
      JSON.stringify(plan.contaminatedOperationalRecords.ingestionErrors)
  ) {
    throw new Error(
      'GMAIL_PARTITION_PLAN_INCOMPLETE: contaminated operational records changed'
    );
  }

  const counts = {
    quarantineDuplicates: plan.actions.filter(
      (action) => action.action === 'quarantine_duplicate'
    ).length,
    moveProvedCanonicals: plan.actions.filter(
      (action) => action.action === 'move_proved_canonical'
    ).length,
    restoreCanonicalStates: stateRepairs.length,
    providerOnlyNewMessages: [...providerOnlyEvidence.values()].reduce(
      (total, hashes) => total + hashes.length,
      0
    ),
    contaminatedRuns: operational.ingestionRuns.length,
    contaminatedErrors: operational.ingestionErrors.length,
  };
  if (JSON.stringify(counts) !== JSON.stringify(plan.counts)) {
    throw new Error('GMAIL_PARTITION_PLAN_INVALID: declared counts disagree');
  }
  return {
    actualPlanDigest,
    counts,
    operational,
    independentEvidence,
  };
}

function partitionRepairPreconditionDigest(database, plan, planDigest) {
  const db = dbHandle(database);
  const ftsIndex = scanFtsIndex(db);
  return sha256Json({
    planDigest,
    gmailMessages: gmailMessages(db).map((row) => ({
      id: row.id,
      accountId: row.account_id,
      providerMessageIdHash: providerMessageIdHash(row.provider_message_id),
      rawBlobHash: row.raw_blob_hash,
      currentEligible: row.current_eligible,
      deletedRemote: row.deleted_remote,
      firstArchivedAt: row.first_archived_at,
      lastSeenAt: row.last_seen_at,
      updatedAt: row.updated_at,
    })),
    actionFts: plan.actions.map((action) => {
      const row = ftsIndex.rowsByMessageId.get(messageKey(action.messageId));
      return {
        message_id: action.messageId,
        account_id: row?.account_id || null,
        fts_rowid: row?.fts_rowid || null,
      };
    }),
    derivedState: {
      folders: db
        .prepare(
          `SELECT * FROM folders
           WHERE account_id IN ('gmail-ablative', 'gmail-personal')
           ORDER BY account_id, provider_folder_id`
        )
        .all(),
      cursors: db
        .prepare(
          `SELECT * FROM sync_cursors
           WHERE account_id IN ('gmail-ablative', 'gmail-personal')
           ORDER BY account_id, scope`
        )
        .all(),
    },
    durableContentCounts: durableContentCounts(db),
    durableContentDigest: durableContentDigest(db),
    integrity: db.pragma('integrity_check', { simple: true }),
    foreignKeyProblems: db.pragma('foreign_key_check').length,
  });
}

function postRepairStateDigest(database, { receiptMetadata = null } = {}) {
  const db = dbHandle(database);
  const ftsIndex = inspectFtsConsistency(db);
  const withFtsState = (rows) =>
    rows.map((row) => {
      const fts = ftsIndex.rowsByMessageId.get(messageKey(row.message_id));
      return {
        ...row,
        fts_account_id: fts?.account_id || null,
      };
    });
  return sha256Json({
    receipt:
      receiptMetadata ||
      db
        .prepare(
          `SELECT migration_id, plan_digest, precondition_digest,
                  applied_at, details_json
           FROM identity_partition_repair_receipts
           WHERE migration_id = ?`
        )
        .get(GMAIL_PARTITION_REPAIR_ID),
    quarantineAccount: db
      .prepare('SELECT id, provider, enabled FROM accounts WHERE id = ?')
      .get(QUARANTINE_ACCOUNT_ID),
    repairedMessages: withFtsState(
      db
        .prepare(
          `SELECT provenance.*, messages.account_id,
                  messages.raw_blob_hash AS current_raw_blob_hash
           FROM identity_partition_repair_messages provenance
           JOIN messages ON messages.id = provenance.message_id
           WHERE provenance.migration_id = ?
           ORDER BY provenance.message_id`
        )
        .all(GMAIL_PARTITION_REPAIR_ID)
    ),
    restoredCanonicalState: withFtsState(
      db
        .prepare(
          `SELECT provenance.*, messages.account_id,
                  messages.raw_blob_hash AS current_raw_blob_hash
           FROM identity_partition_repair_canonical_state provenance
           JOIN messages ON messages.id = provenance.message_id
           WHERE provenance.migration_id = ?
           ORDER BY provenance.message_id`
        )
        .all(GMAIL_PARTITION_REPAIR_ID)
    ),
    derivedStateSnapshots: db
      .prepare(
        `SELECT * FROM identity_partition_repair_state
         WHERE migration_id = ?
         ORDER BY table_name, row_ordinal`
      )
      .all(GMAIL_PARTITION_REPAIR_ID),
    operationalProvenance: db
      .prepare(
        `SELECT * FROM identity_partition_repair_operational_records
         WHERE migration_id = ?
         ORDER BY table_name, row_id`
      )
      .all(GMAIL_PARTITION_REPAIR_ID),
    activeOverlap: db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM messages left_message
         JOIN messages right_message
           ON right_message.provider_message_id = left_message.provider_message_id
          AND right_message.account_id = 'gmail-personal'
         WHERE left_message.account_id = 'gmail-ablative'`
      )
      .get().count,
    integrity: db.pragma('integrity_check', { simple: true }),
    foreignKeyProblems: db.pragma('foreign_key_check').length,
  });
}

function readRepairReceipt(db) {
  if (!tableExists(db, 'identity_partition_repair_receipts')) return null;
  return (
    db
      .prepare(
        `SELECT * FROM identity_partition_repair_receipts
         WHERE migration_id = ?`
      )
      .get(GMAIL_PARTITION_REPAIR_ID) || null
  );
}

function snapshotDerivedState(db) {
  const tables = [
    {
      name: 'folders',
      orderBy: 'account_id, provider_folder_id',
    },
    { name: 'sync_cursors', orderBy: 'account_id, scope' },
  ];
  const insert = db.prepare(
    `INSERT INTO identity_partition_repair_state(
       migration_id, table_name, row_ordinal, row_json
     ) VALUES (?, ?, ?, ?)`
  );
  const counts = {};
  for (const table of tables) {
    const rows = db
      .prepare(
        `SELECT * FROM ${table.name}
         WHERE account_id IN ('gmail-ablative', 'gmail-personal')
         ORDER BY ${table.orderBy}`
      )
      .all();
    rows.forEach((row, index) =>
      insert.run(
        GMAIL_PARTITION_REPAIR_ID,
        table.name,
        index,
        JSON.stringify(row)
      )
    );
    counts[table.name] = rows.length;
    db.prepare(
      `DELETE FROM ${table.name}
       WHERE account_id IN ('gmail-ablative', 'gmail-personal')`
    ).run();
  }
  return counts;
}

function repairGmailPartitions(
  database,
  {
    plan = null,
    planDigest = null,
    preconditionDigest = null,
    identityProof = null,
    apply = false,
    rehearsal = false,
    confirmation = null,
    now = Date.now(),
    independentProviderInventories = null,
    independentAnchorDatabase = null,
    expectedIdentities = null,
    rawMessageLoader = null,
    ownerApprovalMetadata = null,
  } = {}
) {
  const db = dbHandle(database);
  if (ftsAccountMismatchCount(db) !== 0) {
    throw new Error(
      'GMAIL_PARTITION_REPAIR_FTS_ACCOUNT_MISMATCH: message ownership indexes disagree'
    );
  }
  const ftsSearchBefore = ftsSearchFingerprint(db);
  if (!ftsSearchBefore.searchable) {
    throw new Error(
      'GMAIL_PARTITION_REPAIR_FTS_SEARCH_FAILED: full-text index is not demonstrably searchable'
    );
  }
  const existing = readRepairReceipt(db);
  if (existing) {
    const currentPostStateDigest = postRepairStateDigest(db);
    if (currentPostStateDigest !== existing.post_state_digest) {
      throw new Error(
        'GMAIL_PARTITION_REPAIR_POST_STATE_DRIFT: receipt verification failed'
      );
    }
    return {
      migrationId: GMAIL_PARTITION_REPAIR_ID,
      status: 'already_applied',
      applied: false,
      changedRows: 0,
      postStateDigest: currentPostStateDigest,
      integrity: db.pragma('integrity_check', { simple: true }),
      foreignKeyProblems: db.pragma('foreign_key_check').length,
      ftsAccountMismatches: 0,
      ftsSearchPassed: true,
      ftsSearchDigest: ftsSearchBefore.digest,
    };
  }

  const validated = validatePartitionRepairPlan(db, plan, {
    identityProof,
    suppliedPlanDigest: planDigest,
    now,
    requireIndependentEvidence: apply,
    independentProviderInventories,
    independentAnchorDatabase,
    expectedIdentities,
    rawMessageLoader,
  });
  const currentPreconditionDigest = partitionRepairPreconditionDigest(
    db,
    plan,
    planDigest
  );
  const validatedOwnerApproval =
    apply && !rehearsal
      ? validateOwnerApprovalMetadata(ownerApprovalMetadata, {
          plan,
          planDigest,
          preconditionDigest: currentPreconditionDigest,
          now,
        })
      : null;
  const derivedCounts = {
    folders: db
      .prepare(
        `SELECT COUNT(*) AS count FROM folders
         WHERE account_id IN ('gmail-ablative', 'gmail-personal')`
      )
      .get().count,
    syncCursors: db
      .prepare(
        `SELECT COUNT(*) AS count FROM sync_cursors
         WHERE account_id IN ('gmail-ablative', 'gmail-personal')`
      )
      .get().count,
  };
  const dryRun = {
    migrationId: GMAIL_PARTITION_REPAIR_ID,
    mode: 'dry-run',
    status: 'not_applied',
    applied: false,
    changedRows: 0,
    planDigest,
    preconditionDigest: currentPreconditionDigest,
    counts: validated.counts,
    derivedStateToReset: derivedCounts,
    quarantineAccountId: QUARANTINE_ACCOUNT_ID,
    quarantineDisabled: true,
    repairSchemaConfigured: repairSchemaConfigured(db),
    projectedActiveOverlap: 0,
    integrity: db.pragma('integrity_check', { simple: true }),
    foreignKeyProblems: db.pragma('foreign_key_check').length,
    ftsAccountMismatches: 0,
    ftsSearchPassed: true,
    ftsSearchDigest: ftsSearchBefore.digest,
    independentProviderAdditions: validated.independentEvidence.totalAdditions,
  };
  if (!apply) return dryRun;

  const expectedConfirmation = rehearsal
    ? GMAIL_PARTITION_REHEARSAL_CONFIRMATION
    : GMAIL_PARTITION_REPAIR_CONFIRMATION;
  if (confirmation !== expectedConfirmation) {
    throw new Error(
      'GMAIL_PARTITION_REPAIR_CONFIRMATION_REQUIRED: explicit approved mode is required'
    );
  }
  if (!repairSchemaConfigured(db)) {
    throw new Error(
      'GMAIL_PARTITION_REPAIR_SCHEMA_MISSING: apply reviewed migration 11 first'
    );
  }
  if (preconditionDigest !== currentPreconditionDigest) {
    throw new Error('GMAIL_PARTITION_REPAIR_PRECONDITION_DIGEST_MISMATCH');
  }
  if (
    db.pragma('integrity_check', { simple: true }) !== 'ok' ||
    db.pragma('foreign_key_check').length > 0 ||
    ftsAccountMismatchCount(db) !== 0
  ) {
    throw new Error('GMAIL_PARTITION_REPAIR_PRECONDITION_FAILED');
  }

  const beforeCounts = durableContentCounts(db);
  const beforeContentDigest = durableContentDigest(db);
  const beforeMutableState = mutableMessageState(db);
  const expectedMutableState = projectedMutableMessageState(
    beforeMutableState,
    plan.actions,
    plan.canonicalStateRepairs
  );
  const appliedAt = new Date(now).toISOString();
  const actionByOriginalProviderHash = new Map(
    plan.actions.map((action) => [
      `${action.fromAccountId}:${action.providerMessageIdHash}`,
      action,
    ])
  );
  const transaction = db.transaction(() => {
    db.pragma('defer_foreign_keys = ON');
    db.prepare(
      `INSERT INTO accounts(
         id, provider, display_name, enabled, created_at, updated_at
       ) VALUES (?, 'gmail', 'Gmail identity repair quarantine', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).run(QUARANTINE_ACCOUNT_ID, appliedAt, appliedAt);
    const quarantine = db
      .prepare('SELECT provider, enabled FROM accounts WHERE id = ?')
      .get(QUARANTINE_ACCOUNT_ID);
    if (quarantine?.provider !== 'gmail' || quarantine?.enabled !== 0) {
      throw new Error(
        'GMAIL_PARTITION_REPAIR_QUARANTINE_INVALID: account must remain disabled'
      );
    }

    const insertMessageProvenance = db.prepare(
      `INSERT INTO identity_partition_repair_messages(
         migration_id, message_id, original_account_id, target_account_id,
         action, evidence_code, evidence_digest, provider_message_id_hash, raw_blob_hash,
         original_fts_account_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const updateMessage = db.prepare(
      'UPDATE messages SET account_id = ? WHERE id = ? AND account_id = ?'
    );
    const ftsBeforeActions = inspectFtsConsistency(db);
    if (!ftsBeforeActions.summary.passed) {
      throw new Error(
        'GMAIL_PARTITION_REPAIR_PRECONDITION_FAILED: FTS ownership index is inconsistent'
      );
    }
    const updateFts = db.prepare(FTS_ACCOUNT_UPDATE_SQL);
    for (const action of plan.actions) {
      const originalFts = ftsBeforeActions.rowsByMessageId.get(
        messageKey(action.messageId)
      );
      if (!originalFts) {
        throw new Error(
          'GMAIL_PARTITION_REPAIR_PRECONDITION_FAILED: FTS row is missing'
        );
      }
      insertMessageProvenance.run(
        GMAIL_PARTITION_REPAIR_ID,
        action.messageId,
        action.fromAccountId,
        action.toAccountId,
        action.action,
        action.evidenceCode,
        action.evidenceDigest,
        action.providerMessageIdHash,
        action.rawBlobHash,
        originalFts.account_id
      );
      if (
        updateMessage.run(
          action.toAccountId,
          action.messageId,
          action.fromAccountId
        ).changes !== 1 ||
        updateFts.run(
          action.toAccountId,
          originalFts.fts_rowid,
          action.messageId,
          originalFts.account_id
        ).changes !== 1
      ) {
        throw new Error(
          'GMAIL_PARTITION_REPAIR_PRECONDITION_FAILED: planned row changed during apply'
        );
      }
    }

    const insertCanonicalState = db.prepare(
      `INSERT INTO identity_partition_repair_canonical_state(
         migration_id, message_id, original_account_id, target_account_id,
         provider_message_id_hash, raw_blob_hash,
         original_current_eligible, original_deleted_remote,
         original_last_seen_at, original_updated_at,
         restored_last_seen_at, restored_updated_at,
         evidence_code, evidence_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const restoreCanonicalState = db.prepare(
      `UPDATE messages
       SET current_eligible = 1, deleted_remote = 0,
           last_seen_at = ?, updated_at = ?
       WHERE id = ?
         AND account_id = ?
         AND current_eligible = ?
         AND deleted_remote = ?
         AND last_seen_at = ?
         AND updated_at = ?`
    );
    for (const repair of plan.canonicalStateRepairs) {
      insertCanonicalState.run(
        GMAIL_PARTITION_REPAIR_ID,
        repair.messageId,
        repair.originalAccountId,
        repair.targetAccountId,
        repair.providerMessageIdHash,
        repair.rawBlobHash,
        repair.originalCurrentEligible,
        repair.originalDeletedRemote,
        repair.originalLastSeenAt,
        repair.originalUpdatedAt,
        repair.restoredLastSeenAt,
        repair.restoredUpdatedAt,
        repair.evidenceCode,
        repair.evidenceDigest
      );
      if (
        restoreCanonicalState.run(
          repair.restoredLastSeenAt,
          repair.restoredUpdatedAt,
          repair.messageId,
          repair.targetAccountId,
          repair.originalCurrentEligible,
          repair.originalDeletedRemote,
          repair.originalLastSeenAt,
          repair.originalUpdatedAt
        ).changes !== 1
      ) {
        throw new Error(
          'GMAIL_PARTITION_REPAIR_PRECONDITION_FAILED: canonical state changed during apply'
        );
      }
    }

    const stateCounts = snapshotDerivedState(db);
    const insertOperational = db.prepare(
      `INSERT INTO identity_partition_repair_operational_records(
         migration_id, table_name, row_id, original_account_id,
         target_account_id, action, evidence_code
       ) VALUES (?, ?, ?, ?, ?, ?, 'CONTAMINATED_BINDING_INTERVAL')`
    );
    for (const rowId of validated.operational.ingestionRuns) {
      const run = db
        .prepare('SELECT account_id FROM ingestion_runs WHERE id = ?')
        .get(rowId);
      insertOperational.run(
        GMAIL_PARTITION_REPAIR_ID,
        'ingestion_runs',
        rowId,
        run?.account_id || null,
        run?.account_id || null,
        'provenance_only'
      );
    }
    for (const rowId of validated.operational.ingestionErrors) {
      const error = db
        .prepare(
          `SELECT account_id, provider_message_id
           FROM ingestion_errors WHERE id = ?`
        )
        .get(rowId);
      const matchingAction = error?.provider_message_id
        ? actionByOriginalProviderHash.get(
            `${error.account_id}:${providerMessageIdHash(
              error.provider_message_id
            )}`
          )
        : null;
      const targetAccountId = matchingAction
        ? matchingAction.toAccountId
        : error?.account_id || null;
      let operationalAction = 'provenance_only';
      if (matchingAction?.action === 'quarantine_duplicate') {
        operationalAction = 'move_to_quarantine';
      } else if (matchingAction) {
        operationalAction = 'move_with_repaired_message';
      }
      insertOperational.run(
        GMAIL_PARTITION_REPAIR_ID,
        'ingestion_errors',
        rowId,
        error?.account_id || null,
        targetAccountId,
        operationalAction
      );
      if (matchingAction) {
        db.prepare(
          `UPDATE ingestion_errors SET account_id = ?
           WHERE id = ? AND account_id = ?`
        ).run(targetAccountId, rowId, error.account_id);
      }
    }

    const afterCounts = durableContentCounts(db);
    if (
      JSON.stringify(afterCounts) !== JSON.stringify(beforeCounts) ||
      durableContentDigest(db) !== beforeContentDigest
    ) {
      throw new Error(
        'GMAIL_PARTITION_REPAIR_POSTCONDITION_FAILED: durable row counts changed'
      );
    }
    if (
      JSON.stringify(mutableMessageState(db)) !==
      JSON.stringify(expectedMutableState)
    ) {
      throw new Error(
        'GMAIL_PARTITION_REPAIR_POSTCONDITION_FAILED: message ownership or tombstone state changed outside the plan'
      );
    }
    if (
      db.pragma('foreign_key_check').length > 0 ||
      db.pragma('integrity_check', { simple: true }) !== 'ok' ||
      ftsAccountMismatchCount(db) !== 0
    ) {
      throw new Error(
        'GMAIL_PARTITION_REPAIR_POSTCONDITION_FAILED: database verification failed'
      );
    }
    const ftsSearchAfter = ftsSearchFingerprint(db);
    if (
      !ftsSearchAfter.searchable ||
      ftsSearchAfter.digest !== ftsSearchBefore.digest
    ) {
      throw new Error(
        'GMAIL_PARTITION_REPAIR_POSTCONDITION_FAILED: full-text search changed'
      );
    }
    const details = {
      mode: rehearsal ? 'rehearsal' : 'live',
      counts: validated.counts,
      derivedStateReset: stateCounts,
      stableMessageIdsPreserved: true,
      childRowsPreserved: true,
      blobsPreserved: true,
      activeOverlap: 0,
      integrity: 'ok',
      foreignKeyProblems: 0,
      ftsAccountMismatches: 0,
      ftsSearchPassed: true,
      ftsSearchDigest: ftsSearchAfter.digest,
      independentProviderAdditions:
        validated.independentEvidence.totalAdditions,
      ownerApproval: validatedOwnerApproval,
    };
    const detailsJson = JSON.stringify(details);
    const postStateDigest = postRepairStateDigest(db, {
      receiptMetadata: {
        migration_id: GMAIL_PARTITION_REPAIR_ID,
        plan_digest: planDigest,
        precondition_digest: preconditionDigest,
        applied_at: appliedAt,
        details_json: detailsJson,
      },
    });
    db.prepare(
      `INSERT INTO identity_partition_repair_receipts(
         migration_id, plan_digest, precondition_digest, applied_at,
         post_state_digest, details_json
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      GMAIL_PARTITION_REPAIR_ID,
      planDigest,
      preconditionDigest,
      appliedAt,
      postStateDigest,
      detailsJson
    );
    return { details, postStateDigest };
  });
  const result = transaction();
  return {
    migrationId: GMAIL_PARTITION_REPAIR_ID,
    mode: rehearsal ? 'rehearsal' : 'live',
    status: 'applied',
    applied: true,
    changedRows: plan.actions.length + plan.canonicalStateRepairs.length,
    planDigest,
    preconditionDigest,
    postStateDigest: result.postStateDigest,
    ...result.details,
  };
}

module.exports = {
  EVIDENCE_CODES,
  GMAIL_PARTITION_REHEARSAL_CONFIRMATION,
  GMAIL_PARTITION_REPAIR_CONFIRMATION,
  GMAIL_PARTITION_REPAIR_ID,
  LOGICAL_ACCOUNT_IDS,
  OWNER_APPROVAL_OPERATION,
  OWNER_APPROVAL_SCHEMA_VERSION,
  QUARANTINE_ACCOUNT_ID,
  buildGmailPartitionRepairPlan,
  ftsAccountMismatchCount,
  ftsSearchFingerprint,
  partitionRepairPlanDigest,
  partitionRepairPreconditionDigest,
  postRepairStateDigest,
  repairGmailPartitions,
  validateOwnerApprovalMetadata,
  validatePartitionRepairPlan,
};
