function createProvider(account, options = {}) {
  if (account.provider === 'outlook') {
    const { OutlookArchiveProvider } = require('./outlook');
    return new OutlookArchiveProvider({ account, ...options.outlook });
  }
  if (account.provider === 'gmail') {
    const { GmailArchiveProvider } = require('./gmail');
    return new GmailArchiveProvider({ account, ...options.gmail });
  }
  throw new Error(`Unsupported archive provider: ${account.provider}`);
}

module.exports = {
  createProvider,
};
