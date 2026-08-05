const os = require('os');
const path = require('path');
const { buildArchiveConfig } = require('../../archive-worker/config');

describe('archive account identity mapping', () => {
  test('binds semantic accounts to the verified source credential keys', () => {
    const config = buildArchiveConfig({
      EMAIL_ARCHIVE_OUTLOOK_EXPECTED_IDENTITY: 'Work@Example.Test',
      EMAIL_ARCHIVE_GMAIL_ABLATIVE_EXPECTED_IDENTITY: 'Ablative@Example.Test',
      EMAIL_ARCHIVE_GMAIL_PERSONAL_EXPECTED_IDENTITY: 'Personal@Example.Test',
    });
    expect(config.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'vitasci-outlook',
          logicalAccountId: 'vitasci-outlook',
          credentialSlot: 'default-delegated',
          expectedIdentity: 'work@example.test',
        }),
        expect.objectContaining({
          id: 'gmail-ablative',
          displayName: 'Ablative Gmail',
          logicalAccountId: 'gmail-ablative',
          credentialSlot: 'personal',
          accountKey: 'personal',
          expectedIdentity: 'ablative@example.test',
        }),
        expect.objectContaining({
          id: 'gmail-personal',
          displayName: 'Personal Gmail',
          logicalAccountId: 'gmail-personal',
          credentialSlot: 'ablative',
          accountKey: 'ablative',
          expectedIdentity: 'personal@example.test',
        }),
      ])
    );
  });

  test('fails closed for missing or duplicate logical Gmail identities', () => {
    const missing = buildArchiveConfig({});
    expect(
      missing.accounts.find((account) => account.provider === 'outlook')
        .identityConfigurationError
    ).toBe('OUTLOOK_IDENTITY_CONFIG_MISSING');
    expect(
      missing.accounts
        .filter((account) => account.provider === 'gmail')
        .map((account) => account.identityConfigurationError)
    ).toEqual([
      'GMAIL_IDENTITY_CONFIG_MISSING',
      'GMAIL_IDENTITY_CONFIG_MISSING',
    ]);

    const duplicate = buildArchiveConfig({
      EMAIL_ARCHIVE_GMAIL_ABLATIVE_EXPECTED_IDENTITY: 'same@example.test',
      EMAIL_ARCHIVE_GMAIL_PERSONAL_EXPECTED_IDENTITY: 'SAME@example.test',
    });
    expect(
      duplicate.accounts
        .filter((account) => account.provider === 'gmail')
        .map((account) => account.identityConfigurationError)
    ).toEqual([
      'GMAIL_IDENTITY_CONFIG_DUPLICATE',
      'GMAIL_IDENTITY_CONFIG_DUPLICATE',
    ]);
  });

  test('uses the live local VitaSci delivery and receipt directories by default', () => {
    const config = buildArchiveConfig({});
    const localStatusRoot = path.join(
      os.homedir(),
      'Developer',
      '01-Vitasci',
      '_status'
    );

    expect(config.deliveryDestinations['vitasci-crm']).toBe(
      path.join(localStatusRoot, 'email-assistant-inbox')
    );
    expect(config.deliveryReceiptRoots['vitasci-crm']).toBe(
      path.join(localStatusRoot, 'email-assistant-receipts')
    );
    expect(config.deliveryDestinations['vitasci-crm']).not.toContain(
      `${path.sep}CloudStorage${path.sep}`
    );
    expect(config.deliveryReceiptRoots['vitasci-crm']).not.toContain(
      `${path.sep}CloudStorage${path.sep}`
    );
  });

  test('keeps downstream execution gated and ratifies the Command Centre brief path', () => {
    const defaults = buildArchiveConfig({});
    expect(defaults.downstreamDeliveryEnabled).toBe(false);
    expect(defaults.deliveryDestinations['hannibal-briefs']).toBe(
      path.join(
        os.homedir(),
        'Developer',
        'Assistant-Vault',
        '30-Business',
        'Email-Briefs'
      )
    );

    expect(
      buildArchiveConfig({
        EMAIL_ARCHIVE_DOWNSTREAM_DELIVERY_ENABLED: 'true',
      }).downstreamDeliveryEnabled
    ).toBe(true);
    expect(
      buildArchiveConfig({
        EMAIL_ARCHIVE_DOWNSTREAM_DELIVERY_ENABLED: 'yes',
      }).downstreamDeliveryEnabled
    ).toBe(false);
  });

  test('backs up through the direct encrypted OneDrive connection by default', () => {
    const config = buildArchiveConfig({});

    expect(config.backupRepository).toBe(
      'rclone:onedrive-vitasci:Email Assistant Archive Backup'
    );
    expect(config.backupRepository).not.toContain('CloudStorage');
  });

  test('bounds full reconciliation so new-mail polling can regain the worker lock', () => {
    const defaults = buildArchiveConfig({});
    expect(defaults.reconciliationBudgetSeconds).toBe(300);
    expect(defaults.reconciliationBatchSize).toBe(1);

    const configured = buildArchiveConfig({
      EMAIL_ARCHIVE_RECONCILIATION_BUDGET_SECONDS: '90',
      EMAIL_ARCHIVE_RECONCILIATION_BATCH_SIZE: '3',
    });
    expect(configured.reconciliationBudgetSeconds).toBe(90);
    expect(configured.reconciliationBatchSize).toBe(3);
  });
});
