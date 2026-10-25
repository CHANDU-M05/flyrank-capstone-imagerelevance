'use strict';

// The mismatch guard: the decision core of this capstone.
//
// It is a PURE module — no database, no network, no AI calls, no env reads. All
// thresholds and the candidate's vision data are passed in, so the guard is fully
// deterministic and unit-testable in isolation. The caller (routes / eval) gathers
// the inputs; the guard only decides.
//
// Decision order and precedence (first match wins, documented in DESIGN.md §5):
//
//   1. Taxonomy-group conflict            -> rejected  (beats similarity)
//   2. Low-confidence unsupported subject -> rejected
//   3. Insufficient semantic similarity   -> rejected  ("no confident match")
//   4. Low but not disqualifying confidence -> flagged (never auto-accepted)
//   5. Candidate subject not in taxonomy  -> flagged   (cannot auto-accept what
//                                                        we cannot categorize)
//   6. Otherwise                          -> suggested
//
// Three numbers stay distinct on purpose:
//   - similarity          : how close the image vector is to the post vector
//   - confidence          : how sure the vision model is about the subject
//   - threshold           : where WE cut "close enough" off (tuned on the eval set)

const { resolveGroup, normalize } = require('./taxonomy');

// Groups considered animals — used only to phrase the mismatch reason naturally.
const ANIMAL_GROUPS = new Set(['fox', 'wolf', 'coyote', 'dog', 'bear', 'deer']);

// Canonical, human-facing label for a group (fox -> "fox").
function label(group) {
  return group;
}

// Does the candidate's caption or any attribute corroborate a claimed group?
// Used by rule 2: a low-confidence subject is not automatically rejected if the
// free-text caption/attributes independently support the same group.
function groupCorroborated(group, candidateVision) {
  if (!group) return false;
  const haystacks = [candidateVision.caption, ...(candidateVision.attributes || [])]
    .filter((s) => typeof s === 'string')
    .map(normalize);
  const aliases = require('./taxonomy').TAXONOMY[group] || [group];
  return haystacks.some((h) =>
    aliases.some((alias) => new RegExp(`(^|\\s)${alias.replace(/\s+/g, '\\s')}(\\s|$)`).test(h))
  );
}

// Resolve the candidate's group. Prefer the pre-normalized `group` the vision
// service stored (it re-derived it from subjects via the shared taxonomy map),
// and fall back to resolving from the raw subject string.
function candidateGroup(candidateVision) {
  if (candidateVision.group) return candidateVision.group;
  const subject = candidateVision.subject || (candidateVision.subjects || [])[0];
  return resolveGroup(subject);
}

function mismatchReason(postGroup, candGroup) {
  const bothAnimals = ANIMAL_GROUPS.has(postGroup) && ANIMAL_GROUPS.has(candGroup);
  const prefix = bothAnimals ? 'Animal category mismatch' : 'Category mismatch';
  return `${prefix}: expected ${label(postGroup)}, detected ${label(candGroup)}`;
}

/**
 * @param {Object} input
 * @param {string} input.postSubject          subject/topic text of the post
 * @param {string} [input.postCategory]       optional post category hint
 * @param {Object} input.candidateVision      normalized vision output for the image
 * @param {number} input.similarity           cosine similarity in [-1, 1]
 * @param {number} input.threshold            SIMILARITY_THRESHOLD
 * @param {number} input.confidenceThreshold  CONFIDENCE_THRESHOLD (flag floor)
 * @param {number} [input.rejectConfidence]   GUARD_CONFIDENCE_REJECT (hard floor)
 * @returns {{ accept: boolean, decision: 'suggested'|'flagged'|'rejected', reasons: string[] }}
 */
function evaluate(input) {
  const {
    postSubject,
    candidateVision,
    similarity,
    threshold,
    confidenceThreshold,
    rejectConfidence = 0.4,
  } = input;

  const reasons = [];
  if (!candidateVision || typeof candidateVision !== 'object') {
    return { accept: false, decision: 'rejected', reasons: ['No vision metadata for candidate'] };
  }

  const postGroup = resolveGroup(postSubject);
  const candGroup = candidateGroup(candidateVision);
  const confidence = Number(candidateVision.confidence);
  const sim = Number(similarity);

  // Rule 1 — taxonomy-group conflict is a hard reject and beats any similarity.
  if (postGroup !== null && candGroup !== null && postGroup !== candGroup) {
    reasons.push(mismatchReason(postGroup, candGroup));
    return { accept: false, decision: 'rejected', reasons };
  }

  // Rule 2 — low-confidence subject that nothing else supports.
  if (Number.isFinite(confidence) && confidence < rejectConfidence) {
    const supported = groupCorroborated(candGroup, candidateVision);
    if (!supported) {
      reasons.push(
        `Low-confidence subject (${confidence.toFixed(2)} < ${rejectConfidence}) with no corroborating caption or attributes`
      );
      return { accept: false, decision: 'rejected', reasons };
    }
  }

  // Rule 3 — insufficient semantic similarity.
  if (!Number.isFinite(sim) || sim < threshold) {
    const shown = Number.isFinite(sim) ? sim.toFixed(2) : 'n/a';
    reasons.push(`No confident match: similarity ${shown} < threshold ${threshold}`);
    return { accept: false, decision: 'rejected', reasons };
  }

  // Rule 4 — acceptable match but shaky subject confidence -> flag for a human.
  if (Number.isFinite(confidence) && confidence < confidenceThreshold) {
    reasons.push(
      `Flagged for review: vision confidence ${confidence.toFixed(2)} < ${confidenceThreshold}`
    );
    return { accept: false, decision: 'flagged', reasons };
  }

  // Rule 5 — the candidate's subject is not in our taxonomy, so we cannot positively
  // confirm it belongs to the post's category. Similarity alone is not enough to
  // auto-recommend an uncategorizable image; send it to a human instead. (Without
  // this, a null-group image slips past rule 1 for any post and gets accepted on a
  // permissive similarity threshold.)
  if (candGroup === null) {
    reasons.push(
      `Flagged for review: candidate subject "${candidateVision.subject || (candidateVision.subjects || [])[0] || 'unknown'}" is not a recognized category`
    );
    return { accept: false, decision: 'flagged', reasons };
  }

  // Rule 6 — clear the bar.
  reasons.push(`Matched: similarity ${sim.toFixed(2)} ≥ ${threshold}, confidence ${confidence.toFixed(2)} ≥ ${confidenceThreshold}`);
  return { accept: true, decision: 'suggested', reasons };
}

module.exports = { evaluate, ANIMAL_GROUPS };
