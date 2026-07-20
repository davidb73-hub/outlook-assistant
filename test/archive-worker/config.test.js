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
});
