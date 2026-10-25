'use strict';

const { HttpError } = require('../utils/http-error');

// Centralized Zod validation for request bodies. On failure it produces a clean
// 400 with a per-field issue list rather than leaking Zod's raw internals.
function validateBody(schema, body) {
  const parsed = schema.safeParse(body || {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw HttpError.badRequest('Invalid request body', { code: 'VALIDATION_ERROR', details: issues });
  }
  return parsed.data;
}

// Parse + bound pagination so a client can never request an unbounded scan.
function parsePaging(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const rawLimit = Number(query.limit);
  const rawOffset = Number(query.offset);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), maxLimit) : defaultLimit;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { limit, offset };
}

module.exports = { validateBody, parsePaging };
