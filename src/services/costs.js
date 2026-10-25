'use strict';

// Cost computation and recording.
//
// The pure functions (computeVisionCost, computeEmbeddingCost) have no I/O and are
// unit-tested directly. recordCost / totalSpent take a database handle (the pg pool
// or a fake) so tests can inject one without a real Postgres.
//
// Pricing model: gemini-2.5-flash bills output "including thinking tokens" (per the
// official pricing table), so we bill (candidates + thoughts) at the OUTPUT rate and
// never count thinking tokens as free. Rates come from env and are operator-adjustable.

function computeVisionCost(usage, { priceInPerM, priceOutPerM }) {
  const prompt = Number(usage.promptTokenCount || 0);
  const candidates = Number(usage.candidatesTokenCount || 0);
  const thoughts = Number(usage.thoughtsTokenCount || 0);
  const inUsd = (prompt / 1e6) * priceInPerM;
  const outUsd = ((candidates + thoughts) / 1e6) * priceOutPerM;
  return {
    tokens_in: prompt,
    tokens_out: candidates,
    tokens_thinking: thoughts,
    usd: Number((inUsd + outUsd).toFixed(10)),
  };
}

function computeEmbeddingCost(tokenCount, { pricePerM }) {
  const tokens = Number(tokenCount || 0);
  return {
    tokens_in: tokens,
    usd: Number(((tokens / 1e6) * pricePerM).toFixed(10)),
  };
}

// Insert one cost row. `db` is anything with .query(text, params).
async function recordCost(db, row) {
  const res = await db.query(
    `INSERT INTO costs
       (kind, model, provider, image_id, post_id, tokens_in, tokens_out, tokens_thinking, usd, latency_ms, success, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id, usd`,
    [
      row.kind,
      row.model,
      row.provider || 'gemini',
      row.image_id || null,
      row.post_id || null,
      row.tokens_in ?? null,
      row.tokens_out ?? null,
      row.tokens_thinking ?? null,
      row.usd ?? 0,
      row.latency_ms ?? null,
      row.success !== false,
      row.error || null,
    ]
  );
  return res.rows[0];
}

// Total accrued USD across every recorded call (used by the budget guard).
async function totalSpent(db) {
  const res = await db.query(`SELECT COALESCE(SUM(usd), 0)::numeric AS spent FROM costs`);
  return Number(res.rows[0].spent);
}

module.exports = { computeVisionCost, computeEmbeddingCost, recordCost, totalSpent };
