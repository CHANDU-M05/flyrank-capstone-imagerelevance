'use strict';

// Vision service: sends one image to gemini-2.5-flash, forces JSON output, validates
// it with Zod before trusting anything, normalizes it into our canonical shape, and
// records the real per-call cost. All provider I/O sits behind an injectable fetch
// and db handle so tests never hit the network or spend money.

const { z } = require('zod');
const config = require('../config');
const { callGemini } = require('./gemini');
const { computeVisionCost, recordCost, totalSpent } = require('./costs');
const { ProviderError, SchemaValidationError, BudgetExceededError } = require('./errors');
const { resolveGroup } = require('./taxonomy');

// Our own schema — independent second check on top of the model's responseSchema.
const visionSchema = z.object({
  subjects: z.array(z.string().min(1)).min(1).max(5),
  category: z
    .string()
    .min(1)
    .transform((s) => s.toLowerCase()),
  attributes: z.array(z.string().min(1)).max(12).default([]),
  caption: z.string().min(3).max(400),
  confidence: z.number().min(0).max(1),
});

// The schema handed to Gemini to force structured output.
const geminiResponseSchema = {
  type: 'OBJECT',
  properties: {
    subjects: { type: 'ARRAY', items: { type: 'STRING' } },
    category: { type: 'STRING' },
    attributes: { type: 'ARRAY', items: { type: 'STRING' } },
    caption: { type: 'STRING' },
    confidence: { type: 'NUMBER' },
  },
  required: ['subjects', 'category', 'attributes', 'caption', 'confidence'],
};

const SYSTEM_PROMPT =
  'You are an image analyst for a content team. Identify the single most prominent ' +
  'subject. Return JSON only with: subjects (1-5 short noun phrases, most specific first, ' +
  'e.g. "red fox" not just "animal"), category (one of: animal, bird, plant, food, urban, ' +
  'vehicle, object, people, other), attributes (up to 8 short visual descriptors), caption ' +
  '(one factual sentence describing the image), confidence (0-1 self-assessment of how sure ' +
  'you are about the primary subject). Do not guess: if the subject is unclear, lower confidence.';

function buildBody(buffer, mimeType) {
  return {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: buffer.toString('base64') } },
          { text: 'Analyze this image and return the JSON object described.' },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: geminiResponseSchema,
      temperature: 0.2,
    },
  };
}

// Pull the JSON text out of a generateContent response.
function extractText(json) {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('');
}

// Re-derive the taxonomy group ourselves; never trust a model-provided group.
function normalize(parsed) {
  const primary = parsed.subjects[0];
  return {
    subject: primary,
    subjects: parsed.subjects,
    group: resolveGroup(primary), // null if not in our taxonomy map
    category: parsed.category,
    attributes: parsed.attributes,
    caption: parsed.caption,
    confidence: parsed.confidence,
  };
}

// Conservative projection for the pre-send budget guard: worst-case input tokens
// (a full image) plus a bounded output allowance.
function projectCost(cfg) {
  const inUsd = (cfg.maxImageTokens / 1e6) * cfg.visionPriceInPerM;
  const outUsd = (1000 / 1e6) * cfg.visionPriceOutPerM; // bounded output allowance
  return inUsd + outUsd;
}

/**
 * Classify a single image buffer.
 * @param {Buffer} buffer
 * @param {object} opts
 * @param {object} [opts.db]         pool-like ({query}) for cost logging + budget; defaults to real pool
 * @param {function} [opts.fetchImpl]
 * @param {object} [opts.cfg]        config overrides (for tests)
 * @param {string} [opts.mimeType]
 * @param {string} [opts.imageId]
 * @returns {Promise<{ vision: object, usage: object, usd: number, latencyMs: number }>}
 */
async function classifyImage(buffer, opts = {}) {
  const cfg = { ...config, ...(opts.cfg || {}) };
  const db = opts.db; // may be undefined for pure network-only tests
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const mimeType = opts.mimeType || 'image/jpeg';
  const retryMax = Math.max(1, cfg.ingestRetryMax);
  const body = buildBody(buffer, mimeType);

  for (let attempt = 1; attempt <= retryMax; attempt++) {
    // Pre-send budget guard: check BEFORE the request leaves the process.
    if (db) {
      const spent = await totalSpent(db);
      const projected = projectCost(cfg);
      if (spent + projected > cfg.costBudgetUsd) {
        throw new BudgetExceededError({ projected, spent, budget: cfg.costBudgetUsd });
      }
    }

    let json;
    let latencyMs;
    try {
      ({ json, latencyMs } = await callGemini({
        baseUrl: cfg.geminiBaseUrl,
        apiKey: cfg.geminiApiKey,
        model: cfg.visionModel,
        method: 'generateContent',
        body,
        timeoutMs: cfg.requestTimeoutMs,
        fetchImpl,
      }));
    } catch (err) {
      // Record the failed attempt (no fabricated tokens), then decide whether to retry.
      if (db && err instanceof ProviderError) {
        await recordCost(db, {
          kind: 'vision',
          model: cfg.visionModel,
          image_id: opts.imageId,
          usd: 0,
          success: false,
          error: err.message,
          latency_ms: null,
        });
        if (!err.retryable) throw err; // permanent HTTP error -> stop
      } else {
        throw err;
      }
      if (attempt < retryMax) {
        await sleep(cfg.retryBaseDelayMs * attempt);
        continue;
      }
      throw err;
    }

    // Success path: parse -> validate -> normalize.
    let rawText;
    try {
      rawText = extractText(json);
    } catch {
      rawText = '';
    }
    let parsed;
    try {
      const obj = JSON.parse(rawText);
      parsed = visionSchema.parse(obj);
    } catch (err) {
      const issues = err?.issues ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) : [String(err.message || err)];
      // Malformed/invalid output: record usage (it was spent) with a schema-failure flag,
      // then retry (re-asking the model can fix a bad sample) up to retryMax.
      const usage = json?.usageMetadata || {};
      const cost = computeVisionCost(usage, { priceInPerM: cfg.visionPriceInPerM, priceOutPerM: cfg.visionPriceOutPerM });
      if (db) {
        await recordCost(db, {
          kind: 'vision',
          model: cfg.visionModel,
          image_id: opts.imageId,
          ...cost,
          latency_ms: latencyMs,
          success: false,
          error: `schema invalid: ${issues.join('; ')}`.slice(0, 300),
        });
      }
      if (attempt < retryMax) {
        await sleep(cfg.retryBaseDelayMs * attempt);
        continue;
      }
      throw new SchemaValidationError('Vision output failed schema validation', issues);
    }

    const usage = json?.usageMetadata || {};
    const cost = computeVisionCost(usage, { priceInPerM: cfg.visionPriceInPerM, priceOutPerM: cfg.visionPriceOutPerM });
    if (db) {
      await recordCost(db, {
        kind: 'vision',
        model: cfg.visionModel,
        image_id: opts.imageId,
        ...cost,
        latency_ms: latencyMs,
        success: true,
      });
    }
    return {
      vision: { ...normalize(parsed), model: cfg.visionModel },
      usage,
      usd: cost.usd,
      latencyMs,
    };
  }
  // Unreachable, but satisfy static flow.
  throw new ProviderError('vision classification exhausted retries', { retryable: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { classifyImage, visionSchema, normalize, buildBody, extractText, projectCost };
