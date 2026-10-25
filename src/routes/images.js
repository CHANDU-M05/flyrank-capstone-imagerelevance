'use strict';

const fs = require('fs');
const path = require('path');

const express = require('express');
const { asyncHandler } = require('../utils/async-handler');
const { assertUuid } = require('../utils/validators');
const { HttpError } = require('../utils/http-error');
const { parsePaging } = require('../middleware/validate');
const vision = require('../services/vision');

const router = express.Router();
const CORPUS_DIR = path.join(__dirname, '..', '..', 'corpus');

function getImageRow(db, id) {
  return db.query('SELECT * FROM images WHERE id = $1', [id]).then((r) => r.rows[0]);
}

// GET /images?status=&category=&limit=&offset= — bounded, filterable listing.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const { limit, offset } = parsePaging(req.query, { defaultLimit: 20, maxLimit: 100 });
    const where = [];
    const params = [];
    if (req.query.status) {
      params.push(req.query.status);
      where.push(`status = $${params.length}`);
    }
    if (req.query.category) {
      params.push(String(req.query.category).toLowerCase());
      where.push(`lower(vision->>'category') = $${params.length}`);
    }
    params.push(limit, offset);
    const sql = `
      SELECT id, filename, sha256, source_url, license, artist, status,
             vision->>'category' AS category, vision->>'subject' AS subject,
             confidence, model, error, created_at, processed_at
        FROM images
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY created_at ASC, filename ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const res2 = await db.query(sql, params);
    res.json({ count: res2.rows.length, limit, offset, images: res2.rows });
  })
);

// GET /images/:id — full vision data plus every suggestion that involves the image.
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    assertUuid(req.params.id, 'image id');
    const image = await getImageRow(db, req.params.id);
    if (!image) throw HttpError.notFound('Image not found', { code: 'IMAGE_NOT_FOUND' });
    const sugg = await db.query(
      `SELECT s.id, s.post_id, p.slug, p.title, s."rank", s.similarity,
              s.guard_decision, s.guard_reasons, s.vision_confidence, s.source
         FROM suggestions s
         JOIN posts p ON p.id = s.post_id
        WHERE s.image_id = $1
        ORDER BY s.source, s."rank" NULLS LAST`,
      [image.id]
    );
    res.json({ image, suggestions: sugg.rows });
  })
);

// POST /images/:id/reprocess — re-run vision on the stored file, record its real cost.
router.post(
  '/:id/reprocess',
  asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    assertUuid(req.params.id, 'image id');
    const image = await getImageRow(db, req.params.id);
    if (!image) throw HttpError.notFound('Image not found', { code: 'IMAGE_NOT_FOUND' });

    const filePath = path.join(CORPUS_DIR, path.basename(image.filename));
    if (!fs.existsSync(filePath)) {
      throw HttpError.notFound(`Image file missing from corpus: ${image.filename}`, { code: 'FILE_MISSING' });
    }
    const buffer = fs.readFileSync(filePath);

    await db.query(`UPDATE images SET status='processing' WHERE id=$1`, [image.id]);
    const { vision: v, usd } = await vision.classifyImage(buffer, { db, imageId: image.id });
    const isFlagged = Number(v.confidence) < req.app.locals.cfg.confidenceThreshold;
    const status = isFlagged ? 'flagged' : 'done';

    const updated = await db.query(
      `UPDATE images
          SET vision=$2::jsonb, confidence=$3, model=$4, status=$5, error=NULL, processed_at=now()
        WHERE id=$1
        RETURNING *`,
      [image.id, JSON.stringify(v), v.confidence, v.model, status]
    );
    res.json({ image: updated.rows[0], cost_usd: usd, reprocessed: true });
  })
);

module.exports = router;
