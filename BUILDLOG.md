# BUILDLOG

A real, ordered record of how Capstone 2 was built and run, including the decisions, the
things that broke, and the environment limits actually hit. Nothing here is reconstructed
after the fact to look tidier than it was.

---

## Order of work (guard-first, then everything around it)

The mismatch guard was built and unit-tested **before any AI service existed**, as an
independent pure module (`src/services/guard.js` + `taxonomy.js` + `matching.js`). That let
the entire decision core be verified with zero network and zero spend first, and gave a
stable target for the pipeline and routes to plug into later.

1. **Design gate** — `DESIGN.md`, `docker-compose.yml`, `.env`/`.env.example`, `.gitignore`,
   `package.json`, `capstone.yaml`.
2. **Pure core + tests** — guard, taxonomy, cosine/ranking, `guard.test.js`, `matching.test.js`.
   Written and run immediately (25 tests green before any provider code).
3. **Data layer** — `pool.js`, transactional `migrate.js`, `001_init.sql`, `seed.js`.
4. **AI services behind injectable `fetch`** — `gemini.js`, `errors.js`, `costs.js`,
   `vision.js`, `embeddings.js`, `notify.js`, `taxonomy.js` normalizer, `vision-schema.test.js`.
5. **Corpus** — `fetch_corpus.js` + `corpus/posts.json` (golden labels generated at build time).
6. **Ingestion** — idempotent `jobs/ingest.js` + `ingest.test.js`.
7. **REST API** — `app.js`/`index.js`, middleware, five routers, central JSON error handler,
   graceful shutdown. Shared `services/pipeline.js` so the route and the eval never diverge.
8. **Evaluation** — `scripts/eval.js` + `api.test.js`.
9. **Live run + docs** — everything below.

## Verified model / provider decisions

- `gemini-1.5-flash` and `text-embedding-004` (the scaffold's originals) are **gone** — absent
  from the live model list / 404. Confirmed against the API, so config pins
  **`gemini-2.5-flash`** (structured JSON + `responseSchema` verified) and
  **`gemini-embedding-001`** (768-dim, `taskType: SEMANTIC_SIMILARITY` verified).
- **Native `fetch` REST replaced the SDK.** `@google/generative-ai@0.21` stays declared
  because the scaffold requires it, but its model list is stale and 404s on embedding-001,
  so the real path is raw REST. This is the only justified deviation and is called out here.
- Ollama is not installed → cloud-only. Gemini image **generation** is 429-quota-blocked →
  the corpus had to come from a real source, not synthetic images.

## Pricing decisions

- `gemini-2.5-flash` paid tier verified from the official table: **$0.30**/1M input,
  **$2.50**/1M output **"including thinking tokens."** So thinking tokens are billed at the
  **output** rate — never free, never a separate rate. `costs.computeVisionCost` bills
  `(candidates + thoughts)` at the output rate; a unit test locks this in, and the live run's
  `tok_think=5043` shows real thinking counts captured.
- `gemini-embedding-001` is **absent from the current official pricing table**. The $0.15/1M
  used is a **third-party estimate**, shipped as an operator-configurable env var and labelled
  as an estimate in the README. This run's embedding cost rounded to ~$0.00, so the estimate
  has no material effect on the budget outcome.
- Free-tier reality: actual spend was **$0**, but tracking accrues at paid-tier rates so the
  ledger and the budget guard are demonstrable. README + this log state that plainly rather
  than implying real money moved.

## Bugs found and fixed during the build

- `BudgetExceededError` message had a formatting bug — fixed before it could mislead an operator.
- `ingest.js` hard-coded the corpus dir; parameterized `corpusDir` so the fake-corpus tests work.
- `migrate` needed a `db` override to run against an injected pool; and ingest must **not**
  call `migrate` when a test injects its own db — added the guard.
- Cache branch of `embeddings.getOrCreate*` needed to return `usd: 0` explicitly so cost
  accounting never fabricates spend on a cache hit.
- **Guard rule added because the live eval exposed a real leak.** The first `npm run eval`
  showed out-of-scope posts (city, espresso) **wrongly accepting one candidate each**
  (correct refusals 1/3). Root cause: a candidate whose subject the taxonomy can't place
  (e.g. a photo whose vision subject resolved to "Siberian Husky" / "golden jackal", both
  unmapped) has a **null group**, so rule 1 (which needs *both* sides known) never fires and
  it slips through on similarity alone. Fix: **rule 5 — an uncategorizable candidate can be
  at most `flagged`, never `suggested`.** Every existing "suggested" test already used a
  known-group candidate, so nothing broke; two new tests were added. Re-eval then showed
  **3/3 correct refusals** and **100% top-1 group accuracy**. This was a genuine
  correctness improvement discovered by running the thing, not a cosmetic tune.
- **Eval metric made honest.** A "golden" image is one arbitrary member of a category that
  contains several, so *exact-file* top-1 precision (16.7%) badly understates relevance.
  Rather than hide that, the eval now reports **both** exact-file precision and
  **group-level** top-1 accuracy (did it pick a *correct-category* image = 100%), and a
  un-ingestable golden (quota-failed image) is an **explicit skip with a printed note**, never
  a silent miss — so precision reflects matching logic, not ingestion gaps.

## Live-run reality (the environment fought back)

- Postgres came up healthy on 5434; migrations, seed (12 posts) all clean.
- **Corpus:** Wikimedia's `upload.wikimedia.org` anonymous download limiter returned HTTP 429
  for long stretches. The first naive fetch collapsed to 13 images / 2 groups. `fetch_corpus.js`
  was rewritten with a per-request throttle + capped exponential backoff that *honours* transient
  429s but *skips* persistent ones after bounded retries; a rebuild then accumulated **35 images
  across 5 groups** (fox/wolf/dog/bear/deer) as the limiter's rolling windows opened. `city
  skyline` still got 0 — a real external blocker, documented as NOT VERIFIED rather than faked.
  A `ensureDirs` cleanup was added so a rebuild never leaves stale images mismatched against the
  regenerated manifest/golden labels.
- **Ingestion:** Gemini's free-tier **daily request quota** throttled vision hard — ~1 extra
  image cleared per several-minute window across three `npm run ingest` passes, leaving
  **20 done / 15 failed**. Crucially the failures are recorded per-call with `success=false`,
  cost stayed **$0.0194 of $1.00**, the **budget guard never fired**, already-done images were
  skipped on every re-run, and **no duplicate rows or re-embeddings** occurred (35 rows,
  0 duplicate sha256, 20 vectors). Idempotency of completed work is proven both live and in
  `ingest.test.js`; only the quota-failed images are legitimately re-queued.
- **Eval + all API probes** ran green against the 20 ingested images (embeddings cached, so the
  refined eval cost nothing extra). Server started, every acceptance probe exercised with real
  HTTP, and graceful shutdown (SIGTERM → drain → close pool) verified.

## Final counts (as run)

- Tests: **46 pass, 0 fail**, all offline.
- Corpus: **35 images**, 5 animal groups, provenance in `manifest.json`.
- Ingested: **20 done / 15 failed (quota)**.
- Eval: **top-1 group accuracy 100% (6/6)**, exact-file top-1 16.7%, top-3 recall 66.7%,
  correct refusals **3/3**, skipped 3, failed 0.
- Tracked cost: **$0.0194** (actual $0, free tier); budget never breached.

## What remains genuinely limited

- The eval set is small and its exact-file goldens are somewhat arbitrary within a category.
- Thresholds (0.72 / 0.70 / 0.40) are tuned to *this* corpus, not universal.
- Taxonomy covers only the seeded groups; anything outside is flagged, not auto-rejected.
- Full ingestion and the `city skyline` group are blocked by external quotas, not code.
