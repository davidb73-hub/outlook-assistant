const { buildConfig, envNameForAccount } = require('../../local-worker/config');

describe('local-worker config', () => {
  test('envNameForAccount builds account-specific Gmail env keys', () => {
    expect(envNameForAccount('personal', 'CLIENT_ID')).toBe(
      'GMAIL_PERSONAL_CLIENT_ID'
    );
    expect(envNameForAccount('work-account', 'CLIENT_SECRET')).toBe(
      'GMAIL_WORK_ACCOUNT_CLIENT_SECRET'
    );
  });

  test('buildConfig supports multiple Gmail accounts', () => {
    const config = buildConfig({
      LOCAL_TRIAGE_PROVIDERS: 'outlook,gmail-ablative,gmail-personal',
      LOCAL_TRIAGE_GMAIL_ACCOUNTS: 'ablative,personal',
      GMAIL_CLIENT_ID: 'ablative-client',
      GMAIL_CLIENT_SECRET: 'ablative-secret',
      GMAIL_PERSONAL_CLIENT_ID: 'personal-client',
      GMAIL_PERSONAL_CLIENT_SECRET: 'personal-secret',
      GMAIL_PERSONAL_ACCOUNT_LABEL: 'Personal Gmail',
    });

    expect(config.providers).toEqual([
      'outlook',
      'gmail-ablative',
      'gmail-personal',
    ]);
    expect(config.gmail.ablative.clientId).toBe('ablative-client');
    expect(config.gmail.personal.clientId).toBe('personal-client');
    expect(config.gmail.personal.accountLabel).toBe('Personal Gmail');
  });
});
