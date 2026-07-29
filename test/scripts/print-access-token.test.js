const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(
  __dirname,
  '..',
  '..',
  'scripts',
  'print-access-token.js'
);
const {
  buildTokenStorageConfig,
  loadTokenEnvironment,
  resolveToken,
} = require('../../scripts/print-access-token');

test('prints only the access token when a token is resolved', () => {
  const out = execFileSync('node', [SCRIPT], {
    env: { ...process.env, __FAKE_ACCESS_TOKEN: 'tok-abc-123' },
    encoding: 'utf8',
  });
  // stdout must be the bare token and nothing else — diagnostics go to stderr.
  expect(out).toBe('tok-abc-123');
});

test('loads configuration path-independently when invoked from another cwd', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-token-cwd-'));
  try {
    const out = execFileSync('node', [SCRIPT], {
      cwd: tempDir,
      env: { ...process.env, __FAKE_ACCESS_TOKEN: 'tok-from-other-cwd' },
      encoding: 'utf8',
    });
    expect(out).toBe('tok-from-other-cwd');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('exits non-zero when no token is available', () => {
  expect(() =>
    execFileSync('node', [SCRIPT], {
      env: { ...process.env, __FAKE_ACCESS_TOKEN: '', __FAKE_NO_TOKEN: '1' },
      encoding: 'utf8',
      stdio: 'pipe',
    })
  ).toThrow();
});

test('loads only the token helper settings from a synthetic env file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlook-token-env-'));
  const envPath = path.join(tempDir, '.env');
  fs.writeFileSync(
    envPath,
    [
      'OUTLOOK_CLIENT_ID=synthetic-client-id',
      'OUTLOOK_AUTH_AUDIENCE=11111111-2222-3333-4444-555555555555',
      'OUTLOOK_CLIENT_SECRET=must-not-be-loaded',
      '',
    ].join('\n'),
    { mode: 0o600 }
  );

  try {
    const target = {};
    loadTokenEnvironment({ envPath, target });

    expect(target).toEqual({
      OUTLOOK_CLIENT_ID: 'synthetic-client-id',
      OUTLOOK_AUTH_AUDIENCE: '11111111-2222-3333-4444-555555555555',
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('passes a client id and tenant-specific endpoint into TokenStorage', async () => {
  const constructedWith = [];
  class FakeTokenStorage {
    constructor(config) {
      constructedWith.push(config);
    }

    getValidAccessToken() {
      return Promise.resolve('synthetic-token');
    }
  }

  const config = {
    AUTH_CONFIG: {
      clientId: 'synthetic-client-id',
      clientSecret: '',
      tokenStorePath: '/tmp/synthetic-token-store.json',
      scopes: ['offline_access', 'Mail.ReadWrite'],
      tokenEndpoint:
        'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/oauth2/v2.0/token',
    },
  };

  await expect(
    resolveToken({ config, TokenStorage: FakeTokenStorage, env: {} })
  ).resolves.toBe('synthetic-token');
  expect(constructedWith).toHaveLength(1);
  expect(constructedWith[0].clientId).toBeTruthy();
  expect(constructedWith[0].tokenEndpoint).not.toContain('/common/');
});

test('missing client id produces an actionable error', () => {
  expect(() =>
    buildTokenStorageConfig({
      AUTH_CONFIG: {
        clientId: '',
        clientSecret: '',
        tokenStorePath: '/tmp/synthetic-token-store.json',
        scopes: ['offline_access'],
        tokenEndpoint:
          'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/oauth2/v2.0/token',
      },
    })
  ).toThrow(/OUTLOOK_CLIENT_ID/);
});
