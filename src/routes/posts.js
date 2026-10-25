'use strict';

const express = require('express');
const { asyncHandler } = require('../utils/async-handler');
const { assertUuid, createPostSchema, reviewSchema } = require('../utils/validators');
const { validateBody, parsePaging } = require('../middleware/validate');
const { HttpError } = require('../utils/http-error');
const { matchPostToImages } = require('../services/pipeline');

const router = express.Router();

// GET /posts — list all seeded/created posts (embedding omitted for size).
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { limit, offset } = parsePaging(req.query, { defaultLimit: 50, maxLimit: 200 });
    const rows = await db.query(
      `SELECT id, slug, title, subject_hint, created_at,
              (embedding IS NOT NULL) AS has_embedding
         FROM posts ORDER BY created_at ASC, slug ASC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ count: rows.rows.length, limit, offset, posts: rows.rows });
  })
);

// POST /posts — create a post (Zod-validated). Idempotent on slug conflict -> 409.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const data = validateBody(createPostSchema, req.body);
    const inserted = await db.query(
      `INSERT INTO posts (slug, title, body, subject_hint)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO NOTHING
       RETURNING id, slug, title, body, subject_hint, created_at`,
      [data.slug, data.title, data.body, data.subject_hint || null]
    );
    if (!inserted.rows.length) {
      throw HttpError.conflict(`A post with slug "${data.slug}" already exists`, { code: 'SLUG_EXISTS' });
    }
    res.status(201).json({ post: inserted.rows[0] });
  })
);

async function getPost(db, id) {
  const r = await db.query('SELECT * FROM posts WHERE id = $1', [id]);
  return r.rows[0];
}

// GET /posts/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    assertUuid(req.params.id, 'post id');
    const post = await getPost(db, req.params.id);
    if (!post) throw HttpError.notFound('Post not found', { code: 'POST_NOT_FOUND' });
    res.json({ post });
  })
);

// GET /posts/:id/images?top=5&force_image_id=... — rank + guard, optionally force one.
router.get(
  '/:id/images',
  asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    assertUuid(req.params.id, 'post id');
    const post = await getPost(db, req.params.id);
    if (!post) throw HttpError.notFound('Post not found', { code: 'POST_NOT_FOUND' });

    let top = req.app.locals.cfg.topK;
    if (req.query.top !== undefined) {
      const n = Number(req.query.top);
      if (!Number.isFinite(n) || n < 1 || n > 50) {
        throw HttpError.badRequest('Invalid top: must be an integer 1..50', { code: 'INVALID_TOP' });
      }
      top = Math.floor(n);
    }

    let forceImageId = null;
    if (req.query.force_image_id) {
      assertUuid(req.query.force_image_id, 'force_image_id');
      forceImageId = req.query.force_image_id;
    }

    const result = await matchPostToImages(db, post, { top, forceImageId, cfg: req.app.locals.cfg });
    res.json(result);
  })
);

// Resolve the suggestion row a review targets: prefer 'forced' if it exists for the
// pairing, else the ranked one; else create a ranked suggestion from a fresh match.
async function resolveSuggestion(db, postId, imageId) {
  const found = await db.query(
    `SELECT id FROM suggestions WHERE post_id=$1 AND image_id=$2
      ORDER BY (source='forced') DESC, "rank" NULLS LAST LIMIT 1`,
    [postId, imageId]
  );
  if (found.rows.length) return found.rows[0].id;
  return null;
}

async function review(req, res, action) {
  const db = req.app.locals.db;
  assertUuid(req.params.id, 'post id');
  assertUuid(req.params.imageId, 'image id');
  const { note } = validateBody(reviewSchema, req.body);

  const post = await getPost(db, req.params.id);
  if (!post) throw HttpError.notFound('Post not found', { code: 'POST_NOT_FOUND' });
  const img = await db.query('SELECT id FROM images WHERE id=$1', [req.params.imageId]);
  if (!img.rows.length) throw HttpError.notFound('Image not found', { code: 'IMAGE_NOT_FOUND' });

  const suggestionId = await resolveSuggestion(db, post.id, req.params.imageId);
  if (!suggestionId) {
    throw HttpError.notFound('No suggestion exists for this post/image pairing', { code: 'NO_SUGGESTION' });
  }

  // Existing decision?
  const existing = await db.query('SELECT id, action FROM reviews WHERE suggestion_id=$1', [suggestionId]);
  if (existing.rows.length) {
    const prior = existing.rows[0];
    if (prior.action === action) {
      // Idempotent repeat of the SAME action.
      const row = await db.query('SELECT * FROM reviews WHERE id=$1', [prior.id]);
      res.json({ review: row.rows[0], idempotent: true });
      return;
    }
    throw HttpError.conflict(
      `This pairing was already ${prior.action}; reversing a review is not allowed`,
      { code: 'REVIEW_CONFLICT' }
    );
  }

  const inserted = await db.query(
    `INSERT INTO reviews (suggestion_id, action, note)
     VALUES ($1, $2, $3)
     ON CONFLICT (suggestion_id) DO NOTHING
     RETURNING *`,
    [suggestionId, action, note || null]
  );
  if (!inserted.rows.length) {
    // Lost a race with a concurrent identical insert: fetch and return it.
    const row = await db.query('SELECT * FROM reviews WHERE suggestion_id=$1', [suggestionId]);
    res.json({ review: row.rows[0], idempotent: true });
    return;
  }
  res.status(201).json({ review: inserted.rows[0], idempotent: false });
}

router.post('/:id/images/:imageId/approve', asyncHandler((req, res) => review(req, res, 'approved')));
router.post('/:id/images/:imageId/reject', asyncHandler((req, res) => review(req, res, 'rejected')));

module.exports = router;
