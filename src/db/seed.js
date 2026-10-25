'use strict';

// Idempotent seed: upserts the blog posts from corpus/posts.json keyed by slug.
// Re-running updates title/body/hint rather than duplicating. Image rows are created
// by the ingest job, not here, so the corpus remains the single source for images.

const fs = require('fs');
const path = require('path');
const pool = require('./pool');

const POSTS_PATH = path.join(__dirname, '..', '..', 'corpus', 'posts.json');

async function run(db = pool) {
  if (!fs.existsSync(POSTS_PATH)) {
    throw new Error(`posts file not found: ${POSTS_PATH}`);
  }
  const posts = JSON.parse(fs.readFileSync(POSTS_PATH, 'utf8')).posts;

  let count = 0;
  for (const p of posts) {
    await db.query(
      `INSERT INTO posts (slug, title, body, subject_hint)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE SET
         title = EXCLUDED.title,
         body = EXCLUDED.body,
         subject_hint = EXCLUDED.subject_hint`,
      [p.slug, p.title, p.body, p.subject_hint || null]
    );
    count++;
  }
  console.log(`[seed] upserted ${count} post(s)`);
  return { count };
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}

module.exports = { run };
