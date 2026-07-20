class ProviderHttpError extends Error {
  constructor(message, { status = null, code = null, retryable = false } = {}) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function retryDelay(response, attempt) {
  const retryAfter = Number.parseInt(response.headers.get('retry-after'), 10);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1000, 60_000);
  }
  return Math.min(500 * 2 ** attempt, 30_000);
}

function safeErrorCode(body) {
  if (!body || typeof body !== 'object') return null;
  return body.error?.code || body.error || body.code || null;
}

class ProviderHttpClient {
  constructor({
    baseUrl,
    getAccessToken,
    fetchImpl = globalThis.fetch,
    sleep = (milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }),
    maxRetries = 4,
    requestTimeoutMs = 5 * 60 * 1000,
    defaultHeaders = {},
  }) {
    this.baseUrl = new URL(baseUrl);
    this.getAccessToken = getAccessToken;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.maxRetries = maxRetries;
    this.requestTimeoutMs = Math.max(1, Number(requestTimeoutMs) || 1);
    this.defaultHeaders = defaultHeaders;
  }

  resolveUrl(pathOrUrl) {
    const url = new URL(pathOrUrl, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw new Error(
        `Refusing provider pagination URL outside ${this.baseUrl.origin}`
      );
    }
    return url;
  }

  async request(pathOrUrl, { responseType = 'json', headers = {} } = {}) {
    const url = this.resolveUrl(pathOrUrl);
    let forceRefresh = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const accessToken = await this.getAccessToken(forceRefresh);
      forceRefresh = false;
      let response;
      let body = null;
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.requestTimeoutMs
      );
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${accessToken}`,
            ...this.defaultHeaders,
            ...headers,
          },
        });
        if (response.ok) {
          if (responseType === 'buffer') {
            return Buffer.from(await response.arrayBuffer());
          }
          if (responseType === 'text') return response.text();
          if (response.status === 204) return null;
          return response.json();
        }
        try {
          body = await response.json();
        } catch {
          // Provider bodies are deliberately omitted from routine errors.
        }
      } catch (error) {
        if (attempt >= this.maxRetries) {
          throw new ProviderHttpError(
            `Provider network request failed after ${attempt + 1} attempts`,
            {
              code: controller.signal.aborted
                ? 'REQUEST_TIMEOUT'
                : error.code || 'NETWORK_ERROR',
              retryable: true,
            }
          );
        }
        await this.sleep(Math.min(500 * 2 ** attempt, 30_000));
        continue;
      } finally {
        clearTimeout(timeout);
      }

      if (response.status === 401 && attempt === 0) {
        forceRefresh = true;
        continue;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(retryDelay(response, attempt));
        continue;
      }
      throw new ProviderHttpError(
        `Provider request failed with HTTP ${response.status}`,
        {
          status: response.status,
          code: safeErrorCode(body),
          retryable,
        }
      );
    }

    throw new ProviderHttpError('Provider request exhausted retries', {
      retryable: true,
    });
  }
}

module.exports = {
  ProviderHttpClient,
  ProviderHttpError,
  retryDelay,
};
