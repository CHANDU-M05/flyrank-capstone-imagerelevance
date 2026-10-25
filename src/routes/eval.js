'use strict';

const express = require('express');
const { asyncHandler } = require('../utils/async-handler');

const router = express.Router();

// GET /eval — the most recent actual evaluation run (never a synthetic placeholder).
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const r = await db.query('SELECT * FROM eval_results ORDER BY run_at DESC LIMIT 1');
    if (!r.rows.length) {
      res.json({ run: null, note: 'No evaluation has been run yet. Use: npm run eval' });
      return;
    }
    res.json({ run: r.rows[0] });
  })
);

module.exports = router;
