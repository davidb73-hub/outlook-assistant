const { classifyMessage } = require('../../archive-worker/triage-router');

// Subject updated 2026-07-21. This previously read "VitaSci invoice and project
// update" and relied on the word "update" to produce a brief — the precise behaviour
// that routed six marketing emails into the business vault. The test's intent is that
// one message can reach several destinations, so the subject now carries a genuinely
// actionable term instead. See triage-precision.test.js for the regression cases.
test('routes a VitaSci invoice to multiple destinations', () => {
  const result = classifyMessage({
    accountId: 'vitasci-outlook',
    subject: 'VitaSci invoice — deadline for the signed contract',
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
