'use strict';

const express = require('express');
const cors = require('cors');

const config = require('./config');
const { HttpError } = require('./utils/http-error');

const imagesRouter = require('./routes/images');
const postsRouter = require('./routes/posts');
const jobsRouter = require('./routes/jobs');
const costsRouter = require('./routes/costs');
const evalRouter = require('./routes/eval');

/**
 * Build the Express app. `deps.db` is any pg-pool-like handle (with .query), so API
 * tests can inject a fake pool and never touch Postgres. Defaults to the real pool.
 */
function createApp(deps = {}) {
  const db = deps.db || require('./db/pool');
  const cfg = { ...config, ...(deps.cfg || {}) };

  const app = express();
  app.locals.db = db;
  app.locals.cfg = cfg;

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // Health: db reachability + active model names. Never returns secrets.
  app.get('/health', async (req, res) => {
    let dbStatus = 'up';
    try {
      await db.query('SELECT 1');
    } catch (err) {
      dbStatus = 'down';
    }
    res.json({
      status: dbStatus === 'up' ? 'ok' : 'degraded',
      db: dbStatus,
      models: { vision: cfg.visionModel, embedding: cfg.embeddingModel },
      budget_usd: cfg.costBudgetUsd,
      uptime_s: Math.round(process.uptime()),
    });
  });

  app.use('/images', imagesRouter);
  app.use('/posts', postsRouter);
  app.use('/jobs', jobsRouter);
  app.use('/costs', costsRouter);
  app.use('/eval', evalRouter);

  // Unknown route -> clean JSON 404 (never an HTML stack page).
  app.use((req, res, next) => {
    next(new HttpError(404, `Not found: ${req.method} ${req.path}`, { code: 'NOT_FOUND' }));
  });

  // Central error handler. HttpError messages we raised are safe to expose; anything
  // else becomes a generic 500 and is logged server-side only (no key/stack leakage).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({
        error: { code: err.code || 'REQUEST_ERROR', message: err.expose ? err.message : 'Request failed', details: err.details || undefined },
      });
    }
    // Zod errors from any straggler path.
    if (err && err.name === 'ZodError') {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request body', details: err.issues } });
    }
    const status = err.status || err.statusCode || 500;
    // Log the real error for operators; return a sanitized body to the client.
    console.error('[http] unhandled error:', err.message);
    return res.status(status === 404 ? 404 : 500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  return app;
}

module.exports = { createApp };
