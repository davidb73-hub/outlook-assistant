const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildIdentityStatus } = require('../../archive-worker/identity-status');

describe('privacy-safe provider identity status', () => {
  const config = {
    accounts: [
      {
        id: 'vitasci-outlook',
        logicalAccountId: 'vitasci-outlook',
        provider: 'outlook',
        credentialSlot: 'default-delegated',
        expectedIdentity: 'outlook@example.test',
      },
      {
        id: 'gmail-ablative',
        logicalAccountId: 'gmail-ablative',
        provider: 'gmail',
        credentialSlot: 'personal',
        expectedIdentity: 'ablative@example.test',
      },
      {
        id: 'gmail-personal',
        logicalAccountId: 'gmail-personal',
        provider: 'gmail',
        credentialSlot: 'ablative',
        expectedIdentity: 'personal@example.test',
      },
    ],
  };

  test('reports only safe binding fields and passes when every profile matches', async () => {
    const report = await buildIdentityStatus({
      config,
      providerFactory: (account) => ({
        auditIdentity: jest.fn().mockResolvedValue({
          logicalAccountId: account.logicalAccountId,
          credentialSlot: account.credentialSlot,
          expectedIdentityConfigured: true,
          identityMatch: true,
          verifiedAt: '2026-08-02T00:00:00.000Z',
          errorCode: null,
        }),
      }),
    });

    expect(report.passed).toBe(true);
    expect(report.accounts).toHaveLength(3);
    expect(Object.keys(report.accounts[0]).sort()).toEqual(
      [
        'credentialSlot',
        'errorCode',
        'expectedIdentityConfigured',
        'identityMatch',
        'logicalAccountId',
        'verifiedAt',
      ].sort()
    );
    expect(JSON.stringify(report)).not.toContain('@');
  });

  test('fails closed with a safe code when an identity is unproved', async () => {
    const report = await buildIdentityStatus({
      config,
      providerFactory: (account) => ({
        auditIdentity: jest.fn().mockResolvedValue({
          logicalAccountId: account.logicalAccountId,
          credentialSlot: account.credentialSlot,
          expectedIdentityConfigured: true,
          identityMatch: account.id !== 'gmail-personal',
          verifiedAt:
            account.id !== 'gmail-personal' ? '2026-08-02T00:00:00.000Z' : null,
          errorCode:
            account.id !== 'gmail-personal' ? null : 'GMAIL_IDENTITY_MISMATCH',
        }),
      }),
    });

    expect(report.passed).toBe(false);
    expect(
      report.accounts.find(
        (account) => account.logicalAccountId === 'gmail-personal'
      ).errorCode
    ).toBe('GMAIL_IDENTITY_MISMATCH');
  });

  test('fails closed when a provider reports a match together with an error', async () => {
    const report = await buildIdentityStatus({
      config,
      providerFactory: (account) => ({
        auditIdentity: jest.fn().mockResolvedValue({
          logicalAccountId: account.logicalAccountId,
          credentialSlot: account.credentialSlot,
          expectedIdentityConfigured: true,
          identityMatch: true,
          verifiedAt: '2026-08-02T00:00:00.000Z',
          errorCode:
            account.id === 'gmail-personal'
              ? 'GMAIL_IDENTITY_RESPONSE_INVALID'
              : null,
        }),
      }),
    });

    expect(report.passed).toBe(false);
    expect(
      report.accounts.find(
        (account) => account.logicalAccountId === 'gmail-personal'
      ).errorCode
    ).toBe('GMAIL_IDENTITY_RESPONSE_INVALID');
  });

  test('CLI identity audit does not create or open an archive database', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'identity-status-no-archive-')
    );
    fs.rmdirSync(root);
    const result = spawnSync(
      process.execPath,
      ['archive-worker/index.js', 'identity-status'],
      {
        cwd: path.resolve(__dirname, '../..'),
        encoding: 'utf8',
        env: {
          ...process.env,
          EMAIL_ARCHIVE_ROOT: root,
          EMAIL_ARCHIVE_OUTLOOK_EXPECTED_IDENTITY: '',
          EMAIL_ARCHIVE_GMAIL_ABLATIVE_EXPECTED_IDENTITY: '',
          EMAIL_ARCHIVE_GMAIL_PERSONAL_EXPECTED_IDENTITY: '',
        },
      }
    );

    expect(result.status).toBe(1);
    expect(fs.existsSync(root)).toBe(false);
    const report = JSON.parse(result.stdout);
    expect(report.passed).toBe(false);
    expect(JSON.stringify(report)).not.toContain('@');
  });
});
