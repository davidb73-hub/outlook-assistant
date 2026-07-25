const os = require('os');
const path = require('path');
const { buildArchiveConfig } = require('../../archive-worker/config');

describe('archive account identity mapping', () => {
  test('binds semantic accounts to the verified source credential keys', () => {
    const config = buildArchiveConfig({});
    expect(config.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'gmail-ablative',
          displayName: 'Ablative Gmail',
          accountKey: 'personal',
        }),
        expect.objectContaining({
          id: 'gmail-personal',
          displayName: 'Personal Gmail',
          accountKey: 'ablative',
        }),
      ])
    );
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
});
