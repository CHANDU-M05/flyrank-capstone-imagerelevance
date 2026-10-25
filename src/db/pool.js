'use strict';

const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({ connectionString: config.databaseUrl });

pool.on('error', (err) => {
  // An idle client error should not crash the whole process.
  console.error('[db] unexpected error on idle client', err.message);
});

module.exports = pool;
