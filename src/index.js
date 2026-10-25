'use strict';

const config = require('./config');
const pool = require('./db/pool');
const { createApp } = require('./app');

const app = createApp({ db: pool });

const server = app.listen(config.port, () => {
  console.log(`[http] listening on http://localhost:${config.port} (env: ${config.env})`);
  console.log(`[http] vision=${config.visionModel} embedding=${config.embeddingModel} budget=$${config.costBudgetUsd}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[http] ${signal} received, shutting down gracefully`);

  // Stop accepting new connections, let in-flight requests drain, then close the pool.
  const timer = setTimeout(() => {
    console.error('[http] forced exit after timeout');
    process.exit(1);
  }, 10000);
  timer.unref();

  server.close((err) => {
    if (err) console.error('[http] error closing server:', err.message);
    pool
      .end()
      .then(() => {
        console.log('[http] closed db pool; bye');
        process.exit(0);
      })
      .catch((e) => {
        console.error('[http] error ending pool:', e.message);
        process.exit(1);
      });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server };
