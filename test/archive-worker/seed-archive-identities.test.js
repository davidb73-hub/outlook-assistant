const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { ArchiveDatabase } = require('../../archive-worker/database');
const {
  IDENTITY_SEED_CONFIRMATION,
  seedArchiveIdentities,
} = require('../../archive-worker/seed-archive-identities');

const IDENTITIES = Object.freeze({
  ablative: 'ablative@example.test',
  personal: 'personal@example.test',
  outlook: 'outlook@example.test',
});

function archiveMessage(id, direction, identity) {
  const counterpart = 'counterpart@example.test';
  return {
    providerMessageId: id,
    subject: 'Synthetic identity evidence',
    direction,
    recipients:
      direction === 'outbound'
        ? [
            { type: 'from', address: identity },
            { type: 'to', address: counterpart },
          ]
        : [
            { type: 'from', address: counterpart },
            { type: 'to', address: identity },
          ],
    locations: [],
    attachments: [],
  };
}

function createEvidenceDatabase(databasePath, accounts) {
  const database = new ArchiveDatabase(databasePath);
  for (const account of accounts) database.upsertAccount(account);
  for (const account of accounts) {
    const identity = IDENTITIES[account.identityKey];
    database.stageMessage(
      account.id,
      archiveMessage(`${account.id}-outbound`, 'outbound', identity),
      null
    );
    database.stageMessage(
      account.id,
      archiveMessage(`${account.id}-inbound`, 'inbound', identity),
      null
    );
  }
  database.close();
}

function gmailSlotProbeFactory(account) {
  return {
    probeIdentityCandidateForCommissioning: jest.fn().mockResolvedValue({
      credentialSlot: account.credentialSlot,
      identity:
        account.credentialSlot === 'personal'
          ? IDENTITIES.ablative
          : IDENTITIES.personal,
      refreshedInMemory: true,
    }),
  };
}

describe('privacy-safe archive identity seeding', () => {
  let root;
  let envPath;
  let archiveDatabasePath;
  let anchorDatabasePath;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-seed-test-'));
    envPath = path.join(root, '.env');
    archiveDatabasePath = path.join(root, 'archive.sqlite3');
    anchorDatabasePath = path.join(root, 'anchor.sqlite3');
    await fs.writeFile(
      envPath,
      [
        '# preserve this comment',
        'UNKNOWN_SETTING=preserved',
        `GMAIL_PERSONAL_EXPECTED_EMAIL=${IDENTITIES.ablative}`,
        `GMAIL_EXPECTED_EMAIL=${IDENTITIES.personal}`,
        '',
      ].join('\n'),
      { mode: 0o640 }
    );
    createEvidenceDatabase(anchorDatabasePath, [
      {
        id: 'gmail-ablative',
        provider: 'gmail',
        displayName: 'Ablative Gmail',
        identityKey: 'ablative',
      },
      {
        id: 'gmail-personal',
        provider: 'gmail',
        displayName: 'Personal Gmail',
        identityKey: 'personal',
      },
    ]);
    createEvidenceDatabase(archiveDatabasePath, [
      {
        id: 'vitasci-outlook',
        provider: 'outlook',
        displayName: 'VitaSci Outlook',
        identityKey: 'outlook',
      },
    ]);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function run(overrides = {}) {
    return seedArchiveIdentities({
      envPath,
      archiveDatabasePath,
      anchorDatabasePath,
      gmailSlotProbeFactory,
      outlookProfileProbe: jest.fn().mockResolvedValue({
        candidates: [IDENTITIES.outlook],
        refreshedInMemory: true,
      }),
      processEnv: {},
      ...overrides,
    });
  }

  test('dry-run proves live profiles and historical ownership without changing .env', async () => {
    const before = await fs.readFile(envPath, 'utf8');
    const report = await run();

    expect(report).toEqual(
      expect.objectContaining({
        code: 'IDENTITY_SEED_DRY_RUN_VERIFIED',
        applied: false,
        wouldChange: true,
        gmail: expect.objectContaining({
          anchorBindingProved: true,
          profileBindingProved: true,
          accountCount: 2,
          refreshedInMemoryCount: 2,
        }),
        outlook: expect.objectContaining({
          profileRead: true,
          archiveBindingProved: true,
          refreshedInMemory: true,
        }),
      })
    );
    expect(await fs.readFile(envPath, 'utf8')).toBe(before);
    expect(JSON.stringify(report)).not.toContain('@');
    expect(JSON.stringify(report)).not.toContain('example.test');
  });

  test('atomically preserves unknown content, adds three keys, and enforces mode 0600', async () => {
    const report = await run({
      apply: true,
      confirmation: IDENTITY_SEED_CONFIRMATION,
    });
    const content = await fs.readFile(envPath, 'utf8');

    expect(report).toEqual(
      expect.objectContaining({
        code: 'IDENTITY_SEED_APPLIED',
        applied: true,
        ownerOnlyMode: true,
      })
    );
    expect(content).toContain('# preserve this comment');
    expect(content).toContain('UNKNOWN_SETTING=preserved');
    expect(content).toContain(
      `EMAIL_ARCHIVE_OUTLOOK_EXPECTED_IDENTITY="${IDENTITIES.outlook}"`
    );
    expect(content).toContain(
      `EMAIL_ARCHIVE_GMAIL_ABLATIVE_EXPECTED_IDENTITY="${IDENTITIES.ablative}"`
    );
    expect(content).toContain(
      `EMAIL_ARCHIVE_GMAIL_PERSONAL_EXPECTED_IDENTITY="${IDENTITIES.personal}"`
    );
    expect((await fs.stat(envPath)).mode & 0o777).toBe(0o600);

    await expect(
      run({
        apply: true,
        confirmation: IDENTITY_SEED_CONFIRMATION,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        code: 'IDENTITY_SEED_ALREADY_CONFIGURED',
        applied: false,
        wouldChange: false,
      })
    );
  });

  test('refuses apply without the exact owner confirmation', async () => {
    await expect(run({ apply: true })).rejects.toEqual(
      expect.objectContaining({ code: 'IDENTITY_SEED_CONFIRMATION_REQUIRED' })
    );
  });

  test('does not depend on optional legacy expected-identity keys', async () => {
    await fs.writeFile(
      envPath,
      '# no legacy identity keys\nUNKNOWN_SETTING=preserved\n'
    );
    await expect(run()).resolves.toEqual(
      expect.objectContaining({
        code: 'IDENTITY_SEED_DRY_RUN_VERIFIED',
        applied: false,
        gmail: expect.objectContaining({
          anchorBindingProved: true,
          profileBindingProved: true,
        }),
      })
    );
  });

  test('refuses optional legacy values that contradict the probed slots', async () => {
    await fs.writeFile(
      envPath,
      [
        `GMAIL_PERSONAL_EXPECTED_EMAIL=${IDENTITIES.personal}`,
        `GMAIL_EXPECTED_EMAIL=${IDENTITIES.ablative}`,
        '',
      ].join('\n')
    );
    await expect(run()).rejects.toEqual(
      expect.objectContaining({ code: 'IDENTITY_SEED_LEGACY_SOURCE_CONFLICT' })
    );
  });

  test('refuses credential-slot profiles that contradict the July anchor', async () => {
    await fs.writeFile(envPath, 'UNKNOWN_SETTING=preserved\n');
    await expect(
      run({
        gmailSlotProbeFactory: (account) => ({
          probeIdentityCandidateForCommissioning: jest.fn().mockResolvedValue({
            credentialSlot: account.credentialSlot,
            identity:
              account.credentialSlot === 'personal'
                ? IDENTITIES.personal
                : IDENTITIES.ablative,
            refreshedInMemory: false,
          }),
        }),
      })
    ).rejects.toEqual(
      expect.objectContaining({ code: 'IDENTITY_SEED_GMAIL_ANCHOR_UNPROVED' })
    );
  });

  test('refuses an authenticated Outlook profile absent from archive ownership evidence', async () => {
    await expect(
      run({
        outlookProfileProbe: jest.fn().mockResolvedValue({
          candidates: ['unproved@example.test'],
          refreshedInMemory: false,
        }),
      })
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'IDENTITY_SEED_OUTLOOK_ARCHIVE_UNPROVED',
      })
    );
    const content = await fs.readFile(envPath, 'utf8');
    expect(content).not.toContain('EMAIL_ARCHIVE_OUTLOOK_EXPECTED_IDENTITY');
  });
});
