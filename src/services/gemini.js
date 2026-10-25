'use strict';

// Thin Gemini REST client. Wraps native fetch with an AbortController timeout and
// classifies failures into retryable (408/429/5xx/network) vs permanent (4xx).
// The API key is only ever placed in a header, never in a returned/Thrown message.
//
// `fetchImpl` and the config fields are injectable so unit tests never hit the
// network and never spend money.

const { ProviderError } = require('./errors');

function classifyStatus(status) {
  if (status === 408 || status === 425 || status === 429) return 'retryable';
  if (status >= 500 && status <= 599) return 'retryable';
  if (status >= 400 && status <= 499) return 'permanent';
  return 'unknown';
}

// Redact anything that could contain the key from a raw error string.
function sanitize(text, apiKey) {
  if (!text) return '';
  let out = String(text);
  if (apiKey) out = out.split(apiKey).join('[REDACTED]');
  return out.slice(0, 500);
}

/**
 * @returns {Promise<{ json: object, latencyMs: number }>}
 * @throws {ProviderError}
 */
async function callGemini({
  baseUrl,
  apiKey,
  model,
  method, // 'generateContent' | 'embedContent'
  body,
  timeoutMs = 60000,
  fetchImpl = globalThis.fetch,
}) {
  if (!apiKey) throw new ProviderError('GEMINI_API_KEY is not configured', { retryable: false });
  if (typeof fetchImpl !== 'function') throw new ProviderError('fetch is unavailable', { retryable: false });

  const url = `${baseUrl}/models/${model}:${method}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    // Network error / abort — treat as retryable transport failure.
    throw new ProviderError(`transport error: ${sanitize(err.message, apiKey)}`, {
      retryable: true,
      kind: 'transport',
    });
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - started;
  let json;
  const text = await res.text().catch(() => '');
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const kind = classifyStatus(res.status);
    const msg =
      (json && json.error && json.error.message && sanitize(json.error.message, apiKey)) ||
      `HTTP ${res.status}`;
    throw new ProviderError(`gemini ${method} failed: ${msg}`, {
      status: res.status,
      retryable: kind === 'retryable',
      kind: 'http',
    });
  }

  return { json, latencyMs };
}

module.exports = { callGemini, classifyStatus, sanitize };
