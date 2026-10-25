'use strict';

// Failure / budget notifications. Best-effort and side-effect-safe: a notification
// that fails must never throw into the batch job or corrupt ingestion state.
//
// If NOTIFY_WEBHOOK_URL is configured we POST a small JSON payload there; otherwise
// we fall back to a sanitized console line. We never claim delivery we did not get —
// the return value reports the truth.

const config = require('../config');

// Strip anything that looks like a secret from a free-text message before sending.
function sanitize(text) {
  if (!text) return '';
  return String(text)
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]')
    .replace(/x-goog-api-key/gi, '[REDACTED-HEADER]')
    .slice(0, 500);
}

/**
 * @returns {Promise<{ delivered: boolean, channel: 'webhook'|'console', status?: number, error?: string }>}
 */
async function notify(message, { fetchImpl = globalThis.fetch, url = config.notifyWebhookUrl } = {}) {
  const payload = { text: sanitize(message), at: new Date().toISOString() };

  if (!url) {
    console.warn(`[notify:console] ${payload.text}`);
    return { delivered: true, channel: 'console' };
  }

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res && res.ok) {
      return { delivered: true, channel: 'webhook', status: res.status };
    }
    return { delivered: false, channel: 'webhook', status: res ? res.status : null };
  } catch (err) {
    // Never let a notification failure crash the caller.
    console.warn(`[notify] webhook delivery failed: ${sanitize(err.message)}`);
    return { delivered: false, channel: 'webhook', error: sanitize(err.message) };
  }
}

module.exports = { notify, sanitize };
