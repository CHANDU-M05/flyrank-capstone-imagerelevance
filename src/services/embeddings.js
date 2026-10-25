'use strict';

// Embeddings service: text -> 768-dim vector via gemini-embedding-001, plus the
// Postgres-backed vector cache so a caption or post is only paid for once.
// Network + cost go through the same injectable fetch/db pattern as vision.js.

const config = require('../config');
const { callGemini } = require('./gemini');
const { computeEmbeddingCost, recordCost, totalSpent } = require('./costs');
const { ProviderError, BudgetExceededError } = require('./errors');

function buildBody(text, cfg) {
  return {
    model: `models/${cfg.embeddingModel}`,
    content: { parts: [{ text }] },
    taskType: 'SEMANTIC_SIMILARITY',
    outputDimensionality: cfg.embeddingDims,
  };
}

function extractVector(json) {
  const values = json?.embedding?.values;
  if (!Array.isArray(values)) throw new ProviderError('embedding missing values array', { retryable: true, kind: 'schema' });
  if (!values.every((v) => Number.isFinite(v))) throw new ProviderError('embedding contains non-finite values', { retryable: true, kind: 'schema' });
  return values;
}

function projectCost(cfg) {
  // Bound a single embed request at ~8k tokens for the pre-send guard.
  return (8000 / 1e6) * cfg.embeddingPricePerM;
}

// Low-level single embed call (records cost). Does NOT consult the cache.
async function embedText(text, opts = {}) {
  const cfg = { ...config, ...(opts.cfg || {}) };
  const db = opts.db;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;

  if (db) {
    const spent = await totalSpent(db);
    const projected = projectCost(cfg);
    if (spent + projected > cfg.costBudgetUsd) {
      throw new BudgetExceededError({ projected, spent, budget: cfg.costBudgetUsd });
    }
  }

  let json, latencyMs;
  try {
    ({ json, latencyMs } = await callGemini({
      baseUrl: cfg.geminiBaseUrl,
      apiKey: cfg.geminiApiKey,
      model: cfg.embeddingModel,
      method: 'embedContent',
      body: buildBody(text, cfg),
      timeoutMs: cfg.requestTimeoutMs,
      fetchImpl,
    }));
  } catch (err) {
    if (db && err instanceof ProviderError) {
      await recordCost(db, {
        kind: 'embedding', model: cfg.embeddingModel, image_id: opts.imageId, post_id: opts.postId,
        usd: 0, success: false, error: err.message,
      });
    }
    throw err;
  }

  const vector = extractVector(json);
  const tokenCount = json?.usageMetadata?.tokenCount ?? null;
  const cost = computeEmbeddingCost(tokenCount || 0, { pricePerM: cfg.embeddingPricePerM });
  if (db) {
    await recordCost(db, {
      kind: 'embedding', model: cfg.embeddingModel, image_id: opts.imageId, post_id: opts.postId,
      tokens_in: tokenCount, usd: cost.usd, latency_ms: latencyMs, success: true,
    });
  }
  return { vector, dims: vector.length, model: cfg.embeddingModel, usd: cost.usd, latencyMs };
}

// ---- Cache orchestration (uses the real db handle) ----

async function getImageVector(db, imageId) {
  const res = await db.query('SELECT embedding FROM image_vectors WHERE image_id = $1', [imageId]);
  return res.rows[0] ? res.rows[0].embedding : null;
}

// Embed an image's caption if not already cached; returns the numeric vector.
async function getOrCreateImageVector(db, image, opts = {}) {
  const cached = await getImageVector(db, image.id);
  if (Array.isArray(cached)) return { vector: cached, fromCache: true, usd: 0 };

  const text = image.vision?.caption || image.filename;
  const { vector, dims, model, usd } = await embedText(text, { db, imageId: image.id, ...opts });
  await db.query(
    `INSERT INTO image_vectors (image_id, embedding, dims, model)
     VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (image_id) DO UPDATE SET embedding = EXCLUDED.embedding, dims = EXCLUDED.dims, model = EXCLUDED.model, embedded_at = now()`,
    [image.id, JSON.stringify(vector), dims, model]
  );
  return { vector, fromCache: false, usd };
}

async function getOrCreatePostVector(db, post, opts = {}) {
  if (Array.isArray(post.embedding)) return { vector: post.embedding, fromCache: true, usd: 0 };

  const text = `${post.title}. ${post.subject_hint || ''} ${post.body}`.trim();
  const { vector, model, usd } = await embedText(text, { db, postId: post.id, ...opts });
  await db.query(
    `UPDATE posts SET embedding = $2::jsonb, embedded_at = now() WHERE id = $1`,
    [post.id, JSON.stringify(vector)]
  );
  return { vector, fromCache: false, model, usd };
}

module.exports = {
  embedText,
  getOrCreateImageVector,
  getOrCreatePostVector,
  getImageVector,
  buildBody,
  extractVector,
};
