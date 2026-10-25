'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const vision = require('../services/vision');
const { computeVisionCost } = require('../services/costs');
const { SchemaValidationError, BudgetExceededError, ProviderError } = require('../services/errors');

// Fake db: records every cost row, reports a controllable total spend.
function makeDb({ spent = 0 } = {}) {
  const recorded = [];
  return {
    recorded,
    spent,
    async query(sql, params) {
      if (sql.includes('SUM(usd)')) return { rows: [{ spent: String(this.spent) }] };
      if (sql.startsWith('INSERT INTO costs')) {
        const row = paramsToObject(sql, params);
        recorded.push(row);
        return { rows: [{ id: 'cost-' + recorded.length, usd: row.usd }] };
      }
      return { rows: [] };
    },
  };
}

function paramsToObject(sql, params) {
  // Map the cost insert's positional params back to the columns we care about.
  const cols = ['kind', 'model', 'provider', 'image_id', 'post_id', 'tokens_in', 'tokens_out', 'tokens_thinking', 'usd', 'latency_ms', 'success', 'error'];
  const obj = {};
  cols.forEach((c, i) => (obj[c] = params[i]));
  return obj;
}

function mockFetch(payload, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  });
}

function visionPayload(obj, usage) {
  return {
    candidates: [{ content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] } }],
    usageMetadata: usage || { promptTokenCount: 250, candidatesTokenCount: 70, thoughtsTokenCount: 30 },
  };
}

const VALID = {
  subjects: ['red fox'],
  category: 'Animal',
  attributes: ['orange fur', 'forest'],
  caption: 'A red fox stands at the edge of a forest',
  confidence: 0.93,
};

const BASE_CFG = {
  geminiBaseUrl: 'https://example.invalid/v1beta',
  geminiApiKey: 'SECRET-KEY-DO-NOT-LEAK',
  visionModel: 'gemini-2.5-flash',
  visionPriceInPerM: 0.3,
  visionPriceOutPerM: 2.5,
  costBudgetUsd: 1000,
  maxImageTokens: 20000,
  requestTimeoutMs: 5000,
  retryBaseDelayMs: 1,
  ingestRetryMax: 3,
};

test('valid vision output passes and normalizes group', async () => {
  const db = makeDb();
  const res = await vision.classifyImage(Buffer.from('x'), {
    db,
    cfg: BASE_CFG,
    fetchImpl: mockFetch(visionPayload(VALID)),
  });
  assert.equal(res.vision.group, 'fox');
  assert.equal(res.vision.category, 'animal'); // lowercased by schema
  assert.equal(res.vision.subject, 'red fox');
  assert.equal(res.usd > 0, true);
  assert.equal(db.recorded.length, 1);
  assert.equal(db.recorded[0].success, true);
});

test('cost includes thinking tokens (billed at output rate)', async () => {
  const cost = computeVisionCost(
    { promptTokenCount: 1000000, candidatesTokenCount: 1000000, thoughtsTokenCount: 1000000 },
    { priceInPerM: 0.3, priceOutPerM: 2.5 }
  );
  // 1M in = 0.30; (1M + 1M thinking) out = 2 * 2.50 = 5.00 -> total 5.30
  assert.ok(Math.abs(cost.usd - 5.3) < 1e-9);
  assert.equal(cost.tokens_thinking, 1000000);
});

test('malformed JSON fails validation after retries', async () => {
  const db = makeDb();
  const res = await vision
    .classifyImage(Buffer.from('x'), {
      db,
      cfg: BASE_CFG,
      fetchImpl: mockFetch(visionPayload('this is not json at all')),
    })
    .catch((e) => e);
  assert.ok(res instanceof SchemaValidationError);
  // Every failed attempt still recorded its real (spent) usage.
  assert.equal(db.recorded.length, BASE_CFG.ingestRetryMax);
});

test('missing required field rejected', async () => {
  const db = makeDb();
  const bad = { ...VALID };
  delete bad.caption;
  const res = await vision
    .classifyImage(Buffer.from('x'), { db, cfg: BASE_CFG, fetchImpl: mockFetch(visionPayload(bad)) })
    .catch((e) => e);
  assert.ok(res instanceof SchemaValidationError);
});

test('confidence out of range rejected', async () => {
  const db = makeDb();
  const res = await vision
    .classifyImage(Buffer.from('x'), {
      db,
      cfg: BASE_CFG,
      fetchImpl: mockFetch(visionPayload({ ...VALID, confidence: 1.7 })),
    })
    .catch((e) => e);
  assert.ok(res instanceof SchemaValidationError);
});

test('provider HTTP error does not leak the API key', async () => {
  const db = makeDb();
  // 400 = permanent -> no retry, throws ProviderError whose message is sanitized.
  const errRes = { error: { message: `bad request involving key ${BASE_CFG.geminiApiKey}` } };
  const res = await vision
    .classifyImage(Buffer.from('x'), { db, cfg: BASE_CFG, fetchImpl: mockFetch(errRes, { ok: false, status: 400 }) })
    .catch((e) => e);
  assert.ok(res instanceof ProviderError);
  assert.equal(res.retryable, false);
  assert.ok(!res.message.includes('SECRET-KEY-DO-NOT-LEAK'), 'message must not contain the key');
  assert.match(res.message, /REDACTED/);
});

test('budget guard stops before sending the request', async () => {
  // spent already over budget -> classify must throw WITHOUT calling fetch.
  const db = makeDb({ spent: 999 });
  let fetchCalled = false;
  const fetchImpl = async () => {
    fetchCalled = true;
    return mockFetch(visionPayload(VALID))();
  };
  const cfg = { ...BASE_CFG, costBudgetUsd: 1.0 };
  const res = await vision.classifyImage(Buffer.from('x'), { db, cfg, fetchImpl }).catch((e) => e);
  assert.ok(res instanceof BudgetExceededError);
  assert.equal(fetchCalled, false, 'no request should leave the process once over budget');
});

test('retryable 429 is retried and then succeeds', async () => {
  const db = makeDb();
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) return mockFetch({ error: { message: 'rate limited' } }, { ok: false, status: 429 })();
    return mockFetch(visionPayload(VALID))();
  };
  const res = await vision.classifyImage(Buffer.from('x'), { db, cfg: BASE_CFG, fetchImpl });
  assert.equal(res.vision.group, 'fox');
  assert.equal(n, 2);
});
