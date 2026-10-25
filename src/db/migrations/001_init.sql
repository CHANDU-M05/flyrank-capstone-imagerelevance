-- 001_init.sql
-- Core schema for the AI Image Understanding & Content Matching Engine.
--
-- Design notes:
--   * Embeddings are stored as JSONB numeric arrays and cosine similarity is
--     computed in Node. At ~50 images a full scan is sub-millisecond, so pgvector
--     is unnecessary and keeps the stack to plain PostgreSQL (per the brief).
--   * `rank` is a reserved word in PostgreSQL, so it is always double-quoted.
--   * Status/action/kind columns are constrained with CHECK (capstone-1 style)
--     rather than Postgres enums, so they are easy to inspect and migrate.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- images: one row per corpus file. sha256 UNIQUE makes re-ingestion idempotent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS images (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename      TEXT NOT NULL,
  sha256        TEXT NOT NULL UNIQUE,
  source_url    TEXT,
  license       TEXT,
  artist        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','processing','done','failed','flagged')),
  vision        JSONB,               -- normalized vision output {group,subjects,category,attributes,caption,confidence}
  confidence    NUMERIC,             -- denormalized from vision for filtering/sorting
  model         TEXT,                -- vision model that produced `vision`
  error         TEXT,                -- sanitized failure reason when status='failed'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);
CREATE INDEX IF NOT EXISTS idx_images_category ON images ((vision->>'category'));

-- ---------------------------------------------------------------------------
-- image_vectors: caption embedding, one per image (PK is also the FK).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS image_vectors (
  image_id    UUID PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
  embedding   JSONB NOT NULL,        -- 768-dim numeric array
  dims        INTEGER NOT NULL,
  model       TEXT NOT NULL,
  embedded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- posts: article text plus its cached embedding (paid once unless re-embedded).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS posts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  subject_hint  TEXT,                -- explicit topic used by the guard; falls back to title
  embedding     JSONB,
  embedded_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- suggestions: a ranked or forced candidate pairing with the guard's verdict.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suggestions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id           UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  image_id          UUID NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  "rank"            INTEGER,
  similarity        NUMERIC,
  guard_decision    TEXT NOT NULL CHECK (guard_decision IN ('suggested','flagged','rejected')),
  guard_reasons     JSONB NOT NULL DEFAULT '[]',
  vision_confidence NUMERIC,
  source            TEXT NOT NULL DEFAULT 'ranked' CHECK (source IN ('ranked','forced')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (post_id, image_id, source)
);

CREATE INDEX IF NOT EXISTS idx_suggestions_post_rank ON suggestions(post_id, "rank");

-- ---------------------------------------------------------------------------
-- reviews: human decision. One decision per suggestion (UNIQUE).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reviews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  suggestion_id UUID NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
  action        TEXT NOT NULL CHECK (action IN ('approved','rejected')),
  note          TEXT,
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (suggestion_id)
);

-- ---------------------------------------------------------------------------
-- jobs + job_items: batch ingestion progress, attempts and cost accounting.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL,                       -- 'ingest'
  status      TEXT NOT NULL DEFAULT 'running'
              CHECK (status IN ('running','completed','stopped_budget','failed')),
  total       INTEGER NOT NULL DEFAULT 0,
  processed   INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  flagged     INTEGER NOT NULL DEFAULT 0,
  budget_usd  NUMERIC(12,8) NOT NULL DEFAULT 0,
  cost_usd    NUMERIC(12,8) NOT NULL DEFAULT 0,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS job_items (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id    UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  image_id  UUID NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  attempts  INTEGER NOT NULL DEFAULT 0,
  status    TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','done','failed','flagged','skipped')),
  error     TEXT,
  UNIQUE (job_id, image_id)
);

-- ---------------------------------------------------------------------------
-- costs: one row per real API call (success or failure), attributed per call.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS costs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           TEXT NOT NULL CHECK (kind IN ('vision','embedding')),
  model          TEXT NOT NULL,
  provider       TEXT NOT NULL DEFAULT 'gemini',
  image_id       UUID REFERENCES images(id) ON DELETE SET NULL,
  post_id        UUID REFERENCES posts(id) ON DELETE SET NULL,
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  tokens_thinking INTEGER,
  usd            NUMERIC(12,8) NOT NULL DEFAULT 0,
  latency_ms     INTEGER,
  success        BOOLEAN NOT NULL DEFAULT true,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_costs_kind_created ON costs(kind, created_at);

-- ---------------------------------------------------------------------------
-- eval_results: one row per actual evaluation run; the latest row is authoritative.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS eval_results (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  dataset_posts     INTEGER NOT NULL,
  golden_ok         INTEGER NOT NULL,
  top1_precision    NUMERIC,
  top3_recall       NUMERIC,
  guard_rejections  INTEGER NOT NULL DEFAULT 0,
  correct_refusals  INTEGER NOT NULL DEFAULT 0,
  skipped           INTEGER NOT NULL DEFAULT 0,
  failed            INTEGER NOT NULL DEFAULT 0,
  thresholds        JSONB NOT NULL DEFAULT '{}',
  sweep             JSONB NOT NULL DEFAULT '[]',
  runtime_ms        INTEGER
);
