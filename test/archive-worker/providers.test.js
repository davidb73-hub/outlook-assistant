const {
  GmailArchiveProvider,
} = require('../../archive-worker/providers/gmail');
const {
  OutlookArchiveProvider,
  safeCursor,
} = require('../../archive-worker/providers/outlook');
const {
  ProviderHttpClient,
  ProviderHttpError,
} = require('../../archive-worker/providers/http-client');

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('provider HTTP safety and recovery', () => {
  test('refreshes once after 401 without exposing response content', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ private: 'do-not-log' }, 401))
      .mockResolvedValueOnce(jsonResponse({ value: 'ok' }));
    const getAccessToken = jest
      .fn()
      .mockResolvedValueOnce('expired')
      .mockResolvedValueOnce('fresh');
    const client = new ProviderHttpClient({
      baseUrl: 'https://provider.example/v1/',
      fetchImpl,
      getAccessToken,
      sleep: jest.fn(),
    });

    await expect(client.request('messages')).resolves.toEqual({ value: 'ok' });
    expect(getAccessToken).toHaveBeenNthCalledWith(1, false);
    expect(getAccessToken).toHaveBeenNthCalledWith(2, true);
  });

  test('backs off on throttling and rejects foreign pagination URLs', async () => {
    const sleep = jest.fn();
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(jsonResponse({ value: [] }));
    const client = new ProviderHttpClient({
      baseUrl: 'https://provider.example/v1/',
      fetchImpl,
      getAccessToken: jest.fn().mockResolvedValue('token'),
      sleep,
    });

    await client.request('messages');
    expect(sleep).toHaveBeenCalledWith(2000);
    await expect(
      client.request('https://attacker.example/steal')
    ).rejects.toThrow('outside https://provider.example');
  });

  test('supports bounded exponential backoff with jitter when retry-after is absent', async () => {
    const sleep = jest.fn();
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse({ value: [] }));
    const client = new ProviderHttpClient({
      baseUrl: 'https://provider.example/v1/',
      fetchImpl,
      getAccessToken: jest.fn().mockResolvedValue('token'),
      sleep,
      maxRetries: 2,
      retryBaseMs: 1000,
      maxRetryDelayMs: 64_000,
      retryJitterMs: 1000,
      random: () => 0.25,
    });

    await client.request('messages');
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([1250, 2250]);
  });

  test('aborts a stalled provider request with a retryable timeout', async () => {
    const fetchImpl = jest.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        })
    );
    const client = new ProviderHttpClient({
      baseUrl: 'https://provider.example/v1/',
      fetchImpl,
      getAccessToken: jest.fn().mockResolvedValue('token'),
      maxRetries: 0,
      requestTimeoutMs: 10,
    });

    await expect(client.request('messages')).rejects.toEqual(
      expect.objectContaining({
        code: 'REQUEST_TIMEOUT',
        retryable: true,
      })
    );
  });
});

describe('Gmail archive provider', () => {
  test('uses a Gmail-specific bounded exponential retry budget', () => {
    const provider = new GmailArchiveProvider({
      account: {
        id: 'gmail-ablative',
        provider: 'gmail',
        displayName: 'Ablative Gmail',
        expectedIdentity: 'ablative@example.test',
        accountKey: 'personal',
      },
      env: {},
      fetchImpl: jest.fn(),
    });

    expect(provider.http).toEqual(
      expect.objectContaining({
        maxRetries: 6,
        retryBaseMs: 1000,
        maxRetryDelayMs: 64_000,
        retryJitterMs: 1000,
      })
    );
  });

  test('proves the logical identity case-insensitively without exposing it', async () => {
    const provider = new GmailArchiveProvider({
      account: {
        id: 'gmail-personal',
        logicalAccountId: 'gmail-personal',
        provider: 'gmail',
        displayName: 'Personal Gmail',
        credentialSlot: 'ablative',
        expectedIdentity: 'personal@example.test',
      },
      tokenProvider: jest.fn().mockResolvedValue('fixture-access-token'),
      fetchImpl: jest
        .fn()
        .mockResolvedValue(
          jsonResponse({ emailAddress: 'PERSONAL@EXAMPLE.TEST' })
        ),
    });

    await expect(provider.auditIdentity()).resolves.toEqual(
      expect.objectContaining({
        logicalAccountId: 'gmail-personal',
        credentialSlot: 'ablative',
        expectedIdentityConfigured: true,
        identityMatch: true,
        errorCode: null,
      })
    );
    expect(Object.keys(await provider.auditIdentity()).sort()).toEqual(
      [
        'credentialSlot',
        'errorCode',
        'expectedIdentityConfigured',
        'identityMatch',
        'logicalAccountId',
        'verifiedAt',
      ].sort()
    );
  });

  test('fails closed before a provider request when logical identity is missing or wrong', async () => {
    const missingRequest = jest.fn();
    const missingToken = jest.fn().mockResolvedValue('fixture-access-token');
    const missing = new GmailArchiveProvider({
      account: {
        id: 'gmail-personal',
        provider: 'gmail',
        displayName: 'Personal Gmail',
        credentialSlot: 'ablative',
        expectedIdentity: '',
      },
      httpClient: { request: missingRequest },
      tokenProvider: missingToken,
    });
    await expect(missing.listRecent()).rejects.toEqual(
      expect.objectContaining({ code: 'GMAIL_IDENTITY_CONFIG_MISSING' })
    );
    expect(missingToken).not.toHaveBeenCalled();
    expect(missingRequest).not.toHaveBeenCalled();

    const wrongRequest = jest.fn();
    const wrong = new GmailArchiveProvider({
      account: {
        id: 'gmail-personal',
        provider: 'gmail',
        displayName: 'Personal Gmail',
        credentialSlot: 'ablative',
        expectedIdentity: 'expected@example.test',
      },
      httpClient: { request: wrongRequest },
      tokenProvider: jest.fn().mockResolvedValue('fixture-access-token'),
      fetchImpl: jest
        .fn()
        .mockResolvedValue(
          jsonResponse({ emailAddress: 'different@example.test' })
        ),
    });
    await expect(wrong.listRecent()).rejects.toEqual(
      expect.objectContaining({
        code: 'GMAIL_IDENTITY_MISMATCH',
        retryable: false,
      })
    );
    expect(wrongRequest).not.toHaveBeenCalled();
    const safe = await wrong.auditIdentity();
    expect(JSON.stringify(safe)).not.toContain('expected@example.test');
    expect(JSON.stringify(safe)).not.toContain('different@example.test');
  });

  test('reports provider profile failure with a safe code', async () => {
    const provider = new GmailArchiveProvider({
      account: {
        id: 'gmail-personal',
        provider: 'gmail',
        displayName: 'Personal Gmail',
        credentialSlot: 'ablative',
        expectedIdentity: 'personal@example.test',
      },
      tokenProvider: jest.fn().mockResolvedValue('fixture-access-token'),
      fetchImpl: jest.fn().mockResolvedValue(jsonResponse({}, 503)),
    });

    await expect(provider.auditIdentity()).resolves.toEqual(
      expect.objectContaining({
        identityMatch: false,
        errorCode: 'GMAIL_IDENTITY_PROFILE_FAILED',
      })
    );
  });

  test('does not replace a refreshed token after an identity mismatch', async () => {
    const provider = new GmailArchiveProvider({
      account: {
        id: 'gmail-personal',
        provider: 'gmail',
        displayName: 'Personal Gmail',
        credentialSlot: 'personal',
        expectedIdentity: 'personal@example.test',
      },
      env: {
        GMAIL_PERSONAL_CLIENT_ID: 'client',
        GMAIL_PERSONAL_CLIENT_SECRET: 'secret',
      },
      fetchImpl: jest
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            access_token: 'new-access-token',
            expires_in: 3600,
            token_type: 'Bearer',
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({ emailAddress: 'different@example.test' })
        ),
    });
    provider.readToken = jest
      .fn()
      .mockResolvedValue({ refresh_token: 'refresh-token' });
    provider.writeToken = jest.fn();

    await expect(provider.getAccessToken(true)).rejects.toEqual(
      expect.objectContaining({ code: 'GMAIL_IDENTITY_MISMATCH' })
    );
    expect(provider.writeToken).not.toHaveBeenCalled();
  });

  test('refreshes a cached token once after profile 401 and proves it before saving', async () => {
    const provider = new GmailArchiveProvider({
      account: {
        id: 'gmail-personal',
        provider: 'gmail',
        displayName: 'Personal Gmail',
        credentialSlot: 'personal',
        expectedIdentity: 'personal@example.test',
      },
      env: {
        GMAIL_PERSONAL_CLIENT_ID: 'client',
        GMAIL_PERSONAL_CLIENT_SECRET: 'secret',
      },
      fetchImpl: jest
        .fn()
        .mockResolvedValueOnce(jsonResponse({}, 401))
        .mockResolvedValueOnce(
          jsonResponse({
            access_token: 'replacement-access-token',
            expires_in: 3600,
            token_type: 'Bearer',
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({ emailAddress: 'personal@example.test' })
        ),
    });
    provider.readToken = jest.fn().mockResolvedValue({
      access_token: 'stale-cached-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 60 * 60 * 1000,
    });
    provider.writeToken = jest.fn();

    await expect(provider.getAccessToken()).resolves.toBe(
      'replacement-access-token'
    );
    expect(provider.fetchImpl).toHaveBeenCalledTimes(3);
    expect(provider.writeToken).toHaveBeenCalledTimes(1);
  });

  test('bounds a hanging profile check and returns only a safe failure code', async () => {
    const provider = new GmailArchiveProvider({
      account: {
        id: 'gmail-personal',
        provider: 'gmail',
        displayName: 'Personal Gmail',
        credentialSlot: 'ablative',
        expectedIdentity: 'personal@example.test',
      },
      tokenProvider: jest.fn().mockResolvedValue('fixture-access-token'),
      profileTimeoutMs: 5,
      fetchImpl: jest.fn(
        (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              const error = new Error('private network detail');
              error.name = 'AbortError';
              reject(error);
            });
          })
      ),
    });

    await expect(provider.auditIdentity()).resolves.toEqual(
      expect.objectContaining({
        identityMatch: false,
        errorCode: 'GMAIL_IDENTITY_PROFILE_FAILED',
      })
    );
    expect(JSON.stringify(await provider.auditIdentity())).not.toContain(
      'private network detail'
    );
  });

  test('probes a credential slot in memory without requiring or persisting an expected identity', async () => {
    const provider = new GmailArchiveProvider({
      account: {
        id: 'gmail-commissioning',
        logicalAccountId: 'gmail-commissioning',
        provider: 'gmail',
        credentialSlot: 'personal',
        expectedIdentity: '',
      },
      env: {},
    });
    provider.readToken = jest.fn().mockResolvedValue({
      refresh_token: 'fixture-refresh-token',
      expires_at: 0,
    });
    provider.refreshTokenInMemory = jest.fn().mockResolvedValue({
      access_token: 'fixture-access-token',
      refresh_token: 'fixture-refresh-token',
      expires_at: Date.now() + 60 * 60 * 1000,
    });
    provider.fetchProfileIdentity = jest
      .fn()
      .mockResolvedValue('private@example.test');
    provider.writeToken = jest.fn();

    await expect(
      provider.probeIdentityCandidateForCommissioning()
    ).resolves.toEqual({
      credentialSlot: 'personal',
      identity: 'private@example.test',
      refreshedInMemory: true,
    });
    expect(provider.writeToken).not.toHaveBeenCalled();
  });

  test('records a safe actionable reason when Google rejects a refresh token', async () => {
    const provider = new GmailArchiveProvider({
      account: {
        id: 'gmail-personal',
        provider: 'gmail',
        displayName: 'Personal Gmail',
        expectedIdentity: 'personal@example.test',
        accountKey: 'personal',
      },
      env: {
        GMAIL_PERSONAL_CLIENT_ID: 'client',
        GMAIL_PERSONAL_CLIENT_SECRET: 'secret',
        GMAIL_PERSONAL_REFRESH_TOKEN: 'refresh',
      },
      fetchImpl: jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: jest.fn().mockResolvedValue({
          error: 'invalid_grant',
          error_description: 'private provider detail',
        }),
      }),
    });
    provider.readToken = jest.fn().mockResolvedValue({});

    await expect(provider.getAccessToken(true)).rejects.toEqual(
      expect.objectContaining({
        code: 'GMAIL_AUTH',
        message: expect.stringContaining('expired or was revoked'),
      })
    );
    await expect(provider.getAccessToken(true)).rejects.not.toThrow(
      'private provider detail'
    );
  });

  function providerWithHttp(request) {
    return new GmailArchiveProvider({
      account: {
        id: 'gmail-personal',
        provider: 'gmail',
        displayName: 'Personal Gmail',
        expectedIdentity: 'personal@example.test',
        accountKey: 'personal',
      },
      env: {},
      httpClient: { request },
      identityVerifier: jest.fn().mockResolvedValue(true),
      tokenProvider: jest.fn().mockResolvedValue('fixture-access-token'),
    });
  }

  test('preserves raw MIME, labels, body and attachment metadata', async () => {
    const rawBytes = Buffer.from('From: sender@example.test\r\n\r\nRaw body');
    const full = {
      id: 'gmail-1',
      threadId: 'thread-1',
      labelIds: ['INBOX', 'Label_1'],
      internalDate: '1784332800000',
      historyId: '44',
      snippet: 'Preview',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'Subject', value: 'Fixture subject' },
          { name: 'From', value: 'Sender <sender@example.test>' },
          { name: 'To', value: 'Owner <owner@example.test>' },
          { name: 'Message-ID', value: '<gmail-1@example.test>' },
        ],
        parts: [
          {
            mimeType: 'text/plain',
            body: { data: Buffer.from('Fixture body').toString('base64url') },
          },
          {
            mimeType: 'application/pdf',
            filename: 'invoice.pdf',
            body: { attachmentId: 'attachment-1', size: 7 },
          },
        ],
      },
    };
    const request = jest.fn(async (path) => {
      if (path.includes('format=full')) return full;
      if (path.includes('format=raw')) {
        return { id: full.id, raw: rawBytes.toString('base64url') };
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    const provider = providerWithHttp(request);
    provider.labels = new Map([
      ['INBOX', { id: 'INBOX', name: 'Inbox', type: 'system' }],
      ['Label_1', { id: 'Label_1', name: 'Clients', type: 'user' }],
    ]);

    const bundle = await provider.fetchBundle({ id: full.id });
    expect(bundle.rawContent).toEqual(rawBytes);
    expect(bundle.message).toEqual(
      expect.objectContaining({
        providerMessageId: 'gmail-1',
        subject: 'Fixture subject',
        bodyText: 'Fixture body',
        direction: 'inbound',
      })
    );
    expect(bundle.message.locations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ displayName: 'Clients', kind: 'custom' }),
      ])
    );
    expect(bundle.message.attachments[0]).toEqual(
      expect.objectContaining({
        providerAttachmentId: 'attachment-1',
        fileName: 'invoice.pdf',
      })
    );
  });

  test('archives a provider-declared empty attachment without an invalid download', async () => {
    const request = jest.fn();
    const provider = providerWithHttp(request);

    await expect(
      provider.fetchAttachment('message-1', {
        providerAttachmentId: 'empty-attachment',
        size: 0,
        inlineData: null,
      })
    ).resolves.toEqual(Buffer.alloc(0));
    expect(request).not.toHaveBeenCalled();
  });

  test('excludes draft, spam and trash states and safely resets expired history', async () => {
    const request = jest.fn(async (path) => {
      if (path.startsWith('users/me/history?')) {
        throw new ProviderHttpError('expired', { status: 404 });
      }
      if (path === 'users/me/profile') return { historyId: 'new-anchor' };
      if (path.startsWith('users/me/messages?')) {
        return { messages: [{ id: 'recent-1' }] };
      }
      if (path.includes('format=full')) {
        return {
          id: 'draft-1',
          labelIds: ['DRAFT'],
          payload: { headers: [] },
        };
      }
      if (path.includes('format=raw')) return { raw: '' };
      throw new Error(`Unexpected path: ${path}`);
    });
    const provider = providerWithHttp(request);
    provider.labels = new Map([['DRAFT', { id: 'DRAFT', name: 'Drafts' }]]);

    await expect(provider.fetchBundle({ id: 'draft-1' })).resolves.toEqual({
      ineligible: true,
      providerMessageId: 'draft-1',
    });
    await expect(
      provider.listIncrementalPage('expired-anchor')
    ).resolves.toEqual(
      expect.objectContaining({
        reset: true,
        nextCursor: 'new-anchor',
        refs: [{ id: 'recent-1' }],
      })
    );
  });

  test('preserves opaque Gmail page tokens inside a JSON checkpoint', async () => {
    const request = jest.fn(async () => ({
      history: [],
      historyId: 'history-2',
      nextPageToken: 'opaque:token/value',
    }));
    const provider = providerWithHttp(request);
    const page = await provider.listIncrementalPage('history-1');
    expect(JSON.parse(page.nextCursor)).toEqual({
      startHistoryId: 'history-1',
      pageToken: 'opaque:token/value',
    });

    await provider.listIncrementalPage(page.nextCursor);
    expect(request.mock.calls[1][0]).toContain(
      'pageToken=opaque%3Atoken%2Fvalue'
    );
  });
});

describe('Outlook archive provider', () => {
  test('proves delegated Graph identity case-insensitively without exposing it', async () => {
    const provider = new OutlookArchiveProvider({
      account: {
        id: 'vitasci-outlook',
        logicalAccountId: 'vitasci-outlook',
        provider: 'outlook',
        displayName: 'VitaSci Outlook',
        credentialSlot: 'default-delegated',
        expectedIdentity: 'owner@example.test',
      },
      tokenProvider: jest.fn().mockResolvedValue('fixture-access-token'),
      fetchImpl: jest.fn().mockResolvedValue(
        jsonResponse({
          mail: null,
          userPrincipalName: 'OWNER@EXAMPLE.TEST',
        })
      ),
    });

    const status = await provider.auditIdentity();
    expect(status).toEqual({
      logicalAccountId: 'vitasci-outlook',
      credentialSlot: 'default-delegated',
      expectedIdentityConfigured: true,
      identityMatch: true,
      verifiedAt: expect.any(String),
      errorCode: null,
    });
    expect(JSON.stringify(status)).not.toContain('owner@example.test');
  });

  test('fails closed before Outlook archive requests when identity is missing or wrong', async () => {
    const missingRequest = jest.fn();
    const missingToken = jest.fn().mockResolvedValue('fixture-access-token');
    const missing = new OutlookArchiveProvider({
      account: {
        id: 'vitasci-outlook',
        provider: 'outlook',
        displayName: 'VitaSci Outlook',
        expectedIdentity: '',
      },
      httpClient: { request: missingRequest },
      tokenProvider: missingToken,
    });
    await expect(missing.listRecent()).rejects.toEqual(
      expect.objectContaining({ code: 'OUTLOOK_IDENTITY_CONFIG_MISSING' })
    );
    expect(missingToken).not.toHaveBeenCalled();
    expect(missingRequest).not.toHaveBeenCalled();

    const wrongRequest = jest.fn();
    const wrong = new OutlookArchiveProvider({
      account: {
        id: 'vitasci-outlook',
        provider: 'outlook',
        displayName: 'VitaSci Outlook',
        expectedIdentity: 'expected@example.test',
      },
      httpClient: { request: wrongRequest },
      tokenProvider: jest.fn().mockResolvedValue('fixture-access-token'),
      fetchImpl: jest.fn().mockResolvedValue(
        jsonResponse({
          mail: 'different@example.test',
          userPrincipalName: 'different@example.test',
        })
      ),
    });
    await expect(wrong.listRecent()).rejects.toEqual(
      expect.objectContaining({
        code: 'OUTLOOK_IDENTITY_MISMATCH',
        retryable: false,
      })
    );
    expect(wrongRequest).not.toHaveBeenCalled();
    const safe = await wrong.auditIdentity();
    expect(JSON.stringify(safe)).not.toContain('expected@example.test');
    expect(JSON.stringify(safe)).not.toContain('different@example.test');
  });

  test('keeps identity-audit refresh in memory and persists only a proved runtime token', async () => {
    const provider = new OutlookArchiveProvider({
      account: {
        id: 'vitasci-outlook',
        provider: 'outlook',
        displayName: 'VitaSci Outlook',
        expectedIdentity: 'owner@example.test',
      },
      identityVerifier: jest.fn().mockResolvedValue(true),
    });
    provider.readDelegatedToken = jest.fn().mockResolvedValue({
      refresh_token: 'fixture-refresh-token',
      expires_at: 0,
    });
    provider.refreshDelegatedToken = jest.fn().mockResolvedValue({
      refresh_token: 'fixture-refresh-token',
      access_token: 'fixture-refreshed-access-token',
      expires_at: Date.now() + 60 * 60 * 1000,
    });
    provider.writeDelegatedToken = jest.fn();

    await expect(provider.auditIdentity()).resolves.toEqual(
      expect.objectContaining({ identityMatch: true, errorCode: null })
    );
    expect(provider.writeDelegatedToken).not.toHaveBeenCalled();

    await expect(provider.assertArchiveIdentity()).resolves.toEqual(
      expect.objectContaining({ identityMatch: true, errorCode: null })
    );
    expect(provider.writeDelegatedToken).toHaveBeenCalledTimes(1);
  });

  test('never persists a refreshed Outlook token whose Graph identity mismatches', async () => {
    const provider = new OutlookArchiveProvider({
      account: {
        id: 'vitasci-outlook',
        provider: 'outlook',
        displayName: 'VitaSci Outlook',
        expectedIdentity: 'owner@example.test',
      },
      identityVerifier: jest.fn().mockResolvedValue(false),
    });
    provider.readDelegatedToken = jest.fn().mockResolvedValue({
      refresh_token: 'fixture-refresh-token',
      expires_at: 0,
    });
    provider.refreshDelegatedToken = jest.fn().mockResolvedValue({
      refresh_token: 'fixture-refresh-token',
      access_token: 'wrong-refreshed-access-token',
      expires_at: Date.now() + 60 * 60 * 1000,
    });
    provider.writeDelegatedToken = jest.fn();

    await expect(provider.assertArchiveIdentity()).rejects.toEqual(
      expect.objectContaining({ code: 'OUTLOOK_IDENTITY_MISMATCH' })
    );
    expect(provider.writeDelegatedToken).not.toHaveBeenCalled();
  });

  test('skips consecutive empty folders during historical traversal', async () => {
    const request = jest.fn(async (path) => {
      if (path.includes('/mailFolders/empty/messages?')) return { value: [] };
      if (path.includes('/mailFolders/with-mail/messages?')) {
        return { value: [{ id: 'message-1' }] };
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    const provider = new OutlookArchiveProvider({
      account: {
        id: 'vitasci-outlook',
        provider: 'outlook',
        displayName: 'VitaSci Outlook',
        expectedIdentity: 'owner@example.test',
      },
      httpClient: { request },
      tokenProvider: jest.fn().mockResolvedValue('fixture-access-token'),
      identityVerifier: jest.fn().mockResolvedValue(true),
    });
    provider.folders = new Map([
      [
        'empty',
        {
          id: 'empty',
          displayName: 'Empty',
          excluded: false,
          totalItemCount: 0,
        },
      ],
      [
        'with-mail',
        {
          id: 'with-mail',
          displayName: 'With mail',
          excluded: false,
          totalItemCount: 1,
        },
      ],
    ]);

    await expect(provider.listBackfillPage()).resolves.toEqual({
      refs: [{ id: 'message-1', folderId: 'with-mail' }],
      nextCursor: null,
      complete: true,
      estimate: 1,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('normalizes immutable message data and preserves binary MIME', async () => {
    const rawBytes = Buffer.from([0x46, 0x72, 0x6f, 0x6d, 0x3a, 0xff]);
    const request = jest.fn(async (path, options = {}) => {
      if (path.includes('/attachments?')) {
        return {
          value: [
            {
              id: 'attachment-1',
              name: 'result.pdf',
              contentType: 'application/pdf',
              size: 4,
              isInline: false,
              '@odata.type': '#microsoft.graph.fileAttachment',
            },
          ],
        };
      }
      if (path.endsWith('/$value')) {
        expect(options.responseType).toBe('buffer');
        return rawBytes;
      }
      if (path.includes('/messages/message-1?')) {
        return {
          id: 'message-1',
          conversationId: 'conversation-1',
          internetMessageId: '<outlook-1@example.test>',
          subject: 'Outlook fixture',
          receivedDateTime: '2026-07-18T00:00:00Z',
          createdDateTime: '2026-07-18T00:00:00Z',
          lastModifiedDateTime: '2026-07-18T00:01:00Z',
          parentFolderId: 'inbox-id',
          body: { contentType: 'html', content: '<p>Body</p>' },
          bodyPreview: 'Body',
          from: {
            emailAddress: { address: 'sender@example.test', name: 'Sender' },
          },
          toRecipients: [
            {
              emailAddress: { address: 'owner@example.test', name: 'Owner' },
            },
          ],
          hasAttachments: true,
          isRead: false,
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    const provider = new OutlookArchiveProvider({
      account: {
        id: 'vitasci-outlook',
        provider: 'outlook',
        displayName: 'VitaSci Outlook',
        expectedIdentity: 'owner@example.test',
      },
      httpClient: { request },
      tokenProvider: jest.fn().mockResolvedValue('fixture-access-token'),
      identityVerifier: jest.fn().mockResolvedValue(true),
    });
    provider.folders = new Map([
      ['inbox-id', { id: 'inbox-id', displayName: 'Inbox', excluded: false }],
    ]);

    const bundle = await provider.fetchBundle({ id: 'message-1' });
    expect(bundle.rawContent).toEqual(rawBytes);
    expect(bundle.message).toEqual(
      expect.objectContaining({
        providerMessageId: 'message-1',
        subject: 'Outlook fixture',
        bodyHtml: '<p>Body</p>',
        direction: 'inbound',
      })
    );
    expect(bundle.message.attachments[0].attachmentType).toContain(
      'fileAttachment'
    );
  });

  test('fails loudly on malformed checkpoints', () => {
    expect(() => safeCursor('{broken')).toThrow('cursor is invalid');
  });
});
