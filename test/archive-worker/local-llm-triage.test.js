const {
  classifyWithLocalLLM,
} = require('../../archive-worker/local-llm-triage');

const message = {
  accountId: 'vitasci-outlook',
  subject: 'VitaSci invoice',
  bodyText: '',
};

test('accepts valid local model JSON', async () => {
  const result = await classifyWithLocalLLM(message, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        message: {
          content: JSON.stringify({
            categories: ['financial'],
            destinations: ['financial-assistant'],
            confidence: 0.9,
            disposition: 'proposed',
            reason: 'invoice',
          }),
        },
      }),
    }),
  });
  expect(result.source).toBe('local-llm');
  expect(result.destinations).toEqual(['financial-assistant']);
});

test('falls back safely on malformed local model output', async () => {
  const result = await classifyWithLocalLLM(message, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ message: { content: 'not json' } }),
    }),
  });
  expect(result.source).toBe('deterministic-fallback');
});
