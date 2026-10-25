'use strict';

const { z } = require('zod');
const { HttpError } = require('./http-error');

// Shared Zod schemas + validators so routes never hand-parse the body/params.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value, label = 'id') {
  if (!UUID_RE.test(String(value))) {
    throw HttpError.badRequest(`Invalid ${label}: must be a UUID`, { code: 'INVALID_UUID' });
  }
  return value;
}

const createPostSchema = z.object({
  slug: z
    .string()
    .min(3)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase, hyphen-separated'),
  title: z.string().min(3).max(200),
  body: z.string().min(10).max(20000),
  subject_hint: z.string().min(1).max(120).optional(),
});

const reviewSchema = z.object({
  note: z.string().max(500).optional(),
});

module.exports = { UUID_RE, assertUuid, createPostSchema, reviewSchema };
