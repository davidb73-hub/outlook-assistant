const fs = require('fs/promises');
const path = require('path');
const { buildGmailAccountConfig } = require('../../local-worker/config');
const { ProviderHttpClient, ProviderHttpError } = require('./http-client');
const {
  collectGmailParts,
  decodeBase64Url,
  headerMap,
  normalizedDate,
  parseAddresses,
} = require('./normalization');

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const EXCLUDED_LABEL_IDS = new Set(['DRAFT', 'SPAM', 'TRASH']);

function gmailPath(value) {
  return encodeURIComponent(String(value));
}

class GmailArchiveProvider {
  constructor({
    account,
    env = process.env,
    httpClient = null,
    fetchImpl = globalThis.fetch,
  }) {
    this.account = account;
    this.accountId = account.id;
    this.config = buildGmailAccountConfig(env, account.accountKey);
    this.fetchImpl = fetchImpl;
    this.labels = new Map();
    this.http =
      httpClient ||
      new ProviderHttpClient({
        baseUrl: GMAIL_API,
        getAccessToken: (forceRefresh) => this.getAccessToken(forceRefresh),
        fetchImpl,
        // Gmail's documented policy starts exponential backoff at one second,
        // adds up to one second of jitter, and typically caps at 32 or 64
        // seconds. Six bounded retries give a transient quota window time to
        // clear without holding the 15-minute worker indefinitely.
        maxRetries: 6,
        retryBaseMs: 1000,
        maxRetryDelayMs: 64_000,
        retryJitterMs: 1000,
      });
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
    await fs.mkdir(path.dirname(this.config.tokenPath), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.config.tokenPath}.archive-tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(token, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.rename(temporary, this.config.tokenPath);
    await fs.chmod(this.config.tokenPath, 0o600);
  }

  async getAccessToken(forceRefresh = false) {
    const token = await this.readToken();
    const refreshToken = token.refresh_token || this.config.refreshToken;
    if (!this.config.clientId || !this.config.clientSecret || !refreshToken) {
      throw new Error(
        `${this.account.displayName} needs read-only Gmail authentication. Run npm run triage:gmail-auth -- ${this.account.accountKey}.`
      );
    }
    if (
      !forceRefresh &&
      token.access_token &&
      token.expires_at > Date.now() + 60_000
    ) {
      return token.access_token;
    }

    const response = await this.fetchImpl(TOKEN_ENDPOINT, {
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
      throw new ProviderHttpError(
        `${this.account.displayName} authentication refresh failed (HTTP ${response.status}). Re-authenticate that account; its archive checkpoint is unchanged.`,
        { status: response.status, code: 'GMAIL_AUTH', retryable: false }
      );
    }
    const refreshed = await response.json();
    const next = {
      ...token,
      refresh_token: refreshToken,
      access_token: refreshed.access_token,
      expires_at: Date.now() + Number(refreshed.expires_in || 3600) * 1000,
      scope: refreshed.scope || token.scope,
      token_type: refreshed.token_type || token.token_type,
    };
    await this.writeToken(next);
    return next.access_token;
  }

  async refreshLocations() {
    const response = await this.http.request('users/me/labels');
    this.labels = new Map(
      (response.labels || []).map((label) => [label.id, label])
    );
    return (response.labels || []).map((label) => ({
      providerFolderId: label.id,
      displayName: label.name,
      kind: label.type === 'system' ? label.id.toLowerCase() : 'custom',
      excluded: EXCLUDED_LABEL_IDS.has(label.id),
      raw: { id: label.id, name: label.name, type: label.type },
    }));
  }

  async ensureLocations() {
    if (this.labels.size === 0) await this.refreshLocations();
  }

  isEligibleLabelSet(labelIds = []) {
    return !labelIds.some((labelId) => EXCLUDED_LABEL_IDS.has(labelId));
  }

  async listRecent({ pageSize = 50 } = {}) {
    const query = new URLSearchParams({
      q: 'newer_than:2d -in:drafts -in:spam -in:trash',
      maxResults: String(Math.min(pageSize, 500)),
    });
    const response = await this.http.request(
      `users/me/messages?${query.toString()}`
    );
    return (response.messages || []).map((message) => ({ id: message.id }));
  }

  async listBackfillPage(cursor = null, { pageSize = 100 } = {}) {
    const query = new URLSearchParams({
      q: '-in:drafts -in:spam -in:trash',
      maxResults: String(Math.min(pageSize, 500)),
    });
    if (cursor) query.set('pageToken', cursor);
    const response = await this.http.request(
      `users/me/messages?${query.toString()}`
    );
    return {
      refs: (response.messages || []).map((message) => ({ id: message.id })),
      nextCursor: response.nextPageToken || null,
      complete: !response.nextPageToken,
      estimate: Number(response.resultSizeEstimate) || null,
    };
  }

  async getHistoryAnchor() {
    const profile = await this.http.request('users/me/profile');
    return String(profile.historyId);
  }

  async listIncrementalPage(cursor, { pageSize = 100 } = {}) {
    if (!cursor) {
      return {
        refs: await this.listRecent({ pageSize }),
        tombstones: [],
        nextCursor: await this.getHistoryAnchor(),
        complete: true,
        reset: false,
      };
    }

    let parsed = { startHistoryId: cursor, pageToken: null };
    if (cursor.startsWith('{')) {
      try {
        parsed = JSON.parse(cursor);
      } catch (error) {
        throw new Error(
          'Gmail archive cursor is invalid; no checkpoint was advanced',
          { cause: error }
        );
      }
    }
    const query = new URLSearchParams({
      startHistoryId: parsed.startHistoryId,
      maxResults: String(Math.min(pageSize, 500)),
    });
    if (parsed.pageToken) query.set('pageToken', parsed.pageToken);

    let response;
    try {
      response = await this.http.request(
        `users/me/history?${query.toString()}`
      );
    } catch (error) {
      if (error.status !== 404) throw error;
      return {
        refs: await this.listRecent({ pageSize }),
        tombstones: [],
        nextCursor: await this.getHistoryAnchor(),
        complete: true,
        reset: true,
      };
    }

    const ids = new Set();
    const deleted = new Set();
    for (const history of response.history || []) {
      for (const entry of [
        ...(history.messagesAdded || []),
        ...(history.labelsAdded || []),
        ...(history.labelsRemoved || []),
      ]) {
        if (entry.message?.id) ids.add(entry.message.id);
      }
      for (const entry of history.messagesDeleted || []) {
        if (entry.message?.id) deleted.add(entry.message.id);
      }
    }
    for (const id of ids) deleted.delete(id);

    const nextCursor = response.nextPageToken
      ? JSON.stringify({
          startHistoryId: parsed.startHistoryId,
          pageToken: response.nextPageToken,
        })
      : String(response.historyId || parsed.startHistoryId);
    return {
      refs: [...ids].map((id) => ({ id })),
      tombstones: [...deleted].map((id) => ({ id, reason: 'deleted' })),
      nextCursor,
      complete: !response.nextPageToken,
      reset: false,
    };
  }

  async fetchBundle(ref) {
    await this.ensureLocations();
    const id = gmailPath(ref.id);
    const [full, raw] = await Promise.all([
      this.http.request(`users/me/messages/${id}?format=full`),
      this.http.request(`users/me/messages/${id}?format=raw`),
    ]);

    if (!this.isEligibleLabelSet(full.labelIds || [])) {
      return { ineligible: true, providerMessageId: full.id };
    }

    const headers = headerMap(full.payload?.headers || []);
    const first = (name) => headers.get(name)?.[0] || '';
    const parts = collectGmailParts(full.payload);
    const recipients = [
      ...parseAddresses(first('from'), 'from'),
      ...parseAddresses(first('sender'), 'sender'),
      ...parseAddresses(first('to'), 'to'),
      ...parseAddresses(first('cc'), 'cc'),
      ...parseAddresses(first('bcc'), 'bcc'),
      ...parseAddresses(first('reply-to'), 'reply-to'),
    ];
    const locations = (full.labelIds || []).map((labelId) => {
      const label = this.labels.get(labelId);
      return {
        providerLocationId: labelId,
        displayName: label?.name || labelId,
        kind: label?.type === 'system' ? labelId.toLowerCase() : 'custom',
      };
    });

    return {
      rawContent: decodeBase64Url(raw.raw),
      message: {
        providerMessageId: full.id,
        providerThreadId: full.threadId || null,
        internetMessageId: first('message-id') || null,
        subject: first('subject'),
        sentAt: normalizedDate(first('date')),
        receivedAt: normalizedDate(Number(full.internalDate)),
        providerCreatedAt: normalizedDate(Number(full.internalDate)),
        providerModifiedAt: null,
        direction: (full.labelIds || []).includes('SENT')
          ? 'outbound'
          : 'inbound',
        bodyText: parts.text.join('\n'),
        bodyHtml: parts.html.join('\n'),
        bodyContentType: parts.html.length > 0 ? 'html' : 'text',
        bodyPreview: full.snippet || '',
        importance: (full.labelIds || []).includes('IMPORTANT') ? 'high' : null,
        isRead: !(full.labelIds || []).includes('UNREAD'),
        hasAttachments: parts.attachments.length > 0,
        rawMediaType: 'message/rfc822',
        recipients,
        locations,
        attachments: parts.attachments,
        source: {
          id: full.id,
          threadId: full.threadId,
          labelIds: full.labelIds || [],
          historyId: full.historyId,
          internalDate: full.internalDate,
          sizeEstimate: full.sizeEstimate,
        },
      },
    };
  }

  async fetchAttachment(providerMessageId, attachment) {
    if (attachment.inlineData) return attachment.inlineData;
    // Gmail can expose a filename and attachmentId for an empty MIME part,
    // then reject that attachmentId with HTTP 400. The preserved raw MIME and
    // the provider-declared zero size make an empty buffer the deterministic
    // representation; no provider download is needed.
    if (attachment.size === 0) return Buffer.alloc(0);
    const response = await this.http.request(
      `users/me/messages/${gmailPath(providerMessageId)}/attachments/${gmailPath(
        attachment.providerAttachmentId
      )}`
    );
    return decodeBase64Url(response.data);
  }

  async listInventoryPage(cursor = null, { pageSize = 500 } = {}) {
    return this.listBackfillPage(cursor, { pageSize });
  }
}

module.exports = {
  EXCLUDED_LABEL_IDS,
  GmailArchiveProvider,
};
