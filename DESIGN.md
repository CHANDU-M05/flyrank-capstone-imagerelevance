# Design — AI Image Understanding & Content Matching Engine

Capstone 2, FlyRank Backend Track. One page of decisions, written before the build.

## 1. Problem and intended users

A content team has an image library and a stream of blog posts. Picking the right
illustration by hand is slow, and keyword/file matching picks confidently wrong
images: a post about red foxes gets illustrated with a wolf because both are
"wild canid in forest" to a search box.

The system must understand what is *actually in* each image, match posts to images
by meaning, and — the part that makes it a product rather than a demo — **refuse**
when the best candidate is still wrong, with an explanation a human can act on.

Intended users: editors/ContentOps (via the review API), and downstream publishing
tooling (via the read endpoints).

## 2. Architecture and data flow

```
              ┌────────────── batch job (npm run ingest) ──────────────┐
corpus/*.jpg ─► sha256 ─► images upsert ─► vision (gemini-2.5-flash)   │
                                             │  structured JSON + Zod   │
                                             ▼                          │
                                      image_metadata (vision JSONB)     │
                                             │                          │
                                             └─► embed(caption) ─► image_vectors
                                                                  ▲
posts.json ─► posts ────────────────────── embed(post text) ──────┘

GET /posts/:id/images
   post vector ─► cosine ranking ─► TOP_K candidates
                 ─► MISMATCH GUARD (taxonomy group → confidence → threshold)
                 ─► suggested + explained   |   "no confident match" + reasons
                 ─► Review API: approve / reject
every paid call ─► costs row (tokens, thinking tokens, usd, latency) ─► budget guard
```

Two embedding streams (image captions, post text) meet only at the ranking step, and
nothing reaches a human without passing the guard.

## 3. Vision output schema

The model is forced into JSON with `responseMimeType: application/json` +
`responseSchema`, then re-validated by Zod in our own code before anything is
persisted. The model's schema and Zod's schema are two independent checks.

```json
{
  "subjects":   ["red fox"],
  "group":      "fox",
  "category":   "animal",
  "attributes": ["orange fur", "forest", "wild"],
  "caption":    "A red fox standing at the edge of a forest",
  "confidence": 0.94
}
```

Rules enforced by Zod: `subjects` non-empty strings, `category` from a fixed
enum, `attributes` ≤ 12 strings, `caption` 10–400 chars, `confidence` a number in
`[0, 1]`. `group` is *our* taxonomy resolution, not the model's claim: we re-derive
it from `subjects` so a model that says `Vulpes vulpes` lands in the `fox` group.

Anything that fails validation is retried up to `INGEST_RETRY_MAX`, then recorded as
`status='failed'` with the sanitized error — never persisted as if it were valid.

## 4. Data model

| Table | Purpose | Notable constraint |
|---|---|---|
| `images` | one row per corpus file | `sha256 UNIQUE` → re-ingest is idempotent |
| `image_vectors` | caption embedding | PK = `image_id` (one vector per image) |
| `posts` | article + its cached embedding | `slug UNIQUE` |
| `suggestions` | ranked/forced pairing with the guard's verdict | `UNIQUE(post_id, image_id, source)` |
| `reviews` | human decision | `UNIQUE(suggestion_id)` → one decision per pairing |
| `jobs` / `job_items` | batch progress, attempts, cost | `UNIQUE(job_id, image_id)` |
| `costs` | one row per real API call, success or failure | `usd NUMERIC(12,8)` |
| `eval_results` | one row per actual evaluation run | latest row wins |

Indexes: `images(status)`, expression index on `(vision->>'category')`,
`suggestions(post_id, rank)`, `costs(kind, created_at)`. No index duplicates a
UNIQUE constraint that already covers the access pattern.

## 5. Matching and guard decision order

Ranking is cosine similarity over 768-dim `gemini-embedding-001` vectors, stored as
JSONB and computed in Node — at ~50 images a full scan is sub-millisecond, and it
keeps the stack to Postgres alone (pgvector optional at this scale, per the brief).
`TOP_K=8` candidates go to the guard.

Three distinct numbers, never conflated:

- **similarity** — is the *image* close to the *post* in meaning (vector space)?
- **confidence** — how sure is the vision model about the *subject* it extracted?
- **threshold** — where we, on evidence from the eval set, cut "close enough" off.

The guard applies, in strict precedence order, and returns on the first hit:

1. **Taxonomy-group conflict → `rejected`.** Post group and image group both
   resolve, and they differ. `Animal category mismatch: expected fox, detected
   wolf`. This beats similarity: a wolf at 0.85 is still wrong on a fox post.
2. **Low-confidence unsupported subject → `rejected`.** `confidence <
   GUARD_CONFIDENCE_REJECT` (0.40) *and* neither caption nor attributes
   corroborate the claimed group. The model guessed; we do not propagate guesses.
3. **Insufficient similarity → `rejected`.** `similarity < SIMILARITY_THRESHOLD`
   (0.72), reason contains `no confident match`.
4. **Low but not disqualifying confidence → `flagged`.** `confidence <
   CONFIDENCE_THRESHOLD` (0.70): shown, but marked for review, never auto-accepted.
5. Otherwise → `suggested`.

Taxonomy resolution is a deterministic, case-insensitive alias map in
`src/services/guard.js`. It deliberately does **not** merge species that merely
sound alike: `coyote` is its own group, not part of `wolf`; `dog` is not `fox`.
`vulpes`, `vulpes vulpes`, `red fox` → `fox`. `canis lupus`, `gray wolf`,
`grey wolf` → `wolf`. Non-animal controls (`city skyline`, `coffee cup`) resolve
so out-of-scope posts produce a refusal rather than a random wildlife photo.

Rejections carry human-readable reasons; when no candidate clears the bar the
response is an explicit `no confident match` with the per-candidate reasons.

## 6. API surface

`GET /health` · `GET /images` · `GET /images/:id` · `POST /images/:id/reprocess` ·
`GET /posts` · `POST /posts` · `GET /posts/:id` ·
`GET /posts/:id/images?top=&force_image_id=` ·
`POST /posts/:id/images/:imageId/approve` · `POST /posts/:id/images/:imageId/reject` ·
`GET /jobs/status` · `GET /costs` · `GET /eval`

`force_image_id` runs a named candidate through the *same* guard (recorded with
`source='forced'`) — it exists so the wolf-on-a-fox-post rejection is demonstrable
on demand instead of depending on ranking luck.

## 7. Budget enforcement and accounting

Every call to the provider is preceded by a projection (`MAX_IMAGE_TOKENS` for an
image, text length for an embedding) against `COST_BUDGET_USD`. If the projection
would cross the line, `BudgetExceededError` is thrown **before** the request leaves
the process. After each call, one `costs` row records model, provider, real token
counts including `thoughtsTokenCount`, latency, success and the computed USD.
`GET /costs` aggregates by kind and model and reports budget remaining.

Pricing is configured via env, defaulting to the published paid-tier rates for
`gemini-2.5-flash` ($0.30 in / $2.50 out, thinking billed inside output). We run on
the free tier, so the *real* invoice is $0.00 while the *tracked* equivalent is
non-zero — this is deliberate: the accounting and the guard must be observable and
testable, and the distinction is stated in the README rather than hidden.

## 8. Evaluation methodology

`corpus/eval_golden.json` labels ≥10 posts with the single correct image, derived
from Commons source metadata (never from a filename guess) and human-audited via the
printed label audit table. `scripts/eval.js` runs the real pipeline per golden post,
applies the guard, and reports top-1 precision, top-3 recall, guard rejections,
correct out-of-scope refusals, and precision across a similarity-threshold sweep at
the configured value ±0.05 — so the 0.72 cut-off is defended by a curve, not a
feeling. The denominator is explicit and exclusions are printed; results persist to
`eval_results` and are served by `GET /eval`.

## 9. Limitations

- Taxonomy map is hand-curated and finite; an unlisted species resolves to `null`
  and falls through to similarity-only, which is a weaker guarantee.
- ~50 images is enough to show retrieval behavior, not to benchmark a model.
- Thresholds are tuned to *this* corpus and `gemini-embedding-001`; they do not
  transfer to another embedding model.
- One vision model — this is not a model comparison.
- `gemini-embedding-001` pricing is not in the current official pricing table; the
  configured rate is a third-party-tracker estimate, adjustable via env.
- Free-tier use means prompts and outputs may be used by Google to improve its
  products; do not run confidential imagery through it.

## 10. Non-goal

**No frontend.** Human review is the REST API plus the `suggestions` and `reviews`
tables. Any UI is explicitly out of scope for this capstone.
