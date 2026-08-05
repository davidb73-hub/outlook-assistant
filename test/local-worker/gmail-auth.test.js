const {
  buildAuthUrl,
  verifyExpectedIdentity,
} = require('../../local-worker/gmail-auth');

describe('Gmail authorization identity guard', () => {
  const config = {
    clientId: 'client-id',
    redirectUri: 'http://localhost:3334/oauth2callback',
    expectedEmail: 'expected@example.test',
  };

  test('asks Google to select an account without putting its address in the URL', () => {
    const url = new URL(buildAuthUrl(config));
    expect(url.searchParams.get('prompt')).toBe('select_account consent');
    expect(url.searchParams.has('login_hint')).toBe(false);
    expect(url.toString()).not.toContain('expected@example.test');
  });

  test('accepts the expected Gmail profile', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        emailAddress: 'Expected@Example.Test',
      }),
    });
    await expect(
      verifyExpectedIdentity(config, { access_token: 'token' }, fetchImpl)
    ).resolves.toBe('expected@example.test');
  });

  test('rejects a different Gmail profile before token storage', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        emailAddress: 'wrong@example.test',
      }),
    });
    await expect(
      verifyExpectedIdentity(config, { access_token: 'token' }, fetchImpl)
    ).rejects.toThrow('GMAIL_IDENTITY_MISMATCH');
    await expect(
      verifyExpectedIdentity(config, { access_token: 'token' }, fetchImpl)
    ).rejects.not.toThrow('wrong@example.test');
  });
});
