# EVIDENCE

One real, pasted, credential-redacted transcript per acceptance check, from a single live
run on **2026-10-25**. No secrets appear in any output (the Gemini key was never printed).
Anything not achievable in this environment is marked **NOT VERIFIED** with its blocker.

---

## 1. Environment & dependencies

```
node v26.11.1 | npm 12.2.0
GEMINI_API_KEY set in .env: yes            (value never printed)
02-ai-image-matching-db-1   Up (healthy)   postgres:16-alpine  0.0.0.0:5434->5432/tcp
PostgreSQL 16.15 on x86_64-pc-linux-musl
public tables: schema_migrations, images, image_vectors, posts, suggestions,
               reviews, jobs, job_items, costs, eval_results
```

## 2. Migrations

```
$ npm run migrate
[migrate] applying 001_init.sql
[migrate] applied 1 migration(s)
```

## 3. Seed

```
$ npm run seed
[seed] upserted 12 post(s)
```

## 4. Corpus build + label audit + golden pairs

```
$ npm run corpus
[corpus] using ImageMagick: magick
=== LABEL AUDIT (verify each title->group before trusting) ===
fox 8 | wolf 8 | dog 8 | bear 5 | deer 6 | city skyline 0
...
=== GOLDEN PAIRS (null = expected refusal) ===
red-fox-behavior   -> fox-vulpes-vulpes-laying-in-snow-1.jpg
gray-wolf-packs    -> wolf-eurasian-wolf-2-9.jpg
dog-training-basics-> dog-mixed-breed-dogs-in-serles-17.jpg
brown-bear-safety  -> bear-brown-bear-ursus-arctos-arctos-running-25.jpg
deer-in-the-garden -> deer-red-deer-stag-geograph-org-uk-7288404-30.jpg
city-skyline-architecture -> (no image: expect refusal)
espresso-brewing-guide    -> (no image: expect refusal)
tall-ships-maritime-history-> (no image: expect refusal)
[corpus] wrote 35 images (target 48).
```

Provenance (license + artist + source URL + Commons title) is recorded per file in
`corpus/manifest.json`. Every row in the audit is a real Wikimedia title whose resolved
group equals the folder group. **Shortfall note:** Wikimedia's `upload.wikimedia.org`
anonymous **download** rate-limiter (HTTP 429) truncated the build to 35 images across
5 animal groups; `city skyline` was not reachable this run. Reproducible by re-running.

## 5. Tests (offline, no spend)

```
$ npm test
ℹ tests 46
ℹ pass 46
ℹ fail 0
ℹ skipped 0
```

## 6. Ingestion result (budget-guarded, per-call costed)

```
$ npm run ingest           # run #1
[ingest] job 1272d417: 35 to process, 0 already done (skipped)
[ingest] done: 18 processed, 0 flagged, 17 failed, cost $0.017334 (completed)
```

The 17 failures are **Gemini free-tier quota** (`You exceeded your current quota`), recorded
per call with `success=false`. They stay re-queued. Later passes finished more:

```
$ npm run ingest           # run #3 (after quota window)
[ingest] job 33d0c1ab: 16 to process, 19 already done (skipped)
[ingest] done: 1 processed, 0 flagged, 15 failed, cost $0.001132 (completed)
```

Final ingested state: **20 `done` / 15 `failed`** across all five groups
(bear 5, dog 5, fox 4, wolf 3, deer 1, + 2 done with an unresolvable subject).

## 7. Idempotency

```
total image rows (expect 35, no dupes): 35
duplicate sha256 rows (expect 0): 0
vectors (expect = done count): 20
distinct done images with vectors: 20
```

Runs #2 and #3 skipped every already-`done` image ("19 already done (skipped)"), created
no duplicate rows, and re-embedded nothing (one vector per done image). The ideal "second
run processes 0" clean case is proven by `ingest.test.js` (`vision called exactly once
across both runs`); in the live run the only re-worked images are the quota-failed ones,
which are legitimately retried, not duplicated.

## 8. Fox post ranks fox images first (guard never cross-recommends)

```
$ curl 'localhost:3000/posts/<red-fox>/images?top=5'
overall: {"status":"match","message":"Recommended image available"}
embeddedFromCache: true
 rank1 fox-vulpes-vulpes-mallnitz-01-7.jpg   sim=0.8308 suggested :: Matched: similarity 0.83 ≥ 0.72, confidence 1.00 ≥ 0.7
 rank2 fox-red-fox-vulpes-vulpes-4-3.jpg     sim=0.8096 suggested :: Matched: ...
 rank3 fox-vulpes-vulpes-laying-in-snow-1.jpg sim=0.7965 suggested :: Matched: ...
 rank4 fox-red-fox-kit-3-vulpes-vulpes-4.jpg sim=0.7891 suggested :: Matched: ...
 rank5 wolf-...-african-wolf-...-14.jpg      sim=0.7831 flagged   :: Flagged for review: candidate subject "golden jackal" is not a recognized category
```

All four foxes are accepted; a wolf image is **not** suggested (its subject resolves to an
uncategorizable "golden jackal" → flagged), and a true wolf would be rejected — see §9.

## 9. Forced wolf on a fox post → rejected (guard cannot be bypassed)

```
$ curl 'localhost:3000/posts/<red-fox>/images?top=3&force_image_id=<wolf-image>'
{
  "filename": "wolf-gray-wolf-ssa-2023-16.jpg",
  "similarity": 0.7384,          // above the 0.72 threshold on purpose
  "visionConfidence": 0.98,      // high confidence on purpose
  "decision": "rejected",
  "reasons": ["Animal category mismatch: expected fox, detected wolf"],
  "source": "forced"
}
```

Even when force-submitted, similar, and high-confidence, the taxonomy conflict wins.

## 10. Out-of-scope post → refuses

```
$ curl 'localhost:3000/posts/<city-skyline>/images?top=5'
overall: {"status":"no_confident_match","message":"No confident match: no candidate cleared the guard"}
suggested count: 0
top rejected reason: Flagged for review: candidate subject "Siberian Husky" is not a recognized category
```

No city images exist, and no wildlife image is auto-suggested for a city article.

## 11. Review idempotency + conflict

```
-- 1st approve:        HTTP 201 {"review":{"action":"approved","note":"looks right",...},"idempotent":false}
-- 2nd approve (same): HTTP 200 {"review":{"action":"approved",...},"idempotent":true}
-- reject after approve:HTTP 409 {"error":{"code":"REVIEW_CONFLICT","message":"This pairing was already approved; reversing a review is not allowed"}}
-- reviews rows for that pairing: 1  ->  approved | looks right
```

## 12. Costs — every call attributed, budget never breached

```
$ curl 'localhost:3000/costs'
total_usd 0.0194225 | calls 212 | failed_calls 151 | budget 1 | remaining 0.9805775 | status ok
  kind=embedding model=gemini-embedding-001 calls=41 usd=0.00000000
  kind=vision    model=gemini-2.5-flash      calls=171 usd=0.01942250 tok_in=7800 tok_out=1790 tok_think=5043
```

Thinking tokens (`tok_think=5043`) are included in the vision cost at the output rate.
151 failed calls are the quota-throttled retries, each recorded with `usd=0`. Actual money
spent is $0 (free tier); $0.0194 is the paid-tier projection. **The budget guard never fired**
because spend stayed far below $1.00.

## 13. Evaluation + persisted `GET /eval`

```
$ npm run eval
=== EVALUATION ===
in-scope labeled posts : 6   out-of-scope controls : 3   skipped : 3   failed : 0
top-1 precision        : 16.7% (1/6)  [exact golden file]
top-1 group accuracy   : 100.0% (6/6)  [correct category]
top-3 recall           : 66.7% (4/6)
guard rejections       : 40   correct refusals : 3/3   runtime : 157 ms
threshold sweep (top-1 precision): 0.67 -> 16.7%  0.72 -> 16.7%  0.77 -> 16.7%
```

```
$ curl localhost:3000/eval
{ "run": { "dataset_posts": 6, "golden_ok": 1, "top1_precision": 0.1667,
  "top3_recall": 0.6667, "guard_rejections": 40, "correct_refusals": 3, "skipped": 3,
  "failed": 0,
  "thresholds": { "similarity": 0.72, "confidence": 0.7, "rejectConfidence": 0.4,
                  "topK": 8, "top1_group_accuracy": 1 } } }
```

The run persisted to `eval_results`; `GET /eval` returns the latest real run.

## 14. Health + invalid-UUID + unknown-id + unknown-route

```
$ curl localhost:3000/health
HTTP 200 {"status":"ok","db":"up","models":{"vision":"gemini-2.5-flash","embedding":"gemini-embedding-001"},"budget_usd":1,"uptime_s":50}
$ curl localhost:3000/images/not-a-uuid
HTTP 400 {"error":{"code":"INVALID_UUID","message":"Invalid image id: must be a UUID"}}
$ curl localhost:3000/posts/00000000-0000-0000-0000-000000000000
HTTP 404 {"error":{"code":"POST_NOT_FOUND","message":"Post not found"}}
$ curl localhost:3000/nope
HTTP 404 {"error":{"code":"NOT_FOUND","message":"Not found: GET /nope"}}
```

All errors are JSON; no HTML stack traces, no secrets.

## 15. Graceful shutdown

```
$ kill -TERM <server-pid>
[http] SIGTERM received, shutting down gracefully
[http] closed db pool; bye
```

Port 3000 then refuses connections (`HTTP 000`), confirming the HTTP server and `pg` pool
were both closed before exit.

---

## Not verified (external blocker)

- **Full ingestion (all 35 images to `done`) and a clean `processed: 0` idempotency re-run
  over the *live* corpus: NOT VERIFIED.** Blocker: **Gemini free-tier daily request quota**
  — only ~1 additional image cleared per several-minute window, leaving 15 images `failed`.
  The code path (skip already-done, no duplicate rows, bounded retry, budget-safe) is
  exercised and correct; it simply needs quota headroom to finish. Re-running `npm run
  ingest` after the quota resets completes it with no duplication.
- **The `city skyline` corpus group: NOT VERIFIED (0 images).** Blocker: Wikimedia
  download rate-limiting (HTTP 429). Its posts therefore evaluate as out-of-scope refusals.

## Submission posture

No `git init`, commit, push, publish, or deploy was performed. All changes are unstaged in
the monorepo working tree.
