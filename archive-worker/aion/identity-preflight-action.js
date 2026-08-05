'use strict';

const { buildArchiveConfig } = require('../config');
const { buildIdentityStatus } = require('../identity-status');

const CONFIRMATION = 'IDENTITY_ONLY_NO_ARCHIVE_WRITE';
const COMMAND_TIMEOUT_MS = 45_000;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function parseInput(rawInput) {
  let input;
  try {
    input = JSON.parse(rawInput);
  } catch {
    fail('IDENTITY_PREFLIGHT_INPUT_INVALID');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('IDENTITY_PREFLIGHT_INPUT_INVALID');
  }
  if (Object.keys(input).length !== 1 || input.confirmation !== CONFIRMATION) {
    fail('IDENTITY_PREFLIGHT_CONFIRMATION_REQUIRED');
  }
  return input;
}

function safeString(value) {
  return typeof value === 'string' ? value : '';
}

function sanitizeReport(report) {
  if (!report || !Array.isArray(report.accounts)) {
    fail('IDENTITY_PREFLIGHT_REPORT_INVALID');
  }
  const accounts = report.accounts.map((account) => ({
    logical_account_id: safeString(account.logicalAccountId),
    credential_slot: safeString(account.credentialSlot),
    expected_identity_configured: account.expectedIdentityConfigured === true,
    identity_match: account.identityMatch === true,
    verified_at: safeString(account.verifiedAt),
    error_code: safeString(account.errorCode),
  }));
  const passed =
    report.passed === true &&
    accounts.length === 3 &&
    accounts.every(
      (account) =>
        account.expected_identity_configured &&
        account.identity_match &&
        account.error_code === ''
    );

  return {
    passed,
    generated_at: safeString(report.generatedAt),
    accounts,
    archive_opened: false,
    credentials_persisted: false,
  };
}

async function executeIdentityPreflight(
  input,
  {
    env = process.env,
    configBuilder = buildArchiveConfig,
    statusBuilder = buildIdentityStatus,
  } = {}
) {
  if (input?.confirmation !== CONFIRMATION) {
    fail('IDENTITY_PREFLIGHT_CONFIRMATION_REQUIRED');
  }
  const config = configBuilder(env);
  const report = await statusBuilder({ config, env });
  return sanitizeReport(report);
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) fail('IDENTITY_PREFLIGHT_INPUT_INVALID');
  const input = parseInput(argv[0]);
  const timeout = setTimeout(() => {
    process.stderr.write('IDENTITY_PREFLIGHT_TIMEOUT\n');
    process.exit(1);
  }, COMMAND_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const result = await executeIdentityPreflight(input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    clearTimeout(timeout);
  }
}

if (require.main === module) {
  main().catch((error) => {
    const code = String(error?.code || 'IDENTITY_PREFLIGHT_FAILED');
    process.stderr.write(
      `${code.startsWith('IDENTITY_PREFLIGHT_') ? code : 'IDENTITY_PREFLIGHT_FAILED'}\n`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  COMMAND_TIMEOUT_MS,
  CONFIRMATION,
  executeIdentityPreflight,
  parseInput,
  sanitizeReport,
};
