// One-shot: print a valid Microsoft Graph access token to stdout, and nothing else.
//
// The canonical refresher (auth/token-storage.js) is the ONLY writer of the shared,
// rotating refresh token. This wrapper lets other-language callers (the command-centre
// draft pusher) obtain a fresh access token without racing that file — they shell out
// here instead of reading or refreshing the token themselves.
//
// It constructs TokenStorage exactly as auth/index.js does, so the refresh is redeemed
// against the full consented scope set (including Mail.ReadWrite) rather than the
// read-only defaults baked into the TokenStorage constructor.
'use strict';

// getValidAccessToken() logs diagnostics via console.*; those must not land on stdout,
// which is reserved for the bare token. Redirect all console output to stderr.
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => process.stderr.write(args.join(' ') + '\n');
}

async function resolveToken() {
  // Test seam: a fake token short-circuits the real network refresh.
  if (process.env.__FAKE_NO_TOKEN) return null;
  if (process.env.__FAKE_ACCESS_TOKEN) return process.env.__FAKE_ACCESS_TOKEN;

  const config = require('../config');
  const TokenStorage = require('../auth/token-storage');
  const storage = new TokenStorage({
    clientId: config.AUTH_CONFIG.clientId,
    clientSecret: config.AUTH_CONFIG.clientSecret,
    tokenStorePath: config.AUTH_CONFIG.tokenStorePath,
    scopes: config.AUTH_CONFIG.scopes,
    tokenEndpoint: config.AUTH_CONFIG.tokenEndpoint,
  });
  return storage.getValidAccessToken();
}

resolveToken()
  .then((token) => {
    if (!token) throw new Error('no valid token available');
    process.stdout.write(token);
  })
  .catch((err) => {
    process.stderr.write(String((err && err.message) || err) + '\n');
    process.exit(1);
  });
