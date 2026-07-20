const { parseJsonObject } = require('../../local-worker/ollama-client');

describe('local-worker ollama-client', () => {
  test('parseJsonObject parses strict JSON', () => {
    expect(parseJsonObject('{"emails":[]}')).toEqual({ emails: [] });
  });

  test('parseJsonObject extracts JSON object from wrapped text', () => {
    expect(parseJsonObject('Here is the result:\n{"emails":[]}')).toEqual({
      emails: [],
    });
  });

  test('parseJsonObject throws when no JSON object is present', () => {
    expect(() => parseJsonObject('not json')).toThrow(
      'Ollama response did not contain a JSON object'
    );
  });
});
