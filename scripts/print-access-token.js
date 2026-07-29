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

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function redirectConsoleToStderr() {
  // getValidAccessToken() logs diagnostics via console.*; those must not land on
  // stdout, which is reserved for the bare token.
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    console[level] = (...args) => process.stderr.write(`${args.join(' ')}\n`);
  }
}

const TOKEN_ENV_KEYS = ['OUTLOOK_CLIENT_ID', 'OUTLOOK_AUTH_AUDIENCE'];
const DEFAULT_ENV_PATH = path.join(__dirname, '..', '.env');

function loadTokenEnvironment({
  envPath = DEFAULT_ENV_PATH,
  target = process.env,
} = {}) {
  if (!fs.existsSync(envPath)) return target;

  const parsed = dotenv.parse(fs.readFileSync(envPath));
  for (const key of TOKEN_ENV_KEYS) {
    if (!target[key] && parsed[key]) target[key] = parsed[key];
  }
  return target;
}

function buildTokenStorageConfig(config) {
  if (!config.AUTH_CONFIG.clientId) {
    throw new Error(
      `OUTLOOK_CLIENT_ID is not configured for the token helper. ` +
        `Set it in the repository .env or the invoking process environment.`
    );
  }

  return {
    clientId: config.AUTH_CONFIG.clientId,
    clientSecret: config.AUTH_CONFIG.clientSecret,
    tokenStorePath: config.AUTH_CONFIG.tokenStorePath,
    scopes: config.AUTH_CONFIG.scopes,
    tokenEndpoint: config.AUTH_CONFIG.tokenEndpoint,
  };
}

function resolveToken({
  config = null,
  TokenStorage = null,
  env = process.env,
} = {}) {
  // Test seam: a fake token short-circuits the real network refresh.
  if (env.__FAKE_NO_TOKEN) return null;
  if (env.__FAKE_ACCESS_TOKEN) return env.__FAKE_ACCESS_TOKEN;

  const resolvedConfig = config || require('../config');
  const ResolvedTokenStorage = TokenStorage || require('../auth/token-storage');
  const storage = new ResolvedTokenStorage(
    buildTokenStorageConfig(resolvedConfig)
  );
  return storage.getValidAccessToken();
}

async function main() {
  redirectConsoleToStderr();
  loadTokenEnvironment();
  const token = await resolveToken();
  if (!token) throw new Error('no valid token available');
  process.stdout.write(token);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${String((err && err.message) || err)}\n`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_ENV_PATH,
  buildTokenStorageConfig,
  loadTokenEnvironment,
  main,
  redirectConsoleToStderr,
  resolveToken,
};
