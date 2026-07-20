const { OutlookProvider } = require('./outlook');
const { GmailProvider } = require('./gmail');

function buildProviders({ config, mcpClient }) {
  return config.providers.map((providerId) => {
    if (providerId === 'outlook') {
      if (!mcpClient) {
        throw new Error('Outlook provider requires the MCP client.');
      }
      return new OutlookProvider({
        mcpClient,
        folder: config.folder,
        maxEmails: config.maxEmails,
      });
    }
    if (providerId === 'gmail') {
      return new GmailProvider({
        accountConfig: config.gmail.ablative,
        maxEmails: config.maxEmails,
      });
    }
    if (providerId.startsWith('gmail-')) {
      const accountKey = providerId.slice('gmail-'.length);
      const accountConfig = config.gmail[accountKey];
      if (!accountConfig) {
        throw new Error(
          `Gmail account '${accountKey}' is not configured. Add it to LOCAL_TRIAGE_GMAIL_ACCOUNTS.`
        );
      }
      return new GmailProvider({
        accountConfig,
        maxEmails: config.maxEmails,
      });
    }
    throw new Error(`Unknown local triage provider: ${providerId}`);
  });
}

module.exports = {
  buildProviders,
};
