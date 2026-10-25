'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config');
const ingest = require('../jobs/ingest');

// ---- Minimal in-memory fake that understands the SQL the ingest job issues ----
function makeFakeDb() {
  const t = { images: [], jobs: [], jobItems: [], costs: [], vectors: [] };
  let seq = 0;
  const id = () => `id-${++seq}`;

  async function query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (/^INSERT INTO images/i.test(s)) {
      const [filename, sha, url, license, artist] = params;
      if (t.images.some((r) => r.sha256 === sha)) return { rows: [] }; // DO NOTHING
      const row = { id: id(), filename, sha256: sha, source_url: url, license, artist, status: 'pending', vision: null, confidence: null, model: null, error: null };
      t.images.push(row);
      return { rows: [row] };
    }
    if (/SELECT \* FROM images WHERE sha256/i.test(s)) {
      return { rows: t.images.filter((r) => r.sha256 === params[0]) };
    }
    if (/UPDATE images SET status='processing'/i.test(s)) {
      const row = t.images.find((r) => r.id === params[0]);
      if (row) row.status = 'processing';
      return { rows: [] };
    }
    if (/UPDATE images SET vision=/i.test(s)) {
      const row = t.images.find((r) => r.id === params[0]);
      if (row) { row.vision = JSON.parse(params[1]); row.confidence = params[2]; row.model = params[3]; row.status = params[4]; row.error = null; }
      return { rows: [] };
    }
    if (/UPDATE images SET status='failed'/i.test(s)) {
      const row = t.images.find((r) => r.id === params[0]);
      if (row) { row.status = 'failed'; row.error = params[1]; }
      return { rows: [] };
    }
    if (/UPDATE images SET status='pending'/i.test(s)) {
      const row = t.images.find((r) => r.id === params[0]);
      if (row) row.status = 'pending';
      return { rows: [] };
    }
    if (/^INSERT INTO jobs/i.test(s)) {
      const row = { id: id(), kind: 'ingest', status: 'running', total: 0, processed: 0, failed: 0, flagged: 0, budget_usd: params[0], cost_usd: 0 };
      t.jobs.push(row);
      return { rows: [row] };
    }
    if (/^INSERT INTO job_items/i.test(s)) {
      const [jobId, imageId, attempts, status, error] = params;
      const existing = t.jobItems.find((r) => r.job_id === jobId && r.image_id === imageId);
      if (existing) Object.assign(existing, { attempts, status, error });
      else t.jobItems.push({ job_id: jobId, image_id: imageId, attempts, status, error });
      return { rows: [] };
    }
    if (/^INSERT INTO image_vectors/i.test(s)) {
      const [imageId, embedding, dims, model] = params;
      const existing = t.vectors.find((r) => r.image_id === imageId);
      const rec = { image_id: imageId, embedding: JSON.parse(embedding), dims, model };
      if (existing) Object.assign(existing, rec);
      else t.vectors.push(rec);
      return { rows: [] };
    }
    if (/SELECT embedding FROM image_vectors/i.test(s)) {
      const v = t.vectors.find((r) => r.image_id === params[0]);
      return { rows: v ? [{ embedding: v.embedding }] : [] };
    }
    if (/^INSERT INTO costs/i.test(s)) {
      const row = { id: id(), usd: params[8] ?? 0, success: params[10], kind: params[0] };
      t.costs.push(row);
      return { rows: [{ id: row.id, usd: row.usd }] };
    }
    if (/SUM\(usd\).*FROM costs/i.test(s)) {
      const spent = t.costs.reduce((a, c) => a + Number(c.usd || 0), 0);
      return { rows: [{ spent: String(spent) }] };
    }
    if (/UPDATE jobs SET cost_usd=\$2, processed/i.test(s)) {
      const row = t.jobs.find((r) => r.id === params[0]);
      if (row) Object.assign(row, { cost_usd: params[1], processed: params[2], failed: params[3], flagged: params[4] });
      return { rows: [] };
    }
    if (/UPDATE jobs SET status=/i.test(s)) {
      const row = t.jobs.find((r) => r.id === params[0]);
      if (row) Object.assign(row, { status: params[1], total: params[2], processed: params[3], failed: params[4], flagged: params[5], cost_usd: params[6] });
      return { rows: [] };
    }
    throw new Error('fake db: unhandled SQL -> ' + s.slice(0, 80));
  }
  return { query, tables: t };
}

function makeMockFetch({ classifyCalls, embedCalls }) {
  return async (url) => {
    if (url.includes(':generateContent')) {
      classifyCalls.n++;
      const payload = {
        candidates: [{ content: { parts: [{ text: JSON.stringify({ subjects: ['red fox'], category: 'animal', attributes: ['orange fur'], caption: 'A red fox in the forest', confidence: 0.94 }) }] } }],
        usageMetadata: { promptTokenCount: 260, candidatesTokenCount: 60, thoughtsTokenCount: 200 },
      };
      return { ok: true, status: 200, async text() { return JSON.stringify(payload); } };
    }
    if (url.includes(':embedContent')) {
      embedCalls.n++;
      const payload = { embedding: { values: new Array(768).fill(0.01) }, usageMetadata: { tokenCount: 120 } };
      return { ok: true, status: 200, async text() { return JSON.stringify(payload); } };
    }
    throw new Error('unexpected url ' + url);
  };
}

function makeTempCorpus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-test-'));
  fs.writeFileSync(path.join(dir, 'fox-1.jpg'), Buffer.from('fake-jpeg-bytes'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify([{ filename: 'fox-1.jpg', source_url: 'https://example/1', license: 'CC0', artist: 'tester' }]));
  return dir;
}

const TEST_CFG = {
  ...config,
  geminiApiKey: 'test-key',
  costBudgetUsd: 5,
  ingestBatchSize: 5,
  ingestRetryMax: 2,
  retryBaseDelayMs: 1,
  confidenceThreshold: 0.7,
  visionPriceInPerM: 0.3,
  visionPriceOutPerM: 2.5,
  embeddingPricePerM: 0.15,
};

test('ingest processes a new image once (vision + embed) and marks it done', async () => {
  const db = makeFakeDb();
  const dir = makeTempCorpus();
  const classifyCalls = { n: 0 };
  const embedCalls = { n: 0 };
  const res = await ingest.run({ db, corpusDir: dir, cfg: TEST_CFG, log: () => {}, fetchImpl: makeMockFetch({ classifyCalls, embedCalls }) });

  assert.equal(res.counts.processed, 1);
  assert.equal(classifyCalls.n, 1);
  assert.equal(embedCalls.n, 1);
  assert.equal(db.tables.images[0].status, 'done');
  assert.equal(db.tables.images[0].vision.group, 'fox');
  assert.equal(db.tables.vectors.length, 1);
  assert.ok(res.counts.cost > 0);
});

test('running ingest twice is idempotent: no duplicate images, no repeated AI calls', async () => {
  const db = makeFakeDb();
  const dir = makeTempCorpus();
  const classifyCalls = { n: 0 };
  const embedCalls = { n: 0 };
  const fetchImpl = makeMockFetch({ classifyCalls, embedCalls });

  await ingest.run({ db, corpusDir: dir, cfg: TEST_CFG, log: () => {}, fetchImpl });
  const second = await ingest.run({ db, corpusDir: dir, cfg: TEST_CFG, log: () => {}, fetchImpl });

  assert.equal(db.tables.images.length, 1, 'no duplicate image rows for the same sha256');
  assert.equal(second.counts.processed, 0, 'second run skips already-done images');
  assert.equal(classifyCalls.n, 1, 'vision called exactly once across both runs');
  assert.equal(embedCalls.n, 1, 'embedding called exactly once across both runs');
});

test('a low-confidence image is flagged, not accepted', async () => {
  const db = makeFakeDb();
  const dir = makeTempCorpus();
  const calls = { n: 0 };
  const fetchImpl = async (url) => {
    if (url.includes(':generateContent')) {
      const payload = {
        candidates: [{ content: { parts: [{ text: JSON.stringify({ subjects: ['some animal'], category: 'animal', attributes: [], caption: 'Blurry animal shape', confidence: 0.3 }) }] } }],
        usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 40, thoughtsTokenCount: 100 },
      };
      return { ok: true, status: 200, async text() { return JSON.stringify(payload); } };
    }
    const payload = { embedding: { values: new Array(768).fill(0.01) }, usageMetadata: { tokenCount: 50 } };
    return { ok: true, status: 200, async text() { return JSON.stringify(payload); } };
  };
  const res = await ingest.run({ db, corpusDir: dir, cfg: TEST_CFG, log: () => {}, fetchImpl });
  assert.equal(db.tables.images[0].status, 'flagged');
  assert.equal(res.counts.flagged, 1);
});
