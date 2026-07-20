const path = require('path');

describe('OUTLOOK_ACCOUNT_ID token profile paths', () => {
  const originalEnv = { ...process.env };
  const mockHome = '/mock/home';

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, HOME: mockHome };
    delete process.env.OUTLOOK_ACCOUNT_ID;
    delete process.env.OUTLOOK_TOKEN_STORE_PATH;
    delete process.env.OUTLOOK_DEVICE_CODE_STATE_PATH;
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  test('keeps the legacy token and pending-auth paths by default', () => {
    const { AUTH_CONFIG } = require('../../config');

    expect(AUTH_CONFIG.accountId).toBeNull();
    expect(AUTH_CONFIG.tokenStorePath).toBe(
      path.join(mockHome, '.outlook-assistant-tokens.json')
    );
    expect(AUTH_CONFIG.deviceCodeStatePath).toBe(
      path.join(mockHome, '.outlook-assistant-pending-auth.json')
    );
  });

  test('uses separate token and pending-auth files for a named account profile', () => {
    process.env.OUTLOOK_ACCOUNT_ID = 'work';

    const { AUTH_CONFIG } = require('../../config');

    expect(AUTH_CONFIG.accountId).toBe('work');
    expect(AUTH_CONFIG.tokenStorePath).toBe(
      path.join(mockHome, '.outlook-assistant-work-tokens.json')
    );
    expect(AUTH_CONFIG.deviceCodeStatePath).toBe(
      path.join(mockHome, '.outlook-assistant-work-pending-auth.json')
    );
  });

  test('rejects account profile names that could become unsafe paths', () => {
    process.env.OUTLOOK_ACCOUNT_ID = '../personal';

    expect(() => require('../../config')).toThrow(
      /OUTLOOK_ACCOUNT_ID may only contain/
    );
  });

  test('allows explicit token and pending-auth paths for advanced deployments', () => {
    process.env.OUTLOOK_TOKEN_STORE_PATH = '~/tokens/outlook-client-a.json';
    process.env.OUTLOOK_DEVICE_CODE_STATE_PATH =
      '~/tokens/outlook-client-a-pending.json';

    const { AUTH_CONFIG } = require('../../config');

    expect(AUTH_CONFIG.tokenStorePath).toBe(
      path.join(mockHome, 'tokens/outlook-client-a.json')
    );
    expect(AUTH_CONFIG.deviceCodeStatePath).toBe(
      path.join(mockHome, 'tokens/outlook-client-a-pending.json')
    );
  });
});
