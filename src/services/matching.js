'use strict';

// Pure semantic-ranking helpers. No I/O — vectors and candidates are passed in.

// Cosine similarity between two equal-length numeric vectors.
// Returns a value in [-1, 1]. Guards the degenerate cases explicitly:
//   - non-array / length mismatch / empty      -> NaN  (caller treats as no signal)
//   - either vector all-zero (magnitude 0)      -> 0    (orthogonal-by-convention)
//   - any non-finite entry                       -> NaN  (refuse to rank garbage)
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return NaN;
  if (a.length === 0 || b.length !== a.length) return NaN;

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return NaN;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// Rank candidate images for a post vector.
//   postVector: number[]
//   candidates: [{ imageId, embedding: number[], ...meta }]
//   topK:       integer > 0 (bounds the result length)
// Deterministic ordering: similarity descending, then imageId ascending so ties
// are stable across runs. Non-finite similarity (bad/dim-mismatched vectors) sorts
// last and is kept only if within topK.
function rankImages(postVector, candidates, topK) {
  if (!Array.isArray(candidates)) return [];
  const k = Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : candidates.length;

  const scored = candidates.map((c) => ({
    ...c,
    similarity: cosineSimilarity(postVector, c.embedding),
  }));

  scored.sort((x, y) => {
    const sx = Number.isFinite(x.similarity) ? x.similarity : -Infinity;
    const sy = Number.isFinite(y.similarity) ? y.similarity : -Infinity;
    if (sy !== sx) return sy - sx;
    // Tie-break on imageId ascending for deterministic output.
    return String(x.imageId).localeCompare(String(y.imageId));
  });

  return scored.slice(0, k);
}

module.exports = { cosineSimilarity, rankImages };
