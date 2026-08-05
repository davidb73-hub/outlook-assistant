const fs = require('fs/promises');
const path = require('path');
const dotenv = require('dotenv');
const SqliteDatabase = require('better-sqlite3');
const { normalizeExpectedIdentity } = require('./config');
const { GmailArchiveProvider } = require('./providers/gmail');
const { OutlookArchiveProvider } = require('./providers/outlook');

const IDENTITY_SEED_CONFIRMATION = 'SEED_VERIFIED_ARCHIVE_IDENTITIES';
const TARGET_KEYS = Object.freeze({
  outlook: 'EMAIL_ARCHIVE_OUTLOOK_EXPECTED_IDENTITY',
  gmailAblative: 'EMAIL_ARCHIVE_GMAIL_ABLATIVE_EXPECTED_IDENTITY',
  gmailPersonal: 'EMAIL_ARCHIVE_GMAIL_PERSONAL_EXPECTED_IDENTITY',
});

class IdentitySeedError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'IdentitySeedError';
    this.code = code;
  }
}

function fail(code) {
  throw new IdentitySeedError(code);
}

function assignmentCount(content, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (content.match(new RegExp(`^\\s*${escaped}\\s*=`, 'gm')) || []).length;
}

function requireSingleAssignment(content, key, { required = false } = {}) {
  const count = assignmentCount(content, key);
  if (count > 1) fail('IDENTITY_SEED_DUPLICATE_ENV_KEY');
  if (required && count !== 1) fail('IDENTITY_SEED_SOURCE_MISSING');
}

function deriveGmailBindings(fileEnv, content, slotIdentities) {
  requireSingleAssignment(content, 'GMAIL_PERSONAL_EXPECTED_EMAIL');
  requireSingleAssignment(content, 'GMAIL_ABLATIVE_EXPECTED_EMAIL');
  requireSingleAssignment(content, 'GMAIL_EXPECTED_EMAIL');
  const logicalAblative = normalizeExpectedIdentity(slotIdentities?.personal);
  const logicalPersonal = normalizeExpectedIdentity(slotIdentities?.ablative);
  if (!logicalAblative || !logicalPersonal) {
    fail('IDENTITY_SEED_GMAIL_PROFILE_UNPROVED');
  }
  if (logicalAblative === logicalPersonal) {
    fail('IDENTITY_SEED_DUPLICATE_IDENTITY');
  }
  const legacyPersonalSlot = normalizeExpectedIdentity(
    fileEnv.GMAIL_PERSONAL_EXPECTED_EMAIL
  );
  const specificLegacy = normalizeExpectedIdentity(
    fileEnv.GMAIL_ABLATIVE_EXPECTED_EMAIL
  );
  const genericLegacy = normalizeExpectedIdentity(fileEnv.GMAIL_EXPECTED_EMAIL);
  if (specificLegacy && genericLegacy && specificLegacy !== genericLegacy) {
    fail('IDENTITY_SEED_LEGACY_SOURCE_CONFLICT');
  }
  const legacyAblativeSlot = specificLegacy || genericLegacy;
  if (
    (legacyPersonalSlot && legacyPersonalSlot !== logicalAblative) ||
    (legacyAblativeSlot && legacyAblativeSlot !== logicalPersonal)
  ) {
    fail('IDENTITY_SEED_LEGACY_SOURCE_CONFLICT');
  }
  return { logicalAblative, logicalPersonal };
}

async function probeGmailCredentialSlots({ env, slotProbeFactory = null }) {
  const mapping = [
    { slot: 'personal', logicalAccountId: 'gmail-ablative' },
    { slot: 'ablative', logicalAccountId: 'gmail-personal' },
  ];
  const probes = [];
  for (const binding of mapping) {
    const account = {
      id: binding.logicalAccountId,
      logicalAccountId: binding.logicalAccountId,
      provider: 'gmail',
      credentialSlot: binding.slot,
      accountKey: binding.slot,
      // Commissioning discovers the candidate first. The immutable anchor,
      // not this placeholder or the legacy slot label, grants semantic trust.
      expectedIdentity: 'commissioning-placeholder.invalid',
    };
    const provider = slotProbeFactory
      ? slotProbeFactory(account)
      : new GmailArchiveProvider({
          account,
          env,
          persistTokenRefresh: false,
        });
    const result = await provider.probeIdentityCandidateForCommissioning();
    if (
      result?.credentialSlot !== binding.slot ||
      !normalizeExpectedIdentity(result?.identity)
    ) {
      fail('IDENTITY_SEED_GMAIL_PROFILE_UNPROVED');
    }
    probes.push({
      slot: binding.slot,
      identity: normalizeExpectedIdentity(result.identity),
      refreshedInMemory: result.refreshedInMemory === true,
    });
  }
  return {
    slotIdentities: Object.fromEntries(
      probes.map((probe) => [probe.slot, probe.identity])
    ),
    refreshedInMemoryCount: probes.filter((probe) => probe.refreshedInMemory)
      .length,
    accountCount: probes.length,
  };
}

function assertTargetCompatible(fileEnv, content, key, expectedIdentity) {
  requireSingleAssignment(content, key);
  const configured = normalizeExpectedIdentity(fileEnv[key]);
  if (configured && configured !== expectedIdentity) {
    fail('IDENTITY_SEED_TARGET_CONFLICT');
  }
  return Boolean(configured);
}

function openEvidenceDatabase(DatabaseImpl, databasePath) {
  if (!databasePath) fail('IDENTITY_SEED_EVIDENCE_PATH_MISSING');
  const database = new DatabaseImpl(path.resolve(databasePath), {
    readonly: true,
    fileMustExist: true,
  });
  database.pragma('foreign_keys = ON');
  database.pragma('query_only = ON');
  return database;
}

function identityEvidence(database, accountId, identity) {
  return database
    .prepare(
      `SELECT
         COALESCE(SUM(CASE
           WHEN m.direction = 'outbound'
            AND r.recipient_type IN ('from', 'sender') THEN 1 ELSE 0 END), 0)
           AS outbound_sender_count,
         COALESCE(SUM(CASE
           WHEN m.direction = 'inbound'
            AND r.recipient_type IN ('to', 'cc', 'bcc') THEN 1 ELSE 0 END), 0)
           AS inbound_recipient_count
       FROM messages m
       JOIN recipients r ON r.message_id = m.id
       WHERE m.account_id = ?
         AND lower(trim(r.address)) = ?`
    )
    .get(accountId, identity);
}

function proveGmailAnchorBindings(database, bindings) {
  const rows = [
    {
      accountId: 'gmail-ablative',
      otherAccountId: 'gmail-personal',
      identity: bindings.logicalAblative,
    },
    {
      accountId: 'gmail-personal',
      otherAccountId: 'gmail-ablative',
      identity: bindings.logicalPersonal,
    },
  ].map((binding) => {
    const own = identityEvidence(database, binding.accountId, binding.identity);
    const other = identityEvidence(
      database,
      binding.otherAccountId,
      binding.identity
    );
    return {
      outboundSenderCount: Number(own.outbound_sender_count),
      inboundRecipientCount: Number(own.inbound_recipient_count),
      conflictingOutboundSenderCount: Number(other.outbound_sender_count),
    };
  });
  if (
    rows.some(
      (row) =>
        row.outboundSenderCount < 1 ||
        row.inboundRecipientCount < 1 ||
        row.conflictingOutboundSenderCount !== 0
    )
  ) {
    fail('IDENTITY_SEED_GMAIL_ANCHOR_UNPROVED');
  }
  return rows;
}

function proveOutlookArchiveBinding(database, candidates) {
  const uniqueCandidates = [
    ...new Set(candidates.map(normalizeExpectedIdentity).filter(Boolean)),
  ];
  const evidence = uniqueCandidates.map((identity) => {
    const row = identityEvidence(database, 'vitasci-outlook', identity);
    return {
      identity,
      outboundSenderCount: Number(row.outbound_sender_count),
      inboundRecipientCount: Number(row.inbound_recipient_count),
    };
  });
  const proved = evidence.filter(
    (row) => row.outboundSenderCount > 0 && row.inboundRecipientCount > 0
  );
  if (proved.length !== 1) {
    fail('IDENTITY_SEED_OUTLOOK_ARCHIVE_UNPROVED');
  }
  return { identity: proved[0].identity, evidence: proved[0] };
}

function replaceOrAppendAssignments(content, values) {
  let next = content;
  const appended = [];
  for (const [key, value] of Object.entries(values)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^(\\s*)${escaped}\\s*=.*$`, 'm');
    const assignment = `${key}=${JSON.stringify(value)}`;
    if (pattern.test(next)) next = next.replace(pattern, assignment);
    else appended.push(assignment);
  }
  if (appended.length > 0) {
    if (next.length > 0 && !next.endsWith('\n')) next += '\n';
    next += `${appended.join('\n')}\n`;
  }
  return next;
}

async function atomicWriteOwnerOnly(filePath, content, fsImpl = fs) {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.identity-seed-${process.pid}-${Date.now()}`
  );
  let handle;
  try {
    handle = await fsImpl.open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsImpl.rename(temporary, filePath);
    await fsImpl.chmod(filePath, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function seedArchiveIdentities({
  envPath = path.resolve(__dirname, '..', '.env'),
  archiveDatabasePath,
  anchorDatabasePath,
  apply = false,
  confirmation = null,
  DatabaseImpl = SqliteDatabase,
  fsImpl = fs,
  gmailSlotProbeFactory = null,
  outlookProfileProbe = null,
  processEnv = process.env,
} = {}) {
  if (apply && confirmation !== IDENTITY_SEED_CONFIRMATION) {
    fail('IDENTITY_SEED_CONFIRMATION_REQUIRED');
  }
  const absoluteEnvPath = path.resolve(envPath);
  const stat = await fsImpl.lstat(absoluteEnvPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('IDENTITY_SEED_ENV_FILE_UNSAFE');
  }
  const content = await fsImpl.readFile(absoluteEnvPath, 'utf8');
  const fileEnv = dotenv.parse(content);
  const gmailProbe = await probeGmailCredentialSlots({
    env: { ...processEnv, ...fileEnv },
    slotProbeFactory: gmailSlotProbeFactory,
  });
  const gmailBindings = deriveGmailBindings(
    fileEnv,
    content,
    gmailProbe.slotIdentities
  );
  const gmailTargetsAlreadySet = [
    assertTargetCompatible(
      fileEnv,
      content,
      TARGET_KEYS.gmailAblative,
      gmailBindings.logicalAblative
    ),
    assertTargetCompatible(
      fileEnv,
      content,
      TARGET_KEYS.gmailPersonal,
      gmailBindings.logicalPersonal
    ),
  ];

  let anchorDatabase;
  let archiveDatabase;
  try {
    anchorDatabase = openEvidenceDatabase(DatabaseImpl, anchorDatabasePath);
    archiveDatabase = openEvidenceDatabase(DatabaseImpl, archiveDatabasePath);
    const gmailAnchor = proveGmailAnchorBindings(anchorDatabase, gmailBindings);
    const outlookProbe = outlookProfileProbe
      ? await outlookProfileProbe()
      : await new OutlookArchiveProvider({
          account: {
            id: 'vitasci-outlook',
            logicalAccountId: 'vitasci-outlook',
            provider: 'outlook',
            credentialSlot: 'default-delegated',
            // Commissioning intentionally discovers the candidate first; the
            // value becomes trusted only after archive evidence matches.
            expectedIdentity: 'commissioning-placeholder.invalid',
          },
          persistTokenRefresh: false,
        }).probeIdentityCandidatesForCommissioning();
    const outlook = proveOutlookArchiveBinding(
      archiveDatabase,
      outlookProbe.candidates || []
    );
    const outlookTargetAlreadySet = assertTargetCompatible(
      fileEnv,
      content,
      TARGET_KEYS.outlook,
      outlook.identity
    );
    if (
      new Set([
        gmailBindings.logicalAblative,
        gmailBindings.logicalPersonal,
        outlook.identity,
      ]).size !== 3
    ) {
      fail('IDENTITY_SEED_DUPLICATE_IDENTITY');
    }

    const values = {
      [TARGET_KEYS.outlook]: outlook.identity,
      [TARGET_KEYS.gmailAblative]: gmailBindings.logicalAblative,
      [TARGET_KEYS.gmailPersonal]: gmailBindings.logicalPersonal,
    };
    const nextContent = replaceOrAppendAssignments(content, values);
    const changed = nextContent !== content;
    if (apply && changed) {
      await atomicWriteOwnerOnly(absoluteEnvPath, nextContent, fsImpl);
    }
    const finalMode = apply
      ? (await fsImpl.stat(absoluteEnvPath)).mode & 0o777
      : stat.mode & 0o777;
    let code = 'IDENTITY_SEED_DRY_RUN_VERIFIED';
    if (apply && changed) code = 'IDENTITY_SEED_APPLIED';
    else if (apply) code = 'IDENTITY_SEED_ALREADY_CONFIGURED';
    return {
      code,
      applied: apply && changed,
      wouldChange: changed,
      targetKeysConfigured: {
        outlook: outlookTargetAlreadySet || (apply && changed),
        gmailAblative: gmailTargetsAlreadySet[0] || (apply && changed),
        gmailPersonal: gmailTargetsAlreadySet[1] || (apply && changed),
      },
      gmail: {
        anchorBindingProved: gmailAnchor.every(
          (row) =>
            row.outboundSenderCount > 0 &&
            row.inboundRecipientCount > 0 &&
            row.conflictingOutboundSenderCount === 0
        ),
        profileBindingProved: true,
        accountCount: gmailProbe.accountCount,
        refreshedInMemoryCount: gmailProbe.refreshedInMemoryCount,
      },
      outlook: {
        profileRead: (outlookProbe.candidates || []).length > 0,
        archiveBindingProved: true,
        refreshedInMemory: outlookProbe.refreshedInMemory === true,
        outboundEvidenceCount: outlook.evidence.outboundSenderCount,
        inboundEvidenceCount: outlook.evidence.inboundRecipientCount,
      },
      ownerOnlyMode: finalMode === 0o600,
    };
  } finally {
    anchorDatabase?.close();
    archiveDatabase?.close();
  }
}

module.exports = {
  IDENTITY_SEED_CONFIRMATION,
  IdentitySeedError,
  TARGET_KEYS,
  atomicWriteOwnerOnly,
  deriveGmailBindings,
  identityEvidence,
  proveGmailAnchorBindings,
  proveOutlookArchiveBinding,
  probeGmailCredentialSlots,
  replaceOrAppendAssignments,
  seedArchiveIdentities,
};
