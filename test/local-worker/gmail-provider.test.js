const {
  decodeBase64Url,
  extractPlainText,
  normalizeGmailMessage,
} = require('../../local-worker/providers/gmail');

describe('local-worker Gmail provider', () => {
  test('decodeBase64Url decodes Gmail body data', () => {
    expect(decodeBase64Url('SGVsbG8td29ybGQ')).toBe('Hello-world');
  });

  test('extractPlainText finds nested text/plain body', () => {
    const text = Buffer.from('Plain content').toString('base64url');

    expect(
      extractPlainText({
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/html', body: { data: 'PGI-SFRNTDwvYj4' } },
          { mimeType: 'text/plain', body: { data: text } },
        ],
      })
    ).toBe('Plain content');
  });

  test('normalizeGmailMessage maps Gmail API message to provider email', () => {
    const text = Buffer.from('Email body').toString('base64url');
    const result = normalizeGmailMessage(
      {
        id: 'gmail-msg-1',
        labelIds: ['INBOX', 'UNREAD'],
        snippet: 'Preview',
        payload: {
          headers: [
            { name: 'Subject', value: 'Ablative update' },
            { name: 'From', value: 'sender@example.com' },
            { name: 'Date', value: 'Fri, 17 Jul 2026 10:00:00 +1000' },
          ],
          mimeType: 'text/plain',
          body: { data: text },
        },
      },
      { id: 'gmail-ablative', label: 'Ablative / Gmail' }
    );

    expect(result).toEqual({
      messageId: 'gmail-ablative:gmail-msg-1',
      providerId: 'gmail-ablative',
      providerLabel: 'Ablative / Gmail',
      providerMessageId: 'gmail-msg-1',
      subject: 'Ablative update',
      from: 'sender@example.com',
      receivedDateTime: 'Fri, 17 Jul 2026 10:00:00 +1000',
      bodyPreview: 'Preview',
      isRead: false,
      importance: null,
      hasAttachments: false,
      content: 'Email body',
    });
  });
});
