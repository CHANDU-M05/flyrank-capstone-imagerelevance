'use strict';

// Background ingestion job.
//
// Flow: scan corpus -> sha256 each file -> idempotent upsert into images -> create a
// jobs row -> process pending images in batches with bounded retries -> validate +
// persist normalized vision metadata -> embed captions (cached) -> apply the
// confidence/flagged status rule -> accumulate cost and STOP new paid work when the
// budget would be crossed -> finalize counts/timestamps -> notify on failure/budget stop.
//
// Idempotency guarantees (verified by running `npm run ingest` twice):
//   * images keyed by sha256 -> a re-run creates no duplicate image rows
//   * already-done images are skipped -> no repeated vision calls, no re-embeddings
//   * job_items keyed by (job_id, image_id) -> no duplicate per-item records

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('../config');
const pool = require('../db/pool');
const { run: migrate } = require('../db/migrate');
const vision = require('../services/vision');
const { getOrCreateImageVector } = require('../services/embeddings');
const { notify } = require('../services/notify');
const { BudgetExceededError } = require('../services/errors');

const CORPUS_DIR = path.join(__dirname, '..', '..', 'corpus');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function listCorpusFiles(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(`corpus directory not found: ${dir} (run: npm run corpus)`);
  }
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
    .map((f) => path.join(dir, f));
}

function loadManifestMeta(dir) {
  const p = path.join(dir, 'manifest.json');
  if (!fs.existsSync(p)) return {};
  const manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
  const byFile = {};
  for (const m of manifest) byFile[m.filename] = m;
  return byFile;
}

// Insert or fetch the image row for a file. Returns { image, isNew }.
async function upsertImage(db, { filename, sha, meta }) {
  const inserted = await db.query(
    `INSERT INTO images (filename, sha256, source_url, license, artist, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     ON CONFLICT (sha256) DO NOTHING
     RETURNING *`,
    [filename, sha, meta ? meta.source_url : null, meta ? meta.license : null, meta ? meta.artist : null]
  );
  if (inserted.rows.length) return { image: inserted.rows[0], isNew: true };
  const existing = await db.query('SELECT * FROM images WHERE sha256 = $1', [sha]);
  return { image: existing.rows[0], isNew: false };
}

async function createJob(db) {
  const res = await db.query(
    `INSERT INTO jobs (kind, status, budget_usd) VALUES ('ingest', 'running', $1) RETURNING *`,
    [config.costBudgetUsd]
  );
  return res.rows[0];
}

async function upsertJobItem(db, jobId, imageId, patch) {
  await db.query(
    `INSERT INTO job_items (job_id, image_id, attempts, status, error)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (job_id, image_id) DO UPDATE SET
       attempts = EXCLUDED.attempts,
       status = EXCLUDED.status,
       error = EXCLUDED.error`,
    [jobId, imageId, patch.attempts || 0, patch.status || 'pending', patch.error || null]
  );
}

async function finalizeJob(db, job, counts, status) {
  await db.query(
    `UPDATE jobs SET status=$2, total=$3, processed=$4, failed=$5, flagged=$6, cost_usd=$7, finished_at=now() WHERE id=$1`,
    [job.id, status, counts.total, counts.processed, counts.failed, counts.flagged, counts.cost]
  );
}

/**
 * @param {object} [deps] injectable for tests: { db, fetchImpl, cfg }
 */
async function run(deps = {}) {
  const db = deps.db || pool;
  const cfg = { ...config, ...(deps.cfg || {}) };
  const log = deps.log || console.log;

  // Ensure schema exists when running against the real pool. Injected test dbs are
  // already set up by the test and are left alone.
  if (!deps.db) await migrate({ db: pool, quiet: true });

  const corpusDir = deps.corpusDir || CORPUS_DIR;
  const files = listCorpusFiles(corpusDir);
  const metaByFile = loadManifestMeta(corpusDir);

  // Phase A: register every file idempotently (no AI). Collect the ones needing work.
  const job = await createJob(db);
  const todo = [];
  let total = 0;
  for (const file of files) {
    const buf = fs.readFileSync(file);
    const sha = sha256(buf);
    const { image } = await upsertImage(db, { filename: path.basename(file), sha, meta: metaByFile[path.basename(file)] });
    total++;
    // Skip work already completed in a prior run.
    if (image.status === 'done' || image.status === 'flagged') {
      await upsertJobItem(db, job.id, image.id, { status: 'skipped' });
      continue;
    }
    todo.push({ image, buf });
  }

  const counts = { total, processed: 0, failed: 0, flagged: 0, cost: 0 };
  log(`[ingest] job ${job.id}: ${todo.length} to process, ${total - todo.length} already done (skipped)`);

  let stoppedBudget = false;

  // Phase B: process in batches.
  for (let i = 0; i < todo.length; i += cfg.ingestBatchSize) {
    if (stoppedBudget) break;
    const batch = todo.slice(i, i + cfg.ingestBatchSize);
    for (const { image, buf } of batch) {
      await db.query(`UPDATE images SET status='processing' WHERE id=$1`, [image.id]);
      try {
        const { vision: v, usd } = await vision.classifyImage(buf, { db, fetchImpl: deps.fetchImpl, cfg, imageId: image.id });
        counts.cost += usd || 0;

        const isFlagged = Number(v.confidence) < cfg.confidenceThreshold;
        await db.query(
          `UPDATE images SET vision=$2::jsonb, confidence=$3, model=$4, status=$5, error=NULL, processed_at=now() WHERE id=$1`,
          [image.id, JSON.stringify(v), v.confidence, v.model, isFlagged ? 'flagged' : 'done']
        );
        const stored = { ...image, vision: v };
        const emb = await getOrCreateImageVector(db, stored, { fetchImpl: deps.fetchImpl, cfg });
        counts.cost += emb.usd || 0;

        if (isFlagged) {
          counts.flagged++;
          await upsertJobItem(db, job.id, image.id, { attempts: 1, status: 'flagged' });
        } else {
          await upsertJobItem(db, job.id, image.id, { attempts: 1, status: 'done' });
        }
        counts.processed++;
        log(`[ingest] ${image.filename} -> ${v.group || 'unknown'} (conf ${v.confidence}) ${isFlagged ? '[FLAGGED]' : ''}`);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          log(`[ingest] BUDGET STOP: ${err.message}`);
          await db.query(`UPDATE images SET status='pending' WHERE id=$1`, [image.id]);
          await upsertJobItem(db, job.id, image.id, { status: 'skipped', error: 'budget stop' });
          await notify(`Image ingestion stopped by budget guard: ${err.message}`, { cfg });
          stoppedBudget = true;
          break;
        }
        const msg = String(err.message || err).slice(0, 300);
        await db.query(`UPDATE images SET status='failed', error=$2 WHERE id=$1`, [image.id, msg]);
        await upsertJobItem(db, job.id, image.id, { attempts: cfg.ingestRetryMax, status: 'failed', error: msg });
        counts.failed++;
        log(`[ingest] FAILED ${image.filename}: ${msg}`);
        await notify(`Image ingestion failed for ${image.filename}: ${msg}`, { cfg });
      }
    }
    // Persist running cost after each batch so a crash keeps an accurate ledger.
    await db.query(`UPDATE jobs SET cost_usd=$2, processed=$3, failed=$4, flagged=$5 WHERE id=$1`, [job.id, counts.cost, counts.processed, counts.failed, counts.flagged]);
  }

  const status = stoppedBudget ? 'stopped_budget' : counts.failed > 0 && counts.processed === 0 ? 'failed' : 'completed';
  await finalizeJob(db, job, counts, status);
  log(`[ingest] done: ${counts.processed} processed, ${counts.flagged} flagged, ${counts.failed} failed, cost $${counts.cost.toFixed(6)} (${status})`);
  return { jobId: job.id, counts, status };
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('[ingest] fatal:', err);
      try {
        await notify(`Image ingestion crashed: ${err.message}`, {});
      } catch {
        /* never let notify failure mask the original error */
      }
      await pool.end().catch(() => {});
      process.exit(1);
    });
}

module.exports = { run, sha256, upsertImage };
