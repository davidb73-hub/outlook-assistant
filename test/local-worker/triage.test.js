const {
  normalizeModelOutput,
  runTriage,
} = require('../../local-worker/triage');
const {
  extractActiveEmails,
  normalizeOutlookEmail,
} = require('../../local-worker/providers/outlook');

describe('local-worker triage', () => {
  test('extractActiveEmails ignores deleted delta records', () => {
    const result = extractActiveEmails({
      _meta: {
        emails: [
          { id: 'msg-1', subject: 'Keep' },
          { id: 'msg-2', removed: true },
          { id: 'msg-3', '@removed': { reason: 'deleted' } },
        ],
      },
    });

    expect(result).toEqual([{ id: 'msg-1', subject: 'Keep' }]);
  });

  test('normalizeOutlookEmail keeps compact safe fields', () => {
    const result = normalizeOutlookEmail(
      {
        id: 'msg-1',
        subject: 'Contract',
        from: { emailAddress: { address: 'sender@example.com' } },
        bodyPreview: 'Please approve today.',
        receivedDateTime: '2026-07-17T00:00:00Z',
        isRead: false,
        importance: 'high',
        hasAttachments: true,
      },
      { id: 'outlook', label: 'Outlook' }
    );

    expect(result).toEqual({
      messageId: 'outlook:msg-1',
      providerId: 'outlook',
      providerLabel: 'Outlook',
      providerMessageId: 'msg-1',
      subject: 'Contract',
      from: 'sender@example.com',
      bodyPreview: 'Please approve today.',
      receivedDateTime: '2026-07-17T00:00:00Z',
      isRead: false,
      importance: 'high',
      hasAttachments: true,
    });
  });

  test('normalizeModelOutput validates enums and ignores unknown message ids', () => {
    const result = normalizeModelOutput(
      {
        emails: [
          {
            messageId: 'msg-1',
            priority: 'urgent',
            reason: 'Deadline',
            suggestedAction: 'Reply today',
            confidence: 'high',
          },
          {
            messageId: 'msg-2',
            priority: 'bad-value',
            reason: 'Unknown',
            suggestedAction: 'Review',
            confidence: 'bad-confidence',
          },
          {
            messageId: 'ignored',
            priority: 'urgent',
          },
        ],
      },
      ['msg-1', 'msg-2']
    );

    expect(result).toEqual([
      {
        messageId: 'msg-1',
        priority: 'urgent',
        reason: 'Deadline',
        suggestedAction: 'Reply today',
        confidence: 'high',
      },
      {
        messageId: 'msg-2',
        priority: 'fyi',
        reason: 'Unknown',
        suggestedAction: 'Review',
        confidence: 'low',
      },
    ]);
  });

  test('runTriage fetches provider messages and stores per-provider state', async () => {
    const provider = {
      id: 'outlook',
      fetchMessages: jest.fn().mockResolvedValue({
        providerId: 'outlook',
        providerLabel: 'Outlook',
        messages: [
          {
            messageId: 'outlook:msg-1',
            providerId: 'outlook',
            providerLabel: 'Outlook',
            providerMessageId: 'msg-1',
            subject: 'Approval needed',
            from: 'sender@example.com',
            content: 'Full email content',
          },
        ],
        nextState: { deltaToken: 'next-token' },
        meta: { tokenType: 'delta', itemCount: 1 },
      }),
    };
    const ollamaClient = {
      generateJson: jest.fn().mockResolvedValue({
        model: 'mistral-small3.2:24b',
        raw: '{"emails":[]}',
        parsed: {
          emails: [
            {
              messageId: 'outlook:msg-1',
              priority: 'needs_reply',
              reason: 'Asks for approval',
              suggestedAction: 'Review and reply',
              confidence: 'high',
            },
          ],
        },
      }),
    };

    const result = await runTriage({
      providers: [provider],
      ollamaClient,
      state: {
        providers: { outlook: { deltaToken: 'old-token' } },
        processedMessageIds: [],
        runs: [],
      },
      now: new Date('2026-07-17T00:00:00Z'),
    });

    expect(provider.fetchMessages).toHaveBeenCalledWith({
      deltaToken: 'old-token',
    });
    expect(result.classifications).toHaveLength(1);
    expect(result.nextState.providers.outlook.deltaToken).toBe('next-token');
    expect(result.nextState.processedMessageIds).toEqual(['outlook:msg-1']);
  });
});
