'use strict';

const express = require('express');
const { asyncHandler } = require('../utils/async-handler');
const { parsePaging } = require('../middleware/validate');

const router = express.Router();

// GET /costs — grand total, per-kind/model rollups, budget status, recent rows.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = req.app.locals.db;
    const cfg = req.app.locals.cfg;
    const { limit } = parsePaging(req.query, { defaultLimit: 25, maxLimit: 100 });

    const totals = await db.query(
      `SELECT COALESCE(SUM(usd),0)::numeric AS total,
              COUNT(*)::int AS calls,
              SUM(CASE WHEN success THEN 0 ELSE 1 END)::int AS failed_calls
         FROM costs`
    );
    const byKind = await db.query(
      `SELECT kind, model, COUNT(*)::int AS calls,
              COALESCE(SUM(usd),0)::numeric AS usd,
              COALESCE(SUM(tokens_in),0)::bigint AS tokens_in,
              COALESCE(SUM(tokens_out),0)::bigint AS tokens_out,
              COALESCE(SUM(tokens_thinking),0)::bigint AS tokens_thinking
         FROM costs GROUP BY kind, model ORDER BY kind, model`
    );
    const rows = await db.query(
      `SELECT id, kind, model, image_id, post_id, tokens_in, tokens_out, tokens_thinking,
              usd, latency_ms, success, error, created_at
         FROM costs ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );

    const total = Number(totals.rows[0].total);
    const budget = cfg.costBudgetUsd;
    res.json({
      total_usd: total,
      calls: totals.rows[0].calls,
      failed_calls: totals.rows[0].failed_calls,
      budget_usd: budget,
      budget_remaining_usd: Number((budget - total).toFixed(8)),
      budget_status: total >= budget ? 'exhausted' : total > budget * 0.8 ? 'near_limit' : 'ok',
      by_kind: byKind.rows,
      recent: rows.rows,
    });
  })
);

module.exports = router;
