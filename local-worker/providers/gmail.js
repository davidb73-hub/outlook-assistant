const fs = require('fs/promises');
const path = require('path');

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

class GmailProvider {
  constructor({ accountConfig, maxEmails }) {
    this.id = accountConfig.id;
    this.label = accountConfig.accountLabel;
    this.config = accountConfig;
    this.maxEmails = maxEmails;
  }

  async fetchMessages(providerState = {}) {
    const accessToken = await this.getAccessToken();
    const listed = await this.gmailFetch(
      accessToken,
      `/users/me/messages?${new URLSearchParams({
        q: this.config.query,
        maxResults: String(this.maxEmails),
      })}`
    );

    const processed = new Set(providerState.processedMessageIds || []);
    const candidates = (listed.messages || []).filter(
      (message) => !processed.has(message.id)
    );

    const messages = [];
    for (const candidate of candidates.slice(0, this.maxEmails)) {
      const message = await this.gmailFetch(
        accessToken,
        `/users/me/messages/${encodeURIComponent(candidate.id)}?${new URLSearchParams(
          { format: 'full' }
        )}`
      );
      messages.push(normalizeGmailMessage(message, this));
    }

    return {
      providerId: this.id,
      providerLabel: this.label,
      messages,
      nextState: {
        ...providerState,
        processedMessageIds: Array.from(
          new Set([
            ...(providerState.processedMessageIds || []),
            ...messages.map((message) => message.providerMessageId),
          ])
        ).slice(-1000),
      },
      meta: {
        query: this.config.query,
        itemCount: messages.length,
      },
    };
  }

  async getAccessToken() {
    const token = await this.readToken();
    const refreshToken = token.refresh_token || this.config.refreshToken;

    if (!this.config.clientId || !this.config.clientSecret || !refreshToken) {
      throw new Error(
        'Gmail provider requires GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN or a token file.'
      );
    }

    if (
      token.access_token &&
      token.expires_at &&
      token.expires_at > Date.now() + 60 * 1000
    ) {
      return token.access_token;
    }

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      throw new Error(`Gmail token refresh failed: ${response.status}`);
    }

    const refreshed = await response.json();
    const nextToken = {
      ...token,
      refresh_token: refreshToken,
      access_token: refreshed.access_token,
      expires_at: Date.now() + refreshed.expires_in * 1000,
    };
    await this.writeToken(nextToken);
    return nextToken.access_token;
  }

  async readToken() {
    try {
      return JSON.parse(await fs.readFile(this.config.tokenPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  async writeToken(token) {
    await fs.mkdir(path.dirname(this.config.tokenPath), { recursive: true });
    await fs.writeFile(
      `${this.config.tokenPath}.tmp`,
      `${JSON.stringify(token, null, 2)}\n`
    );
    await fs.rename(`${this.config.tokenPath}.tmp`, this.config.tokenPath);
  }

  async gmailFetch(accessToken, pathAndQuery) {
    const response = await fetch(`${GMAIL_API}${pathAndQuery}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Gmail API request failed: ${response.status}`);
    }
    return response.json();
  }
}

function normalizeGmailMessage(message, provider) {
  const headers = Object.fromEntries(
    (message.payload?.headers || []).map((header) => [
      header.name.toLowerCase(),
      header.value,
    ])
  );
  const text = extractPlainText(message.payload);

  return {
    messageId: `${provider.id}:${message.id}`,
    providerId: provider.id,
    providerLabel: provider.label,
    providerMessageId: message.id,
    subject: headers.subject || '',
    from: headers.from || '',
    receivedDateTime: headers.date || '',
    bodyPreview: message.snippet || '',
    isRead: !(message.labelIds || []).includes('UNREAD'),
    importance: null,
    hasAttachments: hasAttachments(message.payload),
    content: text || message.snippet || '',
  };
}

function extractPlainText(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts || []) {
    const text = extractPlainText(child);
    if (text) return text;
  }
  return '';
}

function hasAttachments(part) {
  if (!part) return false;
  if (part.filename && part.body?.attachmentId) return true;
  return (part.parts || []).some(hasAttachments);
}

function decodeBase64Url(value) {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    .toString('utf8')
    .trim();
}

module.exports = {
  GmailProvider,
  normalizeGmailMessage,
  extractPlainText,
  decodeBase64Url,
};
