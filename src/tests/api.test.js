'use strict';

// Offline API tests. A fake pool (no Postgres) backs a real Express app that we hit
// over HTTP on an ephemeral port with a mock fetch — so nothing here spends money or
// touches the network. Coverage: validation, invalid-UUID 400, unknown-id 404, review
// idempotency + 409 conflict, embedding cache reuse, health, JSON 404.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../app');
const { matchPostToImages } = require('../services/pipeline');

const UUID1 = '11111111-1111-1111-1111-111111111111';
const UUID2 = '22222222-2222-2222-2222-222222222222';
const UUID3 = '33333333-3333-3333-3333-333333333333';

function makeFakeDb() {
  const t = { posts: [], images: [], vectors: [], suggestions: [], reviews: [] };
  t.posts.push({ id: UUID1, slug: 'red-fox-behavior', title: 'Red Fox Behavior', body: 'x'.repeat(20), subject_hint: 'red fox', embedding: null, created_at: new Date() });
  t.images.push({ id: UUID2, filename: 'fox-1.jpg', sha256: 'aa', status: 'done', confidence: '0.9', vision: { subject: 'red fox', group: 'fox', category: 'animal', caption: 'A red fox', attributes: [], confidence: 0.9 } });
  t.vectors.push({ image_id: UUID2, embedding: new Array(8).fill(0.1) });

  let seq = 0;
  const id = () => `gen-${++seq}`;

  async function query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (/^SELECT 1/i.test(s)) return { rows: [{ ok: 1 }] };

    if (/FROM posts ORDER BY/i.test(s)) return { rows: t.posts.map((p) => ({ id: p.id, slug: p.slug, title: p.title, subject_hint: p.subject_hint, has_embedding: !!p.embedding })) };

    if (/INSERT INTO posts/i.test(s)) {
      const [slug, title, body, hint] = params;
      if (t.posts.some((p) => p.slug === slug)) return { rows: [] }; // ON CONFLICT DO NOTHING
      const row = { id: id(), slug, title, body, subject_hint: hint, created_at: new Date() };
      t.posts.push(row);
      return { rows: [row] };
    }

    if (/SELECT \* FROM posts WHERE id/i.test(s)) return { rows: t.posts.filter((p) => p.id === params[0]) };

    if (/SELECT \* FROM images WHERE id/i.test(s)) return { rows: t.images.filter((i) => i.id === params[0]) };
    if (/SELECT id FROM images WHERE id/i.test(s)) return { rows: t.images.filter((i) => i.id === params[0]).map((i) => ({ id: i.id })) };

    if (/FROM images i JOIN image_vectors/i.test(s)) {
      return {
        rows: t.images
          .filter((i) => t.vectors.some((v) => v.image_id === i.id))
          .map((i) => {
            const v = t.vectors.find((x) => x.image_id === i.id);
            return { id: i.id, filename: i.filename, status: i.status, confidence: i.confidence, vision: i.vision, embedding: v.embedding };
          }),
      };
    }
    if (/SELECT embedding FROM image_vectors WHERE image_id/i.test(s)) {
      const v = t.vectors.find((x) => x.image_id === params[0]);
      return { rows: v ? [{ embedding: v.embedding }] : [] };
    }

    if (/INSERT INTO suggestions/i.test(s)) {
      const [postId, imageId, rank, similarity, decision, reasons, confidence, source] = params;
      const existing = t.suggestions.find((x) => x.post_id === postId && x.image_id === imageId && x.source === source);
      if (existing) Object.assign(existing, { rank, similarity, guard_decision: decision, guard_reasons: reasons, vision_confidence: confidence });
      else t.suggestions.push({ id: id(), post_id: postId, image_id: imageId, rank, similarity, guard_decision: decision, guard_reasons: reasons, vision_confidence: confidence, source });
      return { rows: [{ id: existing ? existing.id : t.suggestions[t.suggestions.length - 1].id }] };
    }
    if (/FROM suggestions s JOIN posts/i.test(s)) {
      return { rows: t.suggestions.filter((x) => x.image_id === params[0]) };
    }
    if (/SELECT id FROM suggestions WHERE post_id/i.test(s)) {
      const found = t.suggestions.filter((x) => x.post_id === params[0] && x.image_id === params[1]);
      return { rows: found.map((f) => ({ id: f.id })) };
    }

    if (/SELECT id, action FROM reviews WHERE suggestion_id/i.test(s)) {
      return { rows: t.reviews.filter((r) => r.suggestion_id === params[0]).map((r) => ({ id: r.id, action: r.action })) };
    }
    if (/SELECT \* FROM reviews WHERE id/i.test(s)) return { rows: t.reviews.filter((r) => r.id === params[0]) };
    if (/SELECT \* FROM reviews WHERE suggestion_id/i.test(s)) return { rows: t.reviews.filter((r) => r.suggestion_id === params[0]) };
    if (/INSERT INTO reviews/i.test(s)) {
      const [suggestionId, action, note] = params;
      if (t.reviews.some((r) => r.suggestion_id === suggestionId)) return { rows: [] }; // ON CONFLICT DO NOTHING
      const row = { id: id(), suggestion_id: suggestionId, action, note, decided_at: new Date() };
      t.reviews.push(row);
      return { rows: [row] };
    }

    throw new Error('fake db: unhandled SQL -> ' + s.slice(0, 90));
  }
  return { query, tables: t };
}

let server;
let base;
let db;

before(async () => {
  db = makeFakeDb();
  // Provide a suggestion + vector for the pairing so review paths resolve.
  db.tables.suggestions.push({ id: 'sug-1', post_id: UUID1, image_id: UUID2, rank: 1, similarity: 0.9, guard_decision: 'suggested', guard_reasons: '[]', vision_confidence: 0.9, source: 'ranked' });
  const app = createApp({ db, cfg: { similarityThreshold: 0.5, confidenceThreshold: 0.7, guardConfidenceReject: 0.4, topK: 5 } });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => new Promise((r) => server.close(r)));

async function j(res) {
  return res.json();
}

test('GET /health reports ok with model names and no secrets', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await j(res);
  assert.equal(body.db, 'up');
  assert.ok(body.models.vision);
  assert.ok(!('geminiApiKey' in body) && !JSON.stringify(body).includes('key'));
});

test('invalid UUID on /images/:id returns 400 with a code', async () => {
  const res = await fetch(`${base}/images/not-a-uuid`);
  assert.equal(res.status, 400);
  const body = await j(res);
  assert.equal(body.error.code, 'INVALID_UUID');
});

test('unknown (valid-UUID) id returns 404', async () => {
  const res = await fetch(`${base}/posts/${UUID3}`);
  assert.equal(res.status, 404);
  const body = await j(res);
  assert.equal(body.error.code, 'POST_NOT_FOUND');
});

test('POST /posts with a bad body returns 400 with field details', async () => {
  const res = await fetch(`${base}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'NO_UPPER_ALLOWED', title: 'x', body: 'short' }),
  });
  assert.equal(res.status, 400);
  const body = await j(res);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(Array.isArray(body.error.details) && body.error.details.length > 0);
});

test('POST /posts creates a post, then a duplicate slug returns 409', async () => {
  const payload = { slug: 'wolf-pack-dynamics', title: 'Wolf Pack Dynamics', body: 'A longer body about wolves and their social structure.', subject_hint: 'gray wolf' };
  const first = await fetch(`${base}/posts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(first.status, 201);
  const second = await fetch(`${base}/posts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(second.status, 409);
  const body = await j(second);
  assert.equal(body.error.code, 'SLUG_EXISTS');
});

test('approve is idempotent for the same action, and a conflicting action returns 409', async () => {
  const url = `${base}/posts/${UUID1}/images/${UUID2}/approve`;
  const a = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(a.status, 201);
  const b = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(b.status, 200);
  assert.equal((await j(b)).idempotent, true);

  const conflict = await fetch(`${base}/posts/${UUID1}/images/${UUID2}/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(conflict.status, 409);
  assert.equal((await j(conflict)).error.code, 'REVIEW_CONFLICT');
});

test('unknown route returns a JSON 404 (never HTML)', async () => {
  const res = await fetch(`${base}/does-not-exist`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  assert.equal((await j(res)).error.code, 'NOT_FOUND');
});

test('pipeline reuses the cached post embedding and makes no provider call', async () => {
  const post = { id: UUID1, slug: 'red-fox-behavior', title: 'Red Fox', subject_hint: 'red fox', body: 'fox', embedding: new Array(8).fill(0.1) };
  // fetchImpl throws if ANY network call is attempted — proving the cache path was used.
  const explodingFetch = async () => {
    throw new Error('network should not be called when embeddings are cached');
  };
  const res = await matchPostToImages(db, post, { top: 5, persist: false, fetchImpl: explodingFetch, cfg: { similarityThreshold: 0.5, confidenceThreshold: 0.7, guardConfidenceReject: 0.4, topK: 5 } });
  assert.equal(res.embeddedFromCache, true);
  assert.ok(res.suggestions.length >= 1);
  assert.equal(res.suggestions[0].decision, 'suggested');
});
