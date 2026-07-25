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

  function providerWithHttp(request) {
    return new GmailArchiveProvider({
      account: {
        id: 'gmail-personal',
        provider: 'gmail',
        displayName: 'Personal Gmail',
        accountKey: 'personal',
      },
      env: {},
      httpClient: { request },
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
      },
      httpClient: { request },
      tokenProvider: jest.fn(),
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
      },
      httpClient: { request },
      tokenProvider: jest.fn(),
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
