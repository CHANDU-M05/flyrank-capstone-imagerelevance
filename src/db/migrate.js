'use strict';

const fs = require('fs');
const path = require('path');
const pool = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// Applies any .sql files in migrations/ (sorted) that are not yet recorded.
// Each file runs inside its own transaction; a failure rolls back that file and
// aborts, so a broken migration is never marked complete.
async function run({ quiet = false, db } = {}) {
  const poolOrClient = db || pool;
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const client = poolOrClient.connect ? await poolOrClient.connect() : poolOrClient;
  const owns = poolOrClient.connect ? client : null;
  try {
    await ensureMigrationsTable(client);

    const applied = new Set(
      (await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename)
    );

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      log(`[migrate] applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    log(count === 0 ? '[migrate] up to date (nothing new)' : `[migrate] applied ${count} migration(s)`);
  } finally {
    if (owns) owns.release();
  }
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] failed:', err.message || err);
      process.exit(1);
    });
}

module.exports = { run };
