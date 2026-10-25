'use strict';

const express = require('express');
const { asyncHandler } = require('../utils/async-handler');

const router = express.Router();

// GET /jobs/status — latest ingest job plus its per-item progress counts.
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const jobRes = await db.query(
      `SELECT * FROM jobs WHERE kind='ingest' ORDER BY started_at DESC LIMIT 1`
    );
    if (!jobRes.rows.length) {
      res.json({ job: null, items: null });
      return;
    }
    const job = jobRes.rows[0];
    const items = await db.query(
      `SELECT status, COUNT(*)::int AS count
         FROM job_items WHERE job_id = $1 GROUP BY status`,
      [job.id]
    );
    const byStatus = {};
    for (const row of items.rows) byStatus[row.status] = row.count;
    res.json({ job, itemsByStatus: byStatus });
  })
);

module.exports = router;
