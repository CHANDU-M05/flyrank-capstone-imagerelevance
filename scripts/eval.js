'use strict';

// Evaluation harness.
//
// Runs the SAME shared matching pipeline the HTTP API uses against the seeded,
// ingested corpus and the golden labels produced by `npm run corpus`, then reports:
//   * labeled in-scope posts, posts with a valid golden image present in the DB
//   * top-1 precision (guard's best accepted pick == golden)
//   * top-3 recall (golden appears among the accepted top-3)
//   * guard rejections, and correct 'no confident match' refusals for out-of-scope posts
//   * precision across a similarity-threshold sweep at base and +/- 0.05
//   * skipped / failed examples (printed, never silently dropped)
//
// Denominators are explicit: a golden image missing from the corpus is SKIPPED (and
// printed), not counted as a hit, so precision is never inflated. Every call uses the
// cached post/image embeddings, so eval itself spends nothing.
//
// Results persist to eval_results so `GET /eval` returns a real run.

const fs = require('fs');
const path = require('path');

const config = require('../src/config');
const pool = require('../src/db/pool');
const { matchPostToImages } = require('../src/services/pipeline');

const CORPUS_DIR = path.join(__dirname, '..', 'corpus');

function loadJson(p) {
  if (!fs.existsSync(p)) throw new Error(`missing file: ${p} (run: npm run corpus)`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Evaluate one post at a given similarity threshold; return { topAccepted, acceptedFilenames, overall }.
async function evalAtThreshold(db, post, threshold, cfg) {
  const res = await matchPostToImages(db, post, {
    top: cfg.topK,
    persist: false,
    cfg: { ...cfg, similarityThreshold: threshold },
  });
  const accepted = res.suggestions.filter((s) => s.decision === 'suggested').map((s) => s.filename);
  const guardRejections = res.suggestions.filter((s) => s.decision === 'rejected').length;
  return { accepted, guardRejections, overall: res.overall };
}

async function run(db = pool) {
  const started = Date.now();
  const golden = loadJson(path.join(CORPUS_DIR, 'eval_golden.json')).labels;
  const postsSpec = loadJson(path.join(CORPUS_DIR, 'posts.json')).posts;

  // Which golden images are actually usable candidates (ingested AND embedded)?
  // A golden whose image never got vision/embedding (e.g. provider quota) is an
  // explicit SKIP, not a miss — so precision reflects matching logic, not ingestion gaps.
  const imgRes = await db.query(
    `SELECT i.filename FROM images i JOIN image_vectors v ON v.image_id = i.id WHERE i.vision IS NOT NULL`
  );
  const present = new Set(imgRes.rows.map((r) => r.filename));

  // filename -> resolved taxonomy group, for the group-level relevance metric. The
  // system's job is to recommend a CORRECT-CATEGORY image; the golden is just one
  // arbitrary member of that category, so exact-file top-1 is a harsh sub-metric and
  // group-level top-1 is the faithful one. Both are reported (neither hides the other).
  const grpRes = await db.query(`SELECT filename, COALESCE(vision->>'group', '') AS grp FROM images WHERE vision IS NOT NULL`);
  const groupByFile = new Map(grpRes.rows.map((r) => [r.filename, r.grp]));

  const cfg = config;
  const baseThreshold = cfg.similarityThreshold;
  const sweepPoints = [Number((baseThreshold - 0.05).toFixed(4)), baseThreshold, Number((baseThreshold + 0.05).toFixed(4))];

  let inScope = 0; // golden non-null (a correct image is expected)
  let outOfScope = 0; // golden null (system should refuse)
  let skipped = 0;
  let failed = 0;
  let guardRejections = 0;
  const skipNotes = [];
  const perSweep = { top1: {}, top3: {} };
  for (const t of sweepPoints) {
    perSweep.top1[t] = { hit: 0, denom: 0 };
    perSweep.top3[t] = { hit: 0, denom: 0 };
  }

  // Main metrics measured at the base threshold.
  let top1Hit = 0;
  let top1GroupHit = 0;
  let top3Hit = 0;
  let correctRefusals = 0;

  for (const spec of postsSpec) {
    const postRes = await db.query('SELECT * FROM posts WHERE slug = $1', [spec.slug]);
    if (!postRes.rows.length) {
      skipped++;
      skipNotes.push(`post "${spec.slug}" not in DB (run npm run seed)`);
      continue;
    }
    const post = postRes.rows[0];
    const goldenFile = golden[spec.slug];

    // Out-of-scope control: expect a refusal (no accepted candidate).
    if (goldenFile === null || goldenFile === undefined) {
      outOfScope++;
      try {
        const { accepted, guardRejections: gr } = await evalAtThreshold(db, post, baseThreshold, cfg);
        guardRejections += gr;
        if (accepted.length === 0) correctRefusals++;
        else skipNotes.push(`[warn] out-of-scope "${spec.slug}" wrongly accepted ${accepted.length} candidate(s)`);
      } catch (e) {
        failed++;
        skipNotes.push(`post "${spec.slug}" failed: ${e.message}`);
      }
      continue;
    }

    // In-scope: a specific golden image should rank first among accepted.
    if (!present.has(goldenFile)) {
      skipped++;
      skipNotes.push(`golden image "${goldenFile}" for "${spec.slug}" not ingested (skipped)`);
      continue;
    }
    inScope++;

    for (const t of sweepPoints) {
      try {
        const { accepted, guardRejections: gr } = await evalAtThreshold(db, post, t, cfg);
        if (t === baseThreshold) guardRejections += gr;
        if (t === baseThreshold && spec.group && accepted[0] && groupByFile.get(accepted[0]) === spec.group) top1GroupHit++;
        perSweep.top1[t].denom++;
        perSweep.top3[t].denom++;
        if (accepted[0] === goldenFile) {
          perSweep.top1[t].hit++;
          if (t === baseThreshold) top1Hit++;
        }
        if (accepted.slice(0, 3).includes(goldenFile)) {
          perSweep.top3[t].hit++;
          if (t === baseThreshold) top3Hit++;
        }
      } catch (e) {
        if (t === baseThreshold) failed++;
        skipNotes.push(`post "${spec.slug}" @${t} failed: ${e.message}`);
      }
    }
  }

  const top1Precision = inScope ? Number((top1Hit / inScope).toFixed(4)) : null;
  const top3Recall = inScope ? Number((top3Hit / inScope).toFixed(4)) : null;
  const top1GroupAccuracy = inScope ? Number((top1GroupHit / inScope).toFixed(4)) : null;

  const sweep = sweepPoints.map((t) => ({
    similarity_threshold: t,
    top1_precision: perSweep.top1[t].denom ? Number((perSweep.top1[t].hit / perSweep.top1[t].denom).toFixed(4)) : null,
    top3_recall: perSweep.top3[t].denom ? Number((perSweep.top3[t].hit / perSweep.top3[t].denom).toFixed(4)) : null,
    evaluated: perSweep.top1[t].denom,
  }));

  const runtimeMs = Date.now() - started;

  // Persist the run (latest row is authoritative for GET /eval).
  await db.query(
    `INSERT INTO eval_results
       (dataset_posts, golden_ok, top1_precision, top3_recall, guard_rejections,
        correct_refusals, skipped, failed, thresholds, sweep, runtime_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
    [
      inScope,
      top1Hit,
      top1Precision,
      top3Recall,
      guardRejections,
      correctRefusals,
      skipped,
      failed,
      JSON.stringify({ similarity: baseThreshold, confidence: cfg.confidenceThreshold, rejectConfidence: cfg.guardConfidenceReject, topK: cfg.topK, top1_group_accuracy: top1GroupAccuracy }),
      JSON.stringify(sweep),
      runtimeMs,
    ]
  );

  // ---- Report ----
  console.log('\n=== EVALUATION ===');
  console.log(`in-scope labeled posts : ${inScope}`);
  console.log(`out-of-scope controls  : ${outOfScope}`);
  console.log(`skipped                : ${skipped}`);
  console.log(`failed                 : ${failed}`);
  console.log(`top-1 precision        : ${top1Precision === null ? 'n/a' : (top1Precision * 100).toFixed(1) + '%'} (${top1Hit}/${inScope})  [exact golden file]`);
  console.log(`top-1 group accuracy   : ${top1GroupAccuracy === null ? 'n/a' : (top1GroupAccuracy * 100).toFixed(1) + '%'} (${top1GroupHit}/${inScope})  [correct category]`);
  console.log(`top-3 recall           : ${top3Recall === null ? 'n/a' : (top3Recall * 100).toFixed(1) + '%'} (${top3Hit}/${inScope})`);
  console.log(`guard rejections       : ${guardRejections}`);
  console.log(`correct refusals       : ${correctRefusals}/${outOfScope}`);
  console.log(`runtime                : ${runtimeMs} ms`);
  console.log('\nthreshold sweep (top-1 precision):');
  for (const s of sweep) {
    console.log(`  sim ${s.similarity_threshold} -> ${s.top1_precision === null ? 'n/a' : (s.top1_precision * 100).toFixed(1) + '%'} over ${s.evaluated} posts`);
  }
  if (skipNotes.length) {
    console.log('\nnotes / exclusions:');
    for (const n of skipNotes) console.log(`  - ${n}`);
  }
  console.log('\n[eval] run persisted to eval_results (see GET /eval).');

  return { inScope, outOfScope, top1Precision, top1GroupAccuracy, top3Recall, guardRejections, correctRefusals, skipped, failed, sweep, runtimeMs };
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('[eval] failed:', err);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}

module.exports = { run };
