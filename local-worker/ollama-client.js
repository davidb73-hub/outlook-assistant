class OllamaClient {
  constructor({ baseUrl, model, fallbackModel }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.fallbackModel = fallbackModel;
  }

  async generateJson(prompt) {
    try {
      return await this.generateJsonWithModel(this.model, prompt);
    } catch (primaryError) {
      if (!this.fallbackModel || this.fallbackModel === this.model) {
        throw primaryError;
      }
      return this.generateJsonWithModel(this.fallbackModel, prompt);
    }
  }

  async generateJsonWithModel(model, prompt) {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: 'json',
        options: {
          temperature: 0,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status}`);
    }

    const payload = await response.json();
    const text = payload.response || '';
    return {
      model,
      raw: text,
      parsed: parseJsonObject(text),
    };
  }
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error('Ollama response did not contain a JSON object', {
        cause: error,
      });
    }
    return JSON.parse(match[0]);
  }
}

module.exports = {
  OllamaClient,
  parseJsonObject,
};
