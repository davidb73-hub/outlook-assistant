class OutlookProvider {
  constructor({ mcpClient, folder, maxEmails }) {
    this.id = 'outlook';
    this.label = 'Outlook';
    this.mcpClient = mcpClient;
    this.folder = folder;
    this.maxEmails = maxEmails;
  }

  async fetchMessages(providerState = {}) {
    let deltaResult = await this.fetchDeltaPage(providerState.deltaToken);
    let resetDelta = false;

    if (isExpiredDeltaResult(deltaResult)) {
      resetDelta = true;
      deltaResult = await this.fetchDeltaPage(null);
    }

    const active = extractActiveEmails(deltaResult)
      .slice(0, this.maxEmails)
      .map((email) => normalizeOutlookEmail(email, this));

    const messages = [];
    for (const email of active) {
      const content = await this.readEmail(email.providerMessageId);
      messages.push({
        ...email,
        content: content.slice(0, 4000),
      });
    }

    return {
      providerId: this.id,
      providerLabel: this.label,
      messages,
      nextState: {
        ...providerState,
        deltaToken:
          deltaResult?._meta?.deltaToken || providerState.deltaToken || null,
      },
      meta: {
        resetDelta,
        tokenType: deltaResult?._meta?.tokenType || null,
        itemCount: messages.length,
      },
    };
  }

  fetchDeltaPage(deltaToken) {
    return this.mcpClient.callTool('search-emails', {
      deltaMode: true,
      folder: this.folder,
      maxResults: this.maxEmails,
      outputVerbosity: 'minimal',
      ...(deltaToken ? { deltaToken } : {}),
    });
  }

  async readEmail(id) {
    const result = await this.mcpClient.callTool('read-email', {
      id,
      outputVerbosity: 'standard',
    });
    return result?.content?.[0]?.text || '';
  }
}

function extractActiveEmails(deltaResult) {
  const emails = deltaResult?._meta?.emails || deltaResult?._meta?.items || [];
  if (Array.isArray(emails) && emails.length > 0) {
    return emails.filter((email) => !email.removed && !email['@removed']);
  }
  return [];
}

function normalizeOutlookEmail(email, provider) {
  return {
    messageId: `${provider.id}:${email.id}`,
    providerId: provider.id,
    providerLabel: provider.label,
    providerMessageId: email.id,
    subject: email.subject || '',
    from:
      email.from?.emailAddress?.address ||
      email.from?.emailAddress?.name ||
      email.from ||
      '',
    receivedDateTime: email.receivedDateTime || '',
    bodyPreview: email.bodyPreview || '',
    isRead: email.isRead,
    importance: email.importance,
    hasAttachments: email.hasAttachments,
  };
}

function isExpiredDeltaResult(result) {
  const text = result?.content?.[0]?.text || '';
  return text.includes('Delta Token Expired');
}

module.exports = {
  OutlookProvider,
  extractActiveEmails,
  normalizeOutlookEmail,
};
