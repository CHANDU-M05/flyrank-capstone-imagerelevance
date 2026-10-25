# AI Image Understanding & Content Matching Engine

FlyRank Backend Capstone 2 — a service that, given a blog post, recommends the single
most relevant image from a corpus by (1) understanding each image with a vision model,
(2) embedding image captions and post text into the same vector space, (3) ranking by
cosine similarity, and — most importantly — (4) running **every** candidate through a
deterministic **mismatch guard** that refuses to recommend an image that is not actually
about the post's subject.

The headline behaviour: a **wolf image is never recommended for a fox post**, even if
the wolf is the most vector-similar image and even if it is *force-submitted* by id. The
guard beats similarity, always.

> No frontend. Everything is exercised through the REST API and the Postgres tables.

---

## 1. The problem, in plain terms

A content team writes articles and needs a relevant image for each. A naive
"most-similar-embedding" recommender confidently recommends the *wrong thing*: a grey
wolf beside an article about red foxes, a painting of a man-and-dog beside a puppy-training
post, a wildlife photo beside an article about city skylines. Embedding similarity has no
notion of *category correctness*; it only has notion of *closeness*.

This engine separates the two concerns:

- **AI proposes** — vision + embeddings rank candidate images by semantic closeness.
- **The guard disposes** — a pure, deterministic, testable rule set decides whether a
  candidate is actually eligible, and refuses when nothing is.

## 2. Intended users

Editorial / content-ops teams who attach imagery to posts and need a **safe default**
(auto-recommend only genuinely on-topic images) plus a **human-review lane** for the
uncertain ones (`flagged`), with per-call cost accounting throughout.

---

## 3. Architecture

```
                       ┌──────────────────────────────────────────────┐
                       │                  Express API                  │
                       │  /health /images /posts /jobs /costs /eval    │
                       └───────┬───────────────────────────────┬───────┘
                               │                               │
                     match pipeline                    ingest job (batch)
                               │                               │
        ┌──────────────────────┴───────────┐      ┌────────────┴─────────────┐
        │        services/pipeline.js       │      │        jobs/ingest.js     │
        │  embed post → rank → GUARD → save │      │ sha256 → vision → embed → │
        └───┬───────────────┬───────────────┘      │ persist → budget → notify │
            │               │                       └────┬───────────┬─────────┘
     ┌──────▼─────┐   ┌─────▼──────────┐                 │           │
     │ services/  │   │ services/      │          ┌──────▼─────┐ ┌───▼──────────┐
     │ matching.js│   │ guard.js       │          │ services/  │ │ services/    │
     │ (cosine,   │   │ PURE decision  │          │ vision.js  │ │ embeddings.js│
     │  ranking)  │   │ core (rules)   │          │ (Gemini    │ │ (Gemini      │
     └────────────┘   └────────────────┘          │  vision)   │ │  embed 768d) │
            │                   │                 └──────┬─────┘ └───────┬──────┘
            │                   ▼                        │               │
     ┌──────▼──────────────────────┐   ┌─────────────────▼───────────────▼──────┐
     │        services/taxonomy.js │   │   costs.js: per-call ledger + budget    │
     │  subject → canonical group  │   │   guard projects cost BEFORE paid call  │
     └─────────────────────────────┘   └─────────────────┬───────────────────────┘
                                                         │
                                              ┌──────────▼──────────┐
                                              │  PostgreSQL (pg)    │
                                              │ images / vectors /  │
                                              │ posts / suggestions │
                                              │ reviews / jobs /    │
                                              │ costs / eval_results│
                                              └─────────────────────┘
```

Data flow for one recommendation:

1. `GET /posts/:id/images?top=5` loads the post, embeds it **once** (cached thereafter).
2. All ingested images with a stored vector become candidates.
3. `matching.rankImages` orders candidates by cosine similarity (deterministic ties).
4. `pipeline` runs **every** ranked candidate through `guard.evaluate`.
5. Verdicts (`suggested` / `flagged` / `rejected`) are persisted as `suggestions`.
6. The API returns the decision, the guard's human-readable reasons, thresholds, and
   whether the embedding came from cache. `force_image_id` pushes one specific image
   through the **same guard** (proving it cannot be bypassed).

## 4. Tech stack

| Layer        | Choice | Why |
|--------------|--------|-----|
| Runtime      | Node.js 20+, plain JavaScript (CommonJS) | minimal, matches capstone 1 |
| HTTP         | Express + cors + `express.json` | thin, ubiquitous |
| Database     | PostgreSQL 16 via `pg`, explicit SQL, transactions | no ORM, no vector DB |
| AI           | Google Gemini over native `fetch` REST | the pinned SDK's model list is stale |
| Validation   | Zod | schema-gate AI output *and* request bodies |
| Tests        | `node:test` (no network, mock `fetch`, fake pool) | fast, offline, zero spend |

Embeddings are stored as JSONB numeric arrays and cosine similarity is computed in Node.
At ~50 images a full scan is sub-millisecond, so `pgvector` is deliberately **not** used —
it would add a dependency for no benefit at this scale.

---

## 5. Prerequisites

- Node.js ≥ 20 (native `fetch`).
- Docker + Docker Compose (for PostgreSQL).
- ImageMagick (`magick` or `convert`) — only needed to rebuild the corpus.
- A Google Gemini API key in `.env` (`GEMINI_API_KEY`).

## 6. Configuration

Copy `.env.example` to `.env` and set `GEMINI_API_KEY`. Key variables (all overridable):

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | `postgres://imgrel:imgrel@localhost:5434/imagerelevance` | Postgres |
| `GEMINI_VISION_MODEL` | `gemini-2.5-flash` | vision model |
| `GEMINI_EMBEDDING_MODEL` | `gemini-embedding-001` | embedding model (768-dim) |
| `VISION_PRICING_USD_PER_M_INPUT` | `0.30` | paid-tier input rate / 1M |
| `VISION_PRICING_USD_PER_OUTPUT` | `2.50` | paid-tier output rate / 1M (**includes thinking tokens**) |
| `EMBEDDING_PRICING_USD_PER_M` | `0.15` | **third-party estimate** — this model is absent from the current official table |
| `COST_BUDGET_USD` | `1.00` | hard cap; the guard stops paid work before crossing it |
| `SIMILARITY_THRESHOLD` | `0.72` | "close enough" cut-off for the guard |
| `CONFIDENCE_THRESHOLD` | `0.70` | below this, a match is only `flagged`, never auto-accepted |
| `GUARD_CONFIDENCE_REJECT` | `0.40` | below this with no corroboration, hard-rejected |
| `TOP_K` | `8` | candidates ranked per post |
| `INGEST_BATCH_SIZE` / `INGEST_RETRY_MAX` | `5` / `3` | batch + retry controls |

`gemini-1.5-flash` and `text-embedding-004` are **obsolete** (verified: not in the model
list / 404), which is why the config above pins the 2.5-flash + embedding-001 pair.

## 7. Install & run

```bash
npm install

# 1. database
docker compose up -d          # postgres:16 on host port 5434
npm run migrate               # applies src/db/migrations/001_init.sql transactionally

# 2. corpus (reproducible Wikimedia Commons download; see §9)
npm run corpus                # ~48 target images + manifest + golden labels + audit table

# 3. data
npm run seed                  # upserts posts from corpus/posts.json (idempotent)
npm run ingest                # vision + embeddings for every image, budget-guarded
npm run ingest                # run it again — proves idempotency (see §10)

# 4. measure + serve
npm run eval                  # runs the pipeline against golden labels, persists results
npm start                     # REST API on http://localhost:3000
```

`npm run dev` runs with `--watch`. `npm test` is fully offline.

## 8. Database

`docker-compose.yml` runs an isolated `postgres:16-alpine` (db `imagerelevance`,
port **5434**, persistent named volume, `pg_isready` healthcheck) so it never collides
with local Postgres (5432) or capstone 1 (5433).

Tables (see `src/db/migrations/001_init.sql` and `DESIGN.md`):

- `images` — one row per file; `sha256 UNIQUE` is what makes re-ingest idempotent.
- `image_vectors` — one 768-dim caption embedding per image (the cache).
- `posts` — article text + cached embedding.
- `suggestions` — a ranked or **forced** candidate with its guard decision + reasons.
- `reviews` — one human decision (`approved`/`rejected`) per suggestion (`UNIQUE`).
- `jobs` / `job_items` — batch progress, per-image attempts, running cost.
- `costs` — one row per real API call (success **and** failure) with token counts,
  `tokens_thinking`, USD, latency.
- `eval_results` — one row per real evaluation run; the latest is authoritative.

## 9. Corpus & attribution

`scripts/fetch_corpus.js` pulls real, freely-licensed photographs from **Wikimedia
Commons**, resizes them locally (max 800 px, JPEG q72), and writes `corpus/*.jpg`,
`corpus/manifest.json` (source URL, Commons title, license, artist, dimensions) and
`corpus/eval_golden.json` (post slug → an image of the correct group, or `null` = a
post that *should* be refused). It prints a **human-readable label-audit table**.

Labels come from Commons **file metadata + title** resolved through the same taxonomy map
the guard uses — never guessed from a filename — and anything ambiguous is flagged
`needs_review` rather than silently relabeled. Downloads are done under the Wikimedia
originals path with a descriptive `User-Agent` and throttled retries.

> **Live-build note:** Wikimedia's anonymous **download** rate-limiter (HTTP 429) capped
> this run at **35 images across 5 animal groups** (fox, wolf, dog, bear, deer) below the
> ~48 target; the `city skyline` group got 0. The fetch script is reproducible — run it
> again when the limiter is friendlier to grow the set. All provenance is recorded per file.

## 10. Cost accounting & budget

- Every vision/embedding call writes a `costs` row with real token counts, including
  failures. Thinking tokens are billed at the **output** rate (the official table prices
  2.5-flash output *including thinking tokens*) — they are never treated as free.
- The budget guard runs **before** a paid request: `costs.js` totals spend and
  `vision.js` / `embeddings.js` project the next call's cost and throw
  `BudgetExceededError` rather than crossing `COST_BUDGET_USD`. A batch stops cleanly on
  that error and keeps already-completed work intact.
- This build runs on the **free tier** (actual spend **$0**), but tracking still accrues
  at configured paid-tier rates so the accounting and the guard are demonstrable.
  **This run tracked ≈ $0.0194 of a $1.00 budget** — the guard never had to fire.

## 11. Human-review workflow

The guard has three outcomes, and only the first is auto-accepted:

- `suggested` — clear, on-category match → eligible for auto-recommendation.
- `flagged` — a match we won't auto-accept (uncertain confidence **or** an image we
  cannot place in a category) → goes to a human.
- `rejected` — wrong category, low-confidence uncaptioned subject, or below similarity.

A reviewer records a decision via `POST /posts/:id/images/:imageId/approve|reject`.
One decision per pairing, repeats are idempotent, and reversing a decision returns 409.

## 12. API surface

| Method & path | Purpose |
|---------------|---------|
| `GET /health` | DB reachability + active model names (no secrets) |
| `GET /images?status=&category=&limit=&offset=` | bounded, filterable listing |
| `GET /images/:id` | full vision data + every suggestion involving the image |
| `POST /images/:id/reprocess` | re-run vision on the stored file, records its real cost |
| `GET /posts` · `POST /posts` · `GET /posts/:id` | posts (Zod-validated create; 409 on dup slug) |
| `GET /posts/:id/images?top=5&force_image_id=` | rank + guard every candidate; `force` still runs the guard |
| `POST /posts/:id/images/:imageId/approve` · `.../reject` | one persisted decision; idempotent; 409 on conflict |
| `GET /jobs/status` | latest ingest job + per-status item counts |
| `GET /costs` | totals by kind/model, per-call rows, grand total, budget remaining/status |
| `GET /eval` | most recent actual evaluation run |

Representative `GET /posts/:id/images?force_image_id=<wolf>` result (the guard beats a
forceful, similar, high-confidence wolf):

```json
{
  "overall": { "status": "match", "message": "Recommended image available" },
  "forced": {
    "filename": "wolf-gray-wolf-ssa-2023-16.jpg",
    "similarity": 0.7384,
    "visionConfidence": 0.98,
    "decision": "rejected",
    "reasons": ["Animal category mismatch: expected fox, detected wolf"],
    "source": "forced"
  }
}
```

Errors are always JSON — invalid UUID → 400, unknown resource → 404, conflicting review →
409 — with an internal `code` and no stack traces or secrets in the body.

## 13. Evaluation

`scripts/eval.js` runs the **same pipeline the API uses** against the golden labels and
persists to `eval_results` (`GET /eval`). It reports, with explicit denominators and
printed exclusions:

Because a "golden" image is one arbitrary member of a multi-image category, exact-file
top-1 is a **harsh** metric; **group-level top-1** (did it pick a *correct-category*
image?) is the faithful one. Both are reported and neither hides the other.

**Most recent real run (20 ingested images, free-tier quota limited ingestion):**

| Metric | Value |
|--------|-------|
| In-scope labeled posts evaluated | 6 |
| Top-1 **group** accuracy (correct category) | **100.0% (6/6)** |
| Top-1 exact-file precision | 16.7% (1/6) |
| Top-3 recall (exact golden) | 66.7% (4/6) |
| Correct out-of-scope refusals | **3/3** |
| Guard rejections | 40 |
| Skipped (golden not ingested — quota) | 3 |
| Failed | 0 |

Read: when an on-topic image is available, the engine **always recommends an image of the
right category** and the guard **never** cross-recommends; exact-file hits are lower only
because "correct fox" is satisfied by several foxes. Refusal for out-of-scope posts is
reliable. Numbers are bounded by the 20/35 images that cleared Gemini's daily quota; they
will rise as ingestion completes.

## 14. Tests

`npm test` — 46 tests, all offline (mock `fetch`, fake pool), no spend:

- `guard.test.js` — every decision rule + precedence (wolf-on-fox beats similarity,
  taxonomy fall-through, sub-threshold, confidence bands, non-animal controls, and the
  "uncategorizable candidate is flagged, never auto-suggested" rule).
- `matching.test.js` — cosine edge cases (zero/orthogonal/dim-mismatch/NaN) and stable
  ranking with deterministic ties + top-K bounds.
- `vision-schema.test.js` — schema validation, thinking-token cost math, sanitized
  provider errors, pre-send budget guard, 429 retry.
- `ingest.test.js` — single-process vision+embed; **re-running is idempotent** (no dup
  rows, no repeat AI calls); low-confidence image is flagged.
- `api.test.js` — validation, invalid-UUID 400, unknown-id 404, review idempotency + 409,
  embedding-cache reuse (no network on cached path), JSON 404.

## 15. Troubleshooting

- **`ECONNREFUSED 5434`** → `docker compose up -d`, wait for `healthy`.
- **ingest marks many images `failed`** → Gemini **free-tier daily quota**; failed images
  stay re-queued and are picked up by the next `npm run ingest` (already-done images are
  skipped, nothing is duplicated). This is exactly what happened during this build.
- **corpus is smaller than expected** → Wikimedia `upload.wikimedia.org` 429 download
  throttling; re-run `npm run corpus` later.
- **`budget exhausted`** → raise `COST_BUDGET_USD` or lower `MAX_IMAGE_TOKENS`.

## 16. Security notes

- Secrets live only in `.env` (gitignored); never logged, never returned by `/health`.
- All provider errors are sanitized before storage/logging — the API key never appears in
  a `costs.error`, a log line, or an HTTP body.
- Every Postgres value is parameterized; enum-like columns are DB-`CHECK`-constrained.
- Request bodies are Zod-validated with bounded lengths; pagination is bounded.
- Cost/token estimates are persisted per call for a full, attributable audit trail.

## 17. Honest limitations

- **Taxonomy is small and explicit.** Only the six seeded groups + two non-animal controls
  are understood. An image whose subject isn't in the map is *flagged*, not auto-rejected —
  a deliberate safety choice, but it means out-of-map topics rely on similarity + review.
- **Eval corpus is small** (20 of 35 images ingested, 6 measurable in-scope posts) and its
  golden picks are somewhat arbitrary within a category; the thresholds are tuned to *this*
  dataset and are not universal.
- **Single vision model, single embedding model** — no benchmark across providers.
- **Pricing is partly third-party.** `gemini-embedding-001` is absent from the current
  official pricing table; its rate is an operator-configurable estimate. Actual spend on
  the free tier was $0; tracked cost is a paid-tier projection.
- **Network/quota dependence.** Both Wikimedia downloads and Gemini calls are rate-limited;
  ingestion may need several runs to complete, and embeddings are billed but tiny.

See `DESIGN.md` for the full specification, `EVIDENCE.md` for one verified transcript per
acceptance check, and `BUILDLOG.md` for the real chronology and decisions.
