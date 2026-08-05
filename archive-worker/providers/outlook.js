const rootConfig = require('../../config');
const fs = require('fs/promises');
const path = require('path');
const { ProviderHttpClient, ProviderHttpError } = require('./http-client');
const { graphRecipient, normalizedDate } = require('./normalization');

const GRAPH_API = 'https://graph.microsoft.com/v1.0/';
const PROFILE_ENDPOINT = `${GRAPH_API}me?$select=mail,userPrincipalName`;
const PROFILE_TIMEOUT_MS = 10_000;
const OAUTH_RECOVERY_REASONS = {
  invalid_grant: 'the saved authorization expired or was revoked',
  invalid_client: 'the OAuth application credentials were rejected',
  unauthorized_client: 'the OAuth application is not authorised for this flow',
};
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
    identityVerifier = null,
    profileTimeoutMs = PROFILE_TIMEOUT_MS,
    persistTokenRefresh = true,
  }) {
    this.account = account;
    this.accountId = account.id;
    this.logicalAccountId = account.logicalAccountId || account.id;
    this.credentialSlot = account.credentialSlot || 'default-delegated';
    this.expectedIdentity = String(account.expectedIdentity || '')
      .trim()
      .toLowerCase();
    this.identityConfigurationError =
      account.identityConfigurationError ||
      (!this.expectedIdentity ? 'OUTLOOK_IDENTITY_CONFIG_MISSING' : null);
    this.folders = new Map();
    this.tokenProvider = tokenProvider;
    this.fetchImpl = fetchImpl;
    this.identityVerifier = identityVerifier;
    this.profileTimeoutMs = profileTimeoutMs;
    this.persistTokenRefresh = persistTokenRefresh;
    this.identityVerification = null;
    this.http =
      httpClient ||
      new ProviderHttpClient({
        baseUrl: GRAPH_API,
        getAccessToken: (forceRefresh) =>
          this.getAccessToken(forceRefresh, {
            forceIdentityCheck: forceRefresh,
          }),
        fetchImpl,
        defaultHeaders: IMMUTABLE_HEADER,
      });
  }

  identityError(code, { retryable = false, status = null } = {}) {
    return new ProviderHttpError(
      `Outlook identity verification failed for ${this.logicalAccountId} (${code})`,
      { status, code, retryable }
    );
  }

  assertIdentityConfiguration() {
    if (this.identityConfigurationError || !this.expectedIdentity) {
      throw this.identityError(
        this.identityConfigurationError || 'OUTLOOK_IDENTITY_CONFIG_MISSING'
      );
    }
    if (rootConfig.AUTH_CONFIG.defaultAuthMethod === 'client-credentials') {
      throw this.identityError('OUTLOOK_IDENTITY_UNSUPPORTED_AUTH_MODE');
    }
  }

  async verifyExpectedIdentity(accessToken, { force = false } = {}) {
    this.assertIdentityConfiguration();
    if (
      !force &&
      this.identityVerification?.identityMatch === true &&
      this.identityVerification.accessToken === accessToken
    ) {
      return this.identityVerification;
    }

    let identityMatch;
    if (this.identityVerifier) {
      const result = await this.identityVerifier({
        accessToken,
        credentialSlot: this.credentialSlot,
        expectedIdentity: this.expectedIdentity,
        logicalAccountId: this.logicalAccountId,
      });
      identityMatch =
        result === true || (result && result.identityMatch === true);
    } else {
      const candidates = await this.fetchProfileCandidates(accessToken);
      identityMatch = candidates.includes(this.expectedIdentity);
    }

    if (!identityMatch) {
      throw this.identityError('OUTLOOK_IDENTITY_MISMATCH');
    }
    this.identityVerification = {
      accessToken,
      logicalAccountId: this.logicalAccountId,
      credentialSlot: this.credentialSlot,
      expectedIdentityConfigured: true,
      identityMatch: true,
      verifiedAt: new Date().toISOString(),
    };
    return this.identityVerification;
  }

  async fetchProfileCandidates(accessToken) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.profileTimeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(PROFILE_ENDPOINT, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw this.identityError('OUTLOOK_IDENTITY_PROFILE_FAILED', {
          retryable: response.status >= 500,
          status: response.status,
        });
      }
      const profile = await response.json();
      return [profile?.mail, profile?.userPrincipalName]
        .map((value) =>
          String(value || '')
            .trim()
            .toLowerCase()
        )
        .filter(
          (value, index, values) =>
            Boolean(value) && values.indexOf(value) === index
        );
    } catch (error) {
      if (error instanceof ProviderHttpError) throw error;
      throw this.identityError('OUTLOOK_IDENTITY_PROFILE_FAILED', {
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async probeIdentityCandidatesForCommissioning() {
    if (rootConfig.AUTH_CONFIG.defaultAuthMethod === 'client-credentials') {
      throw this.identityError('OUTLOOK_IDENTITY_UNSUPPORTED_AUTH_MODE');
    }
    const token = await this.readDelegatedToken();
    let accessToken = token.access_token;
    let refreshedInMemory = false;
    if (!accessToken || Number(token.expires_at) <= Date.now() + 60_000) {
      const refreshed = await this.refreshDelegatedToken(token);
      accessToken = refreshed.access_token;
      refreshedInMemory = true;
    }
    try {
      const candidates = await this.fetchProfileCandidates(accessToken);
      return { candidates, refreshedInMemory };
    } catch (error) {
      if (refreshedInMemory || error?.status !== 401) throw error;
      const refreshed = await this.refreshDelegatedToken(token);
      return {
        candidates: await this.fetchProfileCandidates(refreshed.access_token),
        refreshedInMemory: true,
      };
    }
  }

  safeIdentityStatus(error = null) {
    return {
      logicalAccountId: this.logicalAccountId,
      credentialSlot: this.credentialSlot,
      expectedIdentityConfigured:
        Boolean(this.expectedIdentity) && !this.identityConfigurationError,
      identityMatch: this.identityVerification?.identityMatch === true,
      verifiedAt: this.identityVerification?.verifiedAt || null,
      errorCode:
        error?.code ||
        this.identityConfigurationError ||
        (this.identityVerification?.identityMatch
          ? null
          : 'OUTLOOK_IDENTITY_UNPROVED'),
    };
  }

  async auditIdentity() {
    try {
      await this.getAccessToken(false, {
        forceIdentityCheck: true,
        persist: false,
      });
      return this.safeIdentityStatus();
    } catch (error) {
      return this.safeIdentityStatus(error);
    }
  }

  async assertArchiveIdentity() {
    await this.getAccessToken(false, {
      forceIdentityCheck: true,
      persist: this.persistTokenRefresh,
    });
    return this.safeIdentityStatus();
  }

  async getAccessToken(
    forceRefresh = false,
    {
      forceIdentityCheck = forceRefresh,
      persist = this.persistTokenRefresh,
    } = {}
  ) {
    this.assertIdentityConfiguration();
    if (!this.tokenProvider) {
      return this.getDelegatedAccessToken(forceRefresh, {
        forceIdentityCheck,
        persist,
      });
    }
    let accessToken = await this.tokenProvider(forceRefresh);
    if (!accessToken) {
      throw new ProviderHttpError(
        `Outlook authentication is unavailable for ${this.logicalAccountId}; its archive checkpoint is unchanged.`,
        { code: 'OUTLOOK_AUTH', retryable: false }
      );
    }
    try {
      await this.verifyExpectedIdentity(accessToken, {
        force: forceIdentityCheck,
      });
      return accessToken;
    } catch (error) {
      if (forceRefresh || error?.status !== 401) throw error;
      accessToken = await this.tokenProvider(true);
      if (!accessToken) {
        throw new ProviderHttpError(
          `Outlook authentication is unavailable for ${this.logicalAccountId}; its archive checkpoint is unchanged.`,
          { code: 'OUTLOOK_AUTH', retryable: false }
        );
      }
      await this.verifyExpectedIdentity(accessToken, { force: true });
      return accessToken;
    }
  }

  async readDelegatedToken() {
    try {
      return JSON.parse(
        await fs.readFile(rootConfig.AUTH_CONFIG.tokenStorePath, 'utf8')
      );
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new ProviderHttpError(
        `Outlook authentication is unavailable for ${this.logicalAccountId}; its archive checkpoint is unchanged.`,
        { code: 'OUTLOOK_AUTH', retryable: false }
      );
    }
  }

  async writeDelegatedToken(token) {
    const tokenPath = rootConfig.AUTH_CONFIG.tokenStorePath;
    await fs.mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
    const temporary = `${tokenPath}.archive-tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(token, null, 2)}\n`, {
        mode: 0o600,
      });
      await fs.rename(temporary, tokenPath);
      await fs.chmod(tokenPath, 0o600);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async refreshDelegatedToken(token) {
    const refreshToken = token.refresh_token;
    if (!rootConfig.AUTH_CONFIG.clientId || !refreshToken) {
      throw new ProviderHttpError(
        `Outlook authentication is unavailable for ${this.logicalAccountId}; its archive checkpoint is unchanged.`,
        { code: 'OUTLOOK_AUTH', retryable: false }
      );
    }
    const body = {
      client_id: rootConfig.AUTH_CONFIG.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: rootConfig.AUTH_CONFIG.scopes.join(' '),
    };
    if (token.auth_method !== 'device-code') {
      if (!rootConfig.AUTH_CONFIG.clientSecret) {
        throw new ProviderHttpError(
          `Outlook authentication is unavailable for ${this.logicalAccountId}; its archive checkpoint is unchanged.`,
          { code: 'OUTLOOK_AUTH', retryable: false }
        );
      }
      body.client_secret = rootConfig.AUTH_CONFIG.clientSecret;
    }
    const response = await this.fetchImpl(
      rootConfig.AUTH_CONFIG.tokenEndpoint,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
      }
    );
    if (!response.ok) {
      let providerCode = null;
      try {
        const responseBody = await response.json();
        providerCode =
          typeof responseBody?.error === 'string'
            ? responseBody.error
            : responseBody?.error?.code || null;
      } catch {
        // Provider response bodies are deliberately absent from routine logs.
      }
      const reason =
        OAUTH_RECOVERY_REASONS[providerCode] ||
        'the provider rejected the saved authorization';
      throw new ProviderHttpError(
        `Outlook authentication refresh failed for ${this.logicalAccountId} because ${reason} (HTTP ${response.status}); its archive checkpoint is unchanged.`,
        { status: response.status, code: 'OUTLOOK_AUTH', retryable: false }
      );
    }
    const refreshed = await response.json();
    if (!refreshed?.access_token) {
      throw new ProviderHttpError(
        `Outlook authentication is unavailable for ${this.logicalAccountId}; its archive checkpoint is unchanged.`,
        { code: 'OUTLOOK_AUTH', retryable: false }
      );
    }
    return {
      ...token,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token || refreshToken,
      expires_in: Number(refreshed.expires_in || 3600),
      expires_at: Date.now() + Number(refreshed.expires_in || 3600) * 1000,
      scope: refreshed.scope || token.scope,
      token_type: refreshed.token_type || token.token_type,
    };
  }

  async getDelegatedAccessToken(
    forceRefresh = false,
    { forceIdentityCheck = forceRefresh, persist = true } = {}
  ) {
    const token = await this.readDelegatedToken();
    if (
      !forceRefresh &&
      token.access_token &&
      Number(token.expires_at) > Date.now() + 60_000
    ) {
      try {
        await this.verifyExpectedIdentity(token.access_token, {
          force: forceIdentityCheck,
        });
        return token.access_token;
      } catch (error) {
        if (error?.status !== 401) throw error;
      }
    }
    const next = await this.refreshDelegatedToken(token);
    // A refreshed credential is not adopted on disk until Graph /me proves it
    // belongs to the configured semantic archive account. Audit calls always
    // pass persist=false and therefore remain read-only even after refresh.
    await this.verifyExpectedIdentity(next.access_token, { force: true });
    if (persist) await this.writeDelegatedToken(next);
    return next.access_token;
  }

  async request(pathOrUrl, options = {}) {
    // Keep the guard at the provider boundary as well as the sync-engine
    // boundary. This protects alternate HTTP clients and future call sites.
    await this.getAccessToken(false);
    return this.http.request(pathOrUrl, options);
  }

  mailboxRoot() {
    if (rootConfig.AUTH_CONFIG.defaultAuthMethod !== 'client-credentials') {
      return 'me';
    }
    const target = rootConfig.CLIENT_CREDENTIALS_CONFIG.targetUser;
    if (!target) throw new Error('OUTLOOK_TARGET_USER is required');
    return `users/${encode(target)}`;
  }

  async paginated(pathOrUrl) {
    const values = [];
    let next = pathOrUrl;
    while (next) {
      const page = await this.request(next);
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
        const folder = await this.request(
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
      const response = await this.request(
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
      const response = await this.request(
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
        response = await this.request(pathOrUrl);
      } catch (error) {
        if (error.status !== 410) throw error;
        reset = true;
        pathOrUrl = this.initialDeltaPath(folder, perFolder);
        response = await this.request(pathOrUrl);
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
    const message = await this.request(
      `${messagePath}?$select=${encodeURIComponent(select)}`
    );
    const folder = this.folders.get(message.parentFolderId);
    if (!folder || folder.excluded) {
      return { ineligible: true, providerMessageId: message.id };
    }

    const [rawContent, attachments] = await Promise.all([
      this.request(`${messagePath}/$value`, { responseType: 'buffer' }),
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
    const attachmentPath = `${this.mailboxRoot()}/messages/${encode(
      providerMessageId
    )}/attachments/${encode(attachment.providerAttachmentId)}`;
    if (attachment.attachmentType.includes('itemAttachment')) {
      return this.request(`${attachmentPath}/$value`, {
        responseType: 'buffer',
      });
    }
    if (attachment.attachmentType.includes('referenceAttachment')) {
      throw new ProviderHttpError(
        'Outlook reference attachment has no downloadable source bytes',
        { code: 'REFERENCE_ATTACHMENT', retryable: false }
      );
    }
    const response = await this.request(attachmentPath);
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
  PROFILE_ENDPOINT,
  PROFILE_TIMEOUT_MS,
  safeCursor,
};
