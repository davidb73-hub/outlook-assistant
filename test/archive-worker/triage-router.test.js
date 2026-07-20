const { classifyMessage } = require('../../archive-worker/triage-router');

test('routes a VitaSci invoice to multiple destinations', () => {
  const result = classifyMessage({
    accountId: 'vitasci-outlook',
    subject: 'VitaSci invoice and project update',
    bodyText: '',
    attachments: [{ fileName: 'invoice.pdf' }],
  });
  expect(result.destinations).toEqual([
    'financial-assistant',
    'vitasci-crm',
    'hannibal-briefs',
  ]);
  expect(result.disposition).toBe('proposed');
});

test('sends unmatched content to review without a destination', () => {
  const result = classifyMessage({
    accountId: 'gmail-personal',
    subject: 'Hello',
    bodyText: 'A message',
    attachments: [],
  });
  expect(result.destinations).toEqual([]);
  expect(result.disposition).toBe('review');
});
