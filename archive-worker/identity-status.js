const { GmailArchiveProvider } = require('./providers/gmail');
const { OutlookArchiveProvider } = require('./providers/outlook');

function identityErrorPrefix(account) {
  return account.provider === 'outlook' ? 'OUTLOOK' : 'GMAIL';
}

function safeFailedStatus(account, error) {
  return {
    logicalAccountId: account.logicalAccountId || account.id,
    credentialSlot: account.credentialSlot || account.accountKey || null,
    expectedIdentityConfigured:
      Boolean(account.expectedIdentity) && !account.identityConfigurationError,
    identityMatch: false,
    verifiedAt: null,
    errorCode:
      error?.code ||
      account.identityConfigurationError ||
      `${identityErrorPrefix(account)}_IDENTITY_UNPROVED`,
  };
}

async function buildIdentityStatus({
  config,
  env = process.env,
  providerFactory = (account) => {
    if (account.provider === 'gmail') {
      return new GmailArchiveProvider({
        account,
        env,
        persistTokenRefresh: false,
      });
    }
    if (account.provider === 'outlook') {
      return new OutlookArchiveProvider({ account });
    }
    throw new Error('IDENTITY_PROVIDER_UNSUPPORTED');
  },
} = {}) {
  const accounts = [];
  for (const account of (config?.accounts || []).filter((candidate) =>
    ['gmail', 'outlook'].includes(candidate.provider)
  )) {
    try {
      const status = await providerFactory(account).auditIdentity();
      accounts.push({
        logicalAccountId: status.logicalAccountId,
        credentialSlot: status.credentialSlot,
        expectedIdentityConfigured: status.expectedIdentityConfigured,
        identityMatch: status.identityMatch,
        verifiedAt: status.verifiedAt,
        errorCode: status.errorCode,
      });
    } catch (error) {
      accounts.push(safeFailedStatus(account, error));
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    passed:
      accounts.length > 0 &&
      accounts.every(
        (account) =>
          account.expectedIdentityConfigured &&
          account.identityMatch &&
          !account.errorCode
      ),
    accounts,
  };
}

module.exports = {
  buildIdentityStatus,
  safeFailedStatus,
};
