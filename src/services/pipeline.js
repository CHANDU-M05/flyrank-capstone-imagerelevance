'use strict';

// Shared matching pipeline, used by both the HTTP route and the eval script so the
// two never diverge. It embeds the post (cached), loads eligible image candidates,
// ranks by cosine similarity, runs EVERY candidate through the mismatch guard, and
// persists the verdicts as suggestions.
//
// A "forced" candidate (force_image_id) is pushed through the identical guard — it
// can never bypass it. This is what makes the wolf-on-a-fox-post rejection provable
// on demand instead of depending on ranking luck.

const config = require('../config');
const { rankImages } = require('./matching');
const guard = require('./guard');
const { getOrCreatePostVector, getOrCreateImageVector } = require('./embeddings');

// Load all images that have a stored vector and usable vision metadata.
async function loadImageCandidates(db) {
  const res = await db.query(
    `SELECT i.id, i.filename, i.status, i.confidence, i.vision, v.embedding
       FROM images i
       JOIN image_vectors v ON v.image_id = i.id
      WHERE i.vision IS NOT NULL`
  );
  return res.rows.map((r) => ({
    imageId: r.id,
    filename: r.filename,
    status: r.status,
    embedding: r.embedding,
    vision: r.vision,
    confidence: r.confidence == null ? null : Number(r.confidence),
  }));
}

async function upsertSuggestion(db, { postId, imageId, rank, similarity, verdict, confidence, source }) {
  const res = await db.query(
    `INSERT INTO suggestions
       (post_id, image_id, "rank", similarity, guard_decision, guard_reasons, vision_confidence, source)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
     ON CONFLICT (post_id, image_id, source) DO UPDATE SET
       "rank" = EXCLUDED."rank",
       similarity = EXCLUDED.similarity,
       guard_decision = EXCLUDED.guard_decision,
       guard_reasons = EXCLUDED.guard_reasons,
       vision_confidence = EXCLUDED.vision_confidence
     RETURNING id`,
    [postId, imageId, rank, similarity, verdict.decision, JSON.stringify(verdict.reasons), confidence, source]
  );
  return res.rows[0].id;
}

/**
 * @param {object} db
 * @param {object} post  row from posts (with embedding possibly null)
 * @param {object} [opts] { top, forceImageId, fetchImpl, cfg, persist }
 */
async function matchPostToImages(db, post, opts = {}) {
  const cfg = { ...config, ...(opts.cfg || {}) };
  const top = Number.isFinite(opts.top) ? opts.top : cfg.topK;
  const persist = opts.persist !== false;

  const { vector, fromCache } = await getOrCreatePostVector(db, post, { fetchImpl: opts.fetchImpl, cfg });
  const candidates = await loadImageCandidates(db);

  const ranked = rankImages(vector, candidates, top);

  const results = [];
  for (let i = 0; i < ranked.length; i++) {
    const c = ranked[i];
    const verdict = guard.evaluate({
      postSubject: post.subject_hint || post.title,
      candidateVision: c.vision,
      similarity: c.similarity,
      threshold: cfg.similarityThreshold,
      confidenceThreshold: cfg.confidenceThreshold,
      rejectConfidence: cfg.guardConfidenceReject,
    });
    if (persist) {
      await upsertSuggestion(db, {
        postId: post.id,
        imageId: c.imageId,
        rank: i + 1,
        similarity: Number.isFinite(c.similarity) ? c.similarity : null,
        verdict,
        confidence: c.confidence,
        source: 'ranked',
      });
    }
    results.push({
      imageId: c.imageId,
      filename: c.filename,
      rank: i + 1,
      similarity: Number.isFinite(c.similarity) ? Number(c.similarity.toFixed(4)) : null,
      decision: verdict.decision,
      reasons: verdict.reasons,
      visionConfidence: c.confidence,
      source: 'ranked',
    });
  }

  // Forced candidate: ensure it has a vector, compute its similarity to the post,
  // run it through the SAME guard, persist with source='forced', and prepend it.
  let forced = null;
  if (opts.forceImageId) {
    const imgRes = await db.query('SELECT id, filename, status, confidence, vision FROM images WHERE id = $1', [opts.forceImageId]);
    if (imgRes.rows.length === 0) {
      forced = { error: 'force_image_id not found' };
    } else {
      const img = imgRes.rows[0];
      // Make sure the forced image has an embedding even if not yet ranked.
      let emb = (await db.query('SELECT embedding FROM image_vectors WHERE image_id=$1', [img.id])).rows[0]?.embedding;
      if (!Array.isArray(emb)) {
        const created = await getOrCreateImageVector(db, { id: img.id, vision: img.vision, filename: img.filename }, { fetchImpl: opts.fetchImpl, cfg });
        emb = created.vector;
      }
      const { cosineSimilarity } = require('./matching');
      const sim = cosineSimilarity(vector, emb);
      const vision = img.vision || {};
      const verdict = guard.evaluate({
        postSubject: post.subject_hint || post.title,
        candidateVision: vision,
        similarity: sim,
        threshold: cfg.similarityThreshold,
        confidenceThreshold: cfg.confidenceThreshold,
        rejectConfidence: cfg.guardConfidenceReject,
      });
      if (persist) {
        await upsertSuggestion(db, {
          postId: post.id,
          imageId: img.id,
          rank: null,
          similarity: Number.isFinite(sim) ? sim : null,
          verdict,
          confidence: img.confidence == null ? null : Number(img.confidence),
          source: 'forced',
        });
      }
      forced = {
        imageId: img.id,
        filename: img.filename,
        rank: null,
        similarity: Number.isFinite(sim) ? Number(sim.toFixed(4)) : null,
        decision: verdict.decision,
        reasons: verdict.reasons,
        visionConfidence: img.confidence == null ? null : Number(img.confidence),
        source: 'forced',
      };
    }
  }

  const accepted = results.filter((r) => r.decision === 'suggested');
  const bestAccepted = accepted.length ? accepted[0] : null;
  const overall = bestAccepted
    ? { status: 'match', message: 'Recommended image available' }
    : { status: 'no_confident_match', message: 'No confident match: no candidate cleared the guard' };

  return {
    post: { id: post.id, slug: post.slug, title: post.title, subjectHint: post.subject_hint },
    thresholds: { similarity: cfg.similarityThreshold, confidence: cfg.confidenceThreshold, rejectConfidence: cfg.guardConfidenceReject, topK: top },
    embeddedFromCache: fromCache,
    candidateCount: candidates.length,
    overall,
    suggestions: results,
    forced,
  };
}

module.exports = { matchPostToImages, loadImageCandidates, upsertSuggestion };
