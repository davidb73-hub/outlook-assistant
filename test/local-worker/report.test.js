const {
  renderMarkdownReport,
  safeTimestamp,
} = require('../../local-worker/report');

describe('local-worker report', () => {
  test('safeTimestamp produces filesystem-friendly names', () => {
    expect(safeTimestamp(new Date('2026-07-17T01:02:03.456Z'))).toBe(
      '20260717T010203Z'
    );
  });

  test('renderMarkdownReport groups classifications by priority', () => {
    const markdown = renderMarkdownReport({
      startedAt: '2026-07-17T00:00:00Z',
      providers: [{ id: 'outlook', label: 'Outlook', meta: {} }],
      model: 'mistral-small3.2:24b',
      emails: [
        {
          messageId: 'outlook:msg-1',
          providerLabel: 'Outlook',
          subject: 'Contract approval',
          from: 'sender@example.com',
        },
      ],
      classifications: [
        {
          messageId: 'outlook:msg-1',
          priority: 'urgent',
          reason: 'Deadline today',
          suggestedAction: 'Review and reply',
          confidence: 'high',
        },
      ],
    });

    expect(markdown).toContain('# Local Inbox Triage Report');
    expect(markdown).toContain('## Urgent');
    expect(markdown).toContain('Contract approval');
    expect(markdown).toContain('Deadline today');
  });
});
