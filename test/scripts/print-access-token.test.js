const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'print-access-token.js');

test('prints only the access token when a token is resolved', () => {
  const out = execFileSync('node', [SCRIPT], {
    env: { ...process.env, __FAKE_ACCESS_TOKEN: 'tok-abc-123' },
    encoding: 'utf8',
  });
  // stdout must be the bare token and nothing else — diagnostics go to stderr.
  expect(out).toBe('tok-abc-123');
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
