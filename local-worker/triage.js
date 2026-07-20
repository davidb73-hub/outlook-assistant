const { buildTriagePrompt } = require('./prompt');

const VALID_PRIORITIES = new Set([
  'urgent',
  'needs_reply',
  'waiting',
  'fyi',
  'noise',
]);
const VALID_CONFIDENCE = new Set(['low', 'medium', 'high']);

function normalizeModelOutput(parsed, expectedMessageIds) {
  if (!parsed || !Array.isArray(parsed.emails)) {
    throw new Error('Triage model response must include an emails array');
  }

  const expected = new Set(expectedMessageIds);
  return parsed.emails
    .filter((item) => item && expected.has(item.messageId))
    .map((item) => ({
      messageId: item.messageId,
      priority: VALID_PRIORITIES.has(item.priority) ? item.priority : 'fyi',
      reason: String(item.reason || '').slice(0, 500),
      suggestedAction: String(item.suggestedAction || '').slice(0, 500),
      confidence: VALID_CONFIDENCE.has(item.confidence)
        ? item.confidence
        : 'low',
    }));
}

async function runTriage({ providers, ollamaClient, state, now }) {
  const startedAt = now.toISOString();
  const providerState = state.providers || {};
  const providerResults = [];
  const nextProviders = { ...providerState };

  for (const provider of providers) {
    const result = await provider.fetchMessages(
      providerState[provider.id] || {}
    );
    providerResults.push(result);
    nextProviders[provider.id] = result.nextState;
  }

  const readable = providerResults.flatMap((result) => result.messages);

  let classifications = [];
  let modelName = null;
  let rawModelOutput = null;

  if (readable.length > 0) {
    const modelResult = await ollamaClient.generateJson(
      buildTriagePrompt(readable)
    );
    modelName = modelResult.model;
    rawModelOutput = modelResult.raw;
    classifications = normalizeModelOutput(
      modelResult.parsed,
      readable.map((email) => email.messageId)
    );
  }

  const nextState = {
    ...state,
    providers: nextProviders,
    deltaToken: nextProviders.outlook?.deltaToken || state.deltaToken || null,
    processedMessageIds: Array.from(
      new Set([
        ...(state.processedMessageIds || []),
        ...classifications.map((item) => item.messageId),
      ])
    ).slice(-1000),
    runs: [
      ...(state.runs || []),
      {
        startedAt,
        providers: providerResults.map((result) => result.providerId),
        itemCount: readable.length,
        classifiedCount: classifications.length,
        model: modelName,
      },
    ].slice(-100),
  };

  return {
    startedAt,
    providers: providerResults.map((result) => ({
      id: result.providerId,
      label: result.providerLabel,
      meta: result.meta,
    })),
    emails: readable,
    classifications,
    model: modelName,
    rawModelOutput,
    nextState,
  };
}

module.exports = {
  normalizeModelOutput,
  runTriage,
};
