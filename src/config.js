'use strict';

// Single place that reads and coerces environment configuration. Every other module
// imports from here rather than touching process.env directly, so defaults and type
// coercion live in one spot. Secrets are never logged from this module.
require('dotenv').config();

function num(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function str(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

const config = {
  port: num('PORT', 3000),
  env: str('NODE_ENV', 'development'),
  databaseUrl: str('DATABASE_URL', 'postgres://imgrel:imgrel@localhost:5434/imagerelevance'),

  geminiApiKey: str('GEMINI_API_KEY', ''),
  geminiBaseUrl: str('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta'),
  visionModel: str('GEMINI_VISION_MODEL', 'gemini-2.5-flash'),
  embeddingModel: str('GEMINI_EMBEDDING_MODEL', 'gemini-embedding-001'),
  embeddingDims: num('EMBEDDING_DIMENSIONS', 768),

  // Paid-tier per-1M-token USD rates (operator-configurable estimates).
  visionPriceInPerM: num('VISION_PRICING_USD_PER_M_INPUT', 0.3),
  visionPriceOutPerM: num('VISION_PRICING_USD_PER_M_OUTPUT', 2.5),
  embeddingPricePerM: num('EMBEDDING_PRICING_USD_PER_M', 0.15),
  costBudgetUsd: num('COST_BUDGET_USD', 1.0),
  maxImageTokens: num('MAX_IMAGE_TOKENS', 20000),

  similarityThreshold: num('SIMILARITY_THRESHOLD', 0.72),
  confidenceThreshold: num('CONFIDENCE_THRESHOLD', 0.7),
  guardConfidenceReject: num('GUARD_CONFIDENCE_REJECT', 0.4),
  topK: num('TOP_K', 8),

  ingestBatchSize: num('INGEST_BATCH_SIZE', 5),
  ingestRetryMax: num('INGEST_RETRY_MAX', 3),
  requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 60000),
  retryBaseDelayMs: num('RETRY_BASE_DELAY_MS', 1000),

  notifyWebhookUrl: str('NOTIFY_WEBHOOK_URL', ''),
};

module.exports = config;
