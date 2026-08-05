const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(repoRoot, '.env'), quiet: true });

function parsePositiveInteger(value, fallback) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseList(value, fallback) {
  if (!value) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function envNameForAccount(accountKey, suffix) {
  return `GMAIL_${accountKey.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${suffix}`;
}

function titleCase(value) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function buildGmailAccountConfig(env, accountKey) {
  const prefix = (suffix) => env[envNameForAccount(accountKey, suffix)];
  const isLegacyAblative = accountKey === 'ablative';

  return {
    id: `gmail-${accountKey}`,
    accountKey,
    accountLabel:
      prefix('ACCOUNT_LABEL') ||
      (isLegacyAblative ? env.GMAIL_ACCOUNT_LABEL : null) ||
      `${titleCase(accountKey)} / Gmail`,
    expectedEmail:
      prefix('EXPECTED_EMAIL') ||
      (isLegacyAblative ? env.GMAIL_EXPECTED_EMAIL : '') ||
      '',
    clientId:
      prefix('CLIENT_ID') ||
      (isLegacyAblative ? env.GMAIL_CLIENT_ID : '') ||
      '',
    clientSecret:
      prefix('CLIENT_SECRET') ||
      (isLegacyAblative ? env.GMAIL_CLIENT_SECRET : '') ||
      '',
    refreshToken:
      prefix('REFRESH_TOKEN') ||
      (isLegacyAblative ? env.GMAIL_REFRESH_TOKEN : '') ||
      '',
    tokenPath:
      prefix('TOKEN_PATH') ||
      (isLegacyAblative ? env.GMAIL_TOKEN_PATH : '') ||
      path.join(__dirname, 'state', `gmail-${accountKey}-token.json`),
    redirectUri:
      prefix('REDIRECT_URI') ||
      (isLegacyAblative ? env.GMAIL_REDIRECT_URI : '') ||
      'http://localhost:3334/oauth2callback',
    query:
      prefix('QUERY') ||
      (isLegacyAblative ? env.GMAIL_QUERY : '') ||
      'in:inbox newer_than:14d -in:sent -in:drafts -in:trash',
  };
}

function buildConfig(env = process.env) {
  const providers = parseList(env.LOCAL_TRIAGE_PROVIDERS, ['outlook']);
  const gmailAccounts = parseList(env.LOCAL_TRIAGE_GMAIL_ACCOUNTS, [
    'ablative',
  ]);
  const gmail = Object.fromEntries(
    gmailAccounts.map((accountKey) => [
      accountKey,
      buildGmailAccountConfig(env, accountKey),
    ])
  );

  return {
    repoRoot,
    providers,
    folder: env.LOCAL_TRIAGE_FOLDER || 'inbox',
    maxEmails: parsePositiveInteger(env.LOCAL_TRIAGE_MAX_EMAILS, 5),
    model: env.LOCAL_TRIAGE_MODEL || 'mistral-small3.2:24b',
    fallbackModel: env.LOCAL_TRIAGE_FALLBACK_MODEL || 'qwen3.6:27b',
    ollamaUrl: env.LOCAL_TRIAGE_OLLAMA_URL || 'http://127.0.0.1:11434',
    statePath:
      env.LOCAL_TRIAGE_STATE_PATH ||
      path.join(__dirname, 'state', 'triage-state.json'),
    reportsDir: env.LOCAL_TRIAGE_REPORTS_DIR || path.join(__dirname, 'reports'),
    serverCommand: env.LOCAL_TRIAGE_MCP_COMMAND || process.execPath,
    serverArgs: env.LOCAL_TRIAGE_MCP_ARGS
      ? env.LOCAL_TRIAGE_MCP_ARGS.split(/\s+/).filter(Boolean)
      : [path.join(repoRoot, 'index.js')],
    gmail,
  };
}

module.exports = {
  buildConfig,
  buildGmailAccountConfig,
  envNameForAccount,
};
