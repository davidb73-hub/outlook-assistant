const rootConfig = require('../../config');
const { ensureAuthenticated, tokenStorage } = require('../../auth');
const { ProviderHttpClient, ProviderHttpError } = require('./http-client');
const { graphRecipient, normalizedDate } = require('./normalization');

const GRAPH_API = 'https://graph.microsoft.com/v1.0/';
const EXCLUDED_WELL_KNOWN = ['drafts', 'junkemail', 'deleteditems'];
const EXCLUDED_NAMES = new Set([
  'drafts',
  'junk email',
  'junk',
  'spam',
  'deleted items',
  'trash',
]);
const IMMUTABLE_HEADER = { Prefer: 'IdType="ImmutableId"' };

function encode(value) {
  return encodeURIComponent(String(value));
}

function safeCursor(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(
      'Outlook archive cursor is invalid; no checkpoint was advanced'
    );
  }
}

class OutlookArchiveProvider {
  constructor({
    account,
    httpClient = null,
    tokenProvider = null,
    fetchImpl = globalThis.fetch,
  }) {
    this.account = account;
    this.accountId = account.id;
    this.folders = new Map();
    this.tokenProvider = tokenProvider || this.defaultTokenProvider.bind(this);
    this.http =
      httpClient ||
      new ProviderHttpClient({
        baseUrl: GRAPH_API,
        getAccessToken: this.tokenProvider,
        fetchImpl,
        defaultHeaders: IMMUTABLE_HEADER,
      });
  }

  mailboxRoot() {
    if (rootConfig.AUTH_CONFIG.defaultAuthMethod !== 'client-credentials') {
      return 'me';
    }
    const target = rootConfig.CLIENT_CREDENTIALS_CONFIG.targetUser;
    if (!target) throw new Error('OUTLOOK_TARGET_USER is required');
    return `users/${encode(target)}`;
  }

  async defaultTokenProvider(forceRefresh = false) {
    if (!forceRefresh) return ensureAuthenticated();
    if (rootConfig.AUTH_CONFIG.defaultAuthMethod === 'client-credentials') {
      return ensureAuthenticated();
    }
    await tokenStorage.getTokens();
    return tokenStorage.refreshAccessToken();
  }

  async paginated(pathOrUrl) {
    const values = [];
    let next = pathOrUrl;
    while (next) {
      const page = await this.http.request(next);
      values.push(...(page.value || []));
      next = page['@odata.nextLink'] || null;
    }
    return values;
  }

  async refreshLocations() {
    const root = this.mailboxRoot();
    const excludedIds = new Set();
    for (const name of EXCLUDED_WELL_KNOWN) {
      try {
        const folder = await this.http.request(
          `${root}/mailFolders/${name}?$select=id`
        );
        if (folder.id) excludedIds.add(folder.id);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }

    const queue = await this.paginated(
      `${root}/mailFolders?includeHiddenFolders=true&$top=100`
    );
    const folders = [];
    while (queue.length > 0) {
      const folder = queue.shift();
      folders.push(folder);
      if (Number(folder.childFolderCount) > 0) {
        const children = await this.paginated(
          `${root}/mailFolders/${encode(
            folder.id
          )}/childFolders?includeHiddenFolders=true&$top=100`
        );
        queue.push(...children);
      }
    }

    this.folders = new Map(
      folders.map((folder) => [
        folder.id,
        {
          ...folder,
          excluded:
            excludedIds.has(folder.id) ||
            EXCLUDED_NAMES.has(String(folder.displayName || '').toLowerCase()),
        },
      ])
    );
    return [...this.folders.values()].map((folder) => ({
      providerFolderId: folder.id,
      displayName: folder.displayName || '',
      kind: this.folderKind(folder),
      excluded: folder.excluded,
      raw: {
        id: folder.id,
        displayName: folder.displayName,
        parentFolderId: folder.parentFolderId,
        childFolderCount: folder.childFolderCount,
        totalItemCount: folder.totalItemCount,
      },
    }));
  }

  folderKind(folder) {
    const name = String(folder.displayName || '').toLowerCase();
    if (name === 'inbox') return 'inbox';
    if (name === 'sent items' || name === 'sent') return 'sent';
    if (name === 'archive') return 'archive';
    return 'custom';
  }

  async ensureLocations() {
    if (this.folders.size === 0) await this.refreshLocations();
  }

  eligibleFolders() {
    return [...this.folders.values()]
      .filter((folder) => !folder.excluded)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async listRecent({ pageSize = 50 } = {}) {
    await this.ensureLocations();
    const cutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const refs = new Map();
    const folders = this.eligibleFolders();
    const perFolder = Math.max(1, Math.ceil(pageSize / folders.length));
    for (const folder of folders) {
      const query = new URLSearchParams({
        $select: 'id,parentFolderId,lastModifiedDateTime',
        $filter: `receivedDateTime ge ${cutoff}`,
        $orderby: 'receivedDateTime desc',
        $top: String(Math.min(perFolder, 250)),
      });
      const response = await this.http.request(
        `${this.mailboxRoot()}/mailFolders/${encode(
          folder.id
        )}/messages?${query.toString()}`
      );
      for (const message of response.value || []) {
        refs.set(message.id, {
          id: message.id,
          folderId: folder.id,
          modifiedAt: message.lastModifiedDateTime || '',
        });
      }
    }
    return [...refs.values()]
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
      .slice(0, pageSize);
  }

  async listBackfillPage(cursor = null, { pageSize = 100 } = {}) {
    await this.ensureLocations();
    const folders = this.eligibleFolders();
    let state = safeCursor(cursor, { folderIndex: 0, nextLink: null });
    const estimate = folders.reduce(
      (sum, item) => sum + Number(item.totalItemCount || 0),
      0
    );

    while (state.folderIndex < folders.length) {
      const folder = folders[state.folderIndex];
      const query = new URLSearchParams({
        $select: 'id,parentFolderId,lastModifiedDateTime',
        $orderby: 'receivedDateTime desc',
        $top: String(Math.min(pageSize, 250)),
      });
      const response = await this.http.request(
        state.nextLink ||
          `${this.mailboxRoot()}/mailFolders/${encode(
            folder.id
          )}/messages?${query.toString()}`
      );
      const refs = (response.value || []).map((message) => ({
        id: message.id,
        folderId: folder.id,
      }));
      const nextState = response['@odata.nextLink']
        ? {
            folderIndex: state.folderIndex,
            nextLink: response['@odata.nextLink'],
          }
        : { folderIndex: state.folderIndex + 1, nextLink: null };
      const complete = nextState.folderIndex >= folders.length;

      if (refs.length > 0 || response['@odata.nextLink'] || complete) {
        return {
          refs,
          nextCursor: complete ? null : JSON.stringify(nextState),
          complete,
          estimate,
        };
      }

      // Empty folders contain no checkpoint-worthy work. Continue within the
      // same call so a mailbox with many empty custom folders still advances.
      state = nextState;
    }

    return { refs: [], nextCursor: null, complete: true, estimate };
  }

  initialDeltaPath(folder, pageSize) {
    const query = new URLSearchParams({
      $select: 'id,parentFolderId,lastModifiedDateTime',
      $top: String(Math.min(pageSize, 250)),
    });
    return `${this.mailboxRoot()}/mailFolders/${encode(
      folder.id
    )}/messages/delta?${query.toString()}`;
  }

  async listIncrementalPage(cursor = null, { pageSize = 50 } = {}) {
    await this.ensureLocations();
    const state = safeCursor(cursor, { folderLinks: {} });
    const nextState = { folderLinks: { ...(state.folderLinks || {}) } };
    const refs = new Map();
    const removals = new Map();
    let reset = false;
    const folders = this.eligibleFolders();
    const perFolder = Math.max(1, Math.ceil(pageSize / folders.length));

    for (const folder of folders) {
      let pathOrUrl =
        nextState.folderLinks[folder.id] ||
        this.initialDeltaPath(folder, perFolder);
      let response;
      try {
        response = await this.http.request(pathOrUrl);
      } catch (error) {
        if (error.status !== 410) throw error;
        reset = true;
        pathOrUrl = this.initialDeltaPath(folder, perFolder);
        response = await this.http.request(pathOrUrl);
      }

      for (const message of response.value || []) {
        if (message['@removed']) {
          removals.set(message.id, {
            id: message.id,
            folderId: folder.id,
            reason: message['@removed'].reason || 'removed',
          });
        } else {
          refs.set(message.id, { id: message.id, folderId: folder.id });
          removals.delete(message.id);
        }
      }
      nextState.folderLinks[folder.id] =
        response['@odata.nextLink'] || response['@odata.deltaLink'];
      if (!nextState.folderLinks[folder.id]) {
        throw new Error(
          `Outlook delta response omitted a checkpoint for ${folder.id}`
        );
      }
    }

    return {
      refs: [...refs.values()],
      tombstones: [...removals.values()],
      nextCursor: JSON.stringify(nextState),
      complete: Object.values(nextState.folderLinks).every((link) =>
        String(link).includes('$deltatoken=')
      ),
      reset,
    };
  }

  async listAttachments(providerMessageId) {
    const query = new URLSearchParams({
      $select: 'id,name,contentType,size,isInline',
    });
    return this.paginated(
      `${this.mailboxRoot()}/messages/${encode(
        providerMessageId
      )}/attachments?${query.toString()}`
    );
  }

  async fetchBundle(ref) {
    await this.ensureLocations();
    const select = [
      'id',
      'conversationId',
      'internetMessageId',
      'subject',
      'sentDateTime',
      'receivedDateTime',
      'createdDateTime',
      'lastModifiedDateTime',
      'body',
      'bodyPreview',
      'from',
      'sender',
      'toRecipients',
      'ccRecipients',
      'bccRecipients',
      'replyTo',
      'importance',
      'isRead',
      'hasAttachments',
      'parentFolderId',
    ].join(',');
    const messagePath = `${this.mailboxRoot()}/messages/${encode(ref.id)}`;
    const message = await this.http.request(
      `${messagePath}?$select=${encodeURIComponent(select)}`
    );
    const folder = this.folders.get(message.parentFolderId);
    if (!folder || folder.excluded) {
      return { ineligible: true, providerMessageId: message.id };
    }

    const [rawContent, attachments] = await Promise.all([
      this.http.request(`${messagePath}/$value`, { responseType: 'buffer' }),
      message.hasAttachments ? this.listAttachments(message.id) : [],
    ]);
    const recipients = [];
    if (message.from) recipients.push(graphRecipient(message.from, 'from'));
    if (message.sender) {
      recipients.push(graphRecipient(message.sender, 'sender'));
    }
    for (const [field, type] of [
      ['toRecipients', 'to'],
      ['ccRecipients', 'cc'],
      ['bccRecipients', 'bcc'],
      ['replyTo', 'reply-to'],
    ]) {
      (message[field] || []).forEach((recipient, ordinal) =>
        recipients.push(graphRecipient(recipient, type, ordinal))
      );
    }
    const bodyType = String(message.body?.contentType || '').toLowerCase();
    const normalizedAttachments = attachments.map((attachment) => ({
      providerAttachmentId: attachment.id,
      fileName: attachment.name || '',
      mediaType: attachment.contentType || null,
      size: Number(attachment.size) || 0,
      contentId: attachment.contentId || null,
      isInline: Boolean(attachment.isInline),
      attachmentType:
        attachment['@odata.type'] || '#microsoft.graph.fileAttachment',
    }));

    return {
      rawContent,
      message: {
        providerMessageId: message.id,
        providerThreadId: message.conversationId || null,
        internetMessageId: message.internetMessageId || null,
        subject: message.subject || '',
        sentAt: normalizedDate(message.sentDateTime),
        receivedAt: normalizedDate(message.receivedDateTime),
        providerCreatedAt: normalizedDate(message.createdDateTime),
        providerModifiedAt: normalizedDate(message.lastModifiedDateTime),
        direction: this.folderKind(folder) === 'sent' ? 'outbound' : 'inbound',
        bodyText: bodyType === 'text' ? message.body?.content || '' : '',
        bodyHtml: bodyType === 'html' ? message.body?.content || '' : '',
        bodyContentType: bodyType || null,
        bodyPreview: message.bodyPreview || '',
        importance: message.importance || null,
        isRead: message.isRead,
        hasAttachments: normalizedAttachments.length > 0,
        rawMediaType: 'message/rfc822',
        recipients,
        locations: [
          {
            providerLocationId: folder.id,
            displayName: folder.displayName || '',
            kind: this.folderKind(folder),
          },
        ],
        attachments: normalizedAttachments,
        source: {
          id: message.id,
          conversationId: message.conversationId,
          internetMessageId: message.internetMessageId,
          parentFolderId: message.parentFolderId,
          createdDateTime: message.createdDateTime,
          lastModifiedDateTime: message.lastModifiedDateTime,
        },
      },
    };
  }

  async fetchAttachment(providerMessageId, attachment) {
    const path = `${this.mailboxRoot()}/messages/${encode(
      providerMessageId
    )}/attachments/${encode(attachment.providerAttachmentId)}`;
    if (attachment.attachmentType.includes('itemAttachment')) {
      return this.http.request(`${path}/$value`, { responseType: 'buffer' });
    }
    if (attachment.attachmentType.includes('referenceAttachment')) {
      throw new ProviderHttpError(
        'Outlook reference attachment has no downloadable source bytes',
        { code: 'REFERENCE_ATTACHMENT', retryable: false }
      );
    }
    const response = await this.http.request(path);
    if (!response.contentBytes) {
      throw new ProviderHttpError(
        'Outlook file attachment omitted content bytes',
        {
          code: 'MISSING_ATTACHMENT_BYTES',
          retryable: true,
        }
      );
    }
    return Buffer.from(response.contentBytes, 'base64');
  }

  async resolveRemoval(removal) {
    try {
      const bundle = await this.fetchBundle(removal);
      if (bundle.ineligible) return { tombstone: removal };
      return { bundle };
    } catch (error) {
      if (error.status === 404) return { tombstone: removal };
      throw error;
    }
  }

  async listInventoryPage(cursor = null, options = {}) {
    return this.listBackfillPage(cursor, options);
  }
}

module.exports = {
  EXCLUDED_NAMES,
  EXCLUDED_WELL_KNOWN,
  IMMUTABLE_HEADER,
  OutlookArchiveProvider,
  safeCursor,
};
