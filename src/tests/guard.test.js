'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../services/guard');
const { resolveGroup, groupsConflict } = require('../services/taxonomy');

const THRESHOLD = 0.72;
const CONF = 0.7;
const REJECT_CONF = 0.4;

function foxVision(extra = {}) {
  return {
    subject: 'red fox',
    group: 'fox',
    category: 'animal',
    caption: 'A red fox standing at the edge of a forest',
    attributes: ['orange fur', 'wild', 'forest'],
    confidence: 0.94,
    ...extra,
  };
}

test('taxonomy: aliases resolve to canonical groups', () => {
  assert.equal(resolveGroup('Vulpes vulpes'), 'fox');
  assert.equal(resolveGroup('red fox'), 'fox');
  assert.equal(resolveGroup('a RED Fox kit in the forest'), 'fox');
  assert.equal(resolveGroup('Gray Wolf'), 'wolf');
  assert.equal(resolveGroup('canis lupus'), 'wolf');
  assert.equal(resolveGroup('coyote'), 'coyote');
  assert.equal(resolveGroup('domestic dog'), 'dog');
  assert.equal(resolveGroup('unknown creature'), null);
});

test('taxonomy: coyote is NOT merged into wolf, dog is NOT fox', () => {
  assert.ok(groupsConflict('red fox', 'coyote')); // fox vs coyote differ
  assert.ok(groupsConflict('coyote', 'gray wolf')); // coyote vs wolf differ
  assert.ok(groupsConflict('red fox', 'domestic dog')); // fox vs dog differ
  assert.equal(resolveGroup('coyote'), 'coyote');
});

test('rule 1: wolf candidate on a fox post -> hard reject with exact reason, beating high similarity', () => {
  const res = guard.evaluate({
    postSubject: 'the behavior of red foxes',
    candidateVision: {
      subject: 'gray wolf',
      group: 'wolf',
      category: 'animal',
      caption: 'A gray wolf in the forest',
      attributes: ['gray fur', 'wild'],
      confidence: 0.95,
    },
    similarity: 0.9, // very similar in vector space...
    threshold: THRESHOLD,
    confidenceThreshold: CONF,
    rejectConfidence: REJECT_CONF,
  });
  assert.equal(res.decision, 'rejected');
  assert.equal(res.accept, false);
  assert.deepEqual(res.reasons, ['Animal category mismatch: expected fox, detected wolf']);
});

test('rule 1 does not fire when either side is an unknown subject (falls through)', () => {
  const res = guard.evaluate({
    postSubject: 'an entirely novel animal nobody has named',
    candidateVision: foxVision(),
    similarity: 0.8,
    threshold: THRESHOLD,
    confidenceThreshold: CONF,
    rejectConfidence: REJECT_CONF,
  });
  // Post group resolves to null -> no conflict -> similarity path -> suggested.
  assert.equal(res.decision, 'suggested');
});

test('rule 3: sub-threshold similarity -> no confident match', () => {
  const res = guard.evaluate({
    postSubject: 'red fox',
    candidateVision: foxVision(),
    similarity: 0.5,
    threshold: THRESHOLD,
    confidenceThreshold: CONF,
    rejectConfidence: REJECT_CONF,
  });
  assert.equal(res.decision, 'rejected');
  assert.match(res.reasons.join(' '), /no confident match/i);
});

test('rule 2: very low confidence with no corroboration -> rejected', () => {
  const res = guard.evaluate({
    postSubject: 'red fox',
    candidateVision: foxVision({
      confidence: 0.2,
      caption: 'some blurry shape',
      attributes: ['unknown'],
    }),
    similarity: 0.9,
    threshold: THRESHOLD,
    confidenceThreshold: CONF,
    rejectConfidence: REJECT_CONF,
  });
  assert.equal(res.decision, 'rejected');
  assert.match(res.reasons.join(' '), /Low-confidence subject/);
});

test('rule 2 is bypassed when caption corroborates the group, then rule 4 flags it', () => {
  const res = guard.evaluate({
    postSubject: 'red fox',
    candidateVision: foxVision({
      confidence: 0.3, // below reject floor...
      caption: 'A red fox cub playing in snow', // ...but caption supports "red fox"
      attributes: ['red fox'],
    }),
    similarity: 0.9,
    threshold: THRESHOLD,
    confidenceThreshold: CONF,
    rejectConfidence: REJECT_CONF,
  });
  // Corroborated -> not hard-rejected by rule 2; confidence < 0.7 -> flagged.
  assert.equal(res.decision, 'flagged');
});

test('rule 4: confidence between reject floor and review floor -> flagged, never accepted', () => {
  const res = guard.evaluate({
    postSubject: 'red fox',
    candidateVision: foxVision({ confidence: 0.2 }), // 0.2 but corroborated caption keeps it from rule 2
    similarity: 0.9,
    threshold: THRESHOLD,
    confidenceThreshold: CONF,
    rejectConfidence: 0.15, // reject floor lowered so rule 2 does not fire
  });
  assert.equal(res.decision, 'flagged');
  assert.equal(res.accept, false);
});

test('rule 5: strong similarity and confidence -> suggested', () => {
  const res = guard.evaluate({
    postSubject: 'red fox',
    candidateVision: foxVision(),
    similarity: 0.85,
    threshold: THRESHOLD,
    confidenceThreshold: CONF,
    rejectConfidence: REJECT_CONF,
  });
  assert.equal(res.decision, 'suggested');
  assert.equal(res.accept, true);
});

test('Vulpes vulpes post accepts a qualifying fox candidate', () => {
  const res = guard.evaluate({
    postSubject: 'Vulpes vulpes: the red fox',
    candidateVision: foxVision(),
    similarity: 0.88,
    threshold: THRESHOLD,
    confidenceThreshold: CONF,
    rejectConfidence: REJECT_CONF,
  });
  assert.equal(res.decision, 'suggested');
});

test('non-animal controls: coffee post vs city skyline image -> category mismatch', () => {
  const res = guard.evaluate({
    postSubject: 'the perfect espresso',
    candidateVision: {
      subject: 'city skyline',
      group: 'city skyline',
      category: 'urban',
      caption: 'Downtown skyline at dusk',
      attributes: ['buildings'],
      confidence: 0.9,
    },
    similarity: 0.8,
    threshold: THRESHOLD,
    confidenceThreshold: CONF,
    rejectConfidence: REJECT_CONF,
  });
  assert.equal(res.decision, 'rejected');
  assert.match(res.reasons[0], /expected coffee cup, detected city skyline/);
});

test('rule 5: an uncategorizable candidate (null group) is flagged, never auto-suggested, even on high similarity', () => {
  const res = guard.evaluate({
    postSubject: 'city skyline architecture',
    candidateVision: {
      subject: 'some unclassified blob',
      group: null,
      category: 'other',
      caption: 'Ambiguous structure',
      attributes: [],
      confidence: 0.9,
    },
    similarity: 0.88, // clears the similarity threshold on purpose
    threshold: THRESHOLD,
    confidenceThreshold: CONF,
    rejectConfidence: REJECT_CONF,
  });
  assert.equal(res.decision, 'flagged');
  assert.equal(res.accept, false);
  assert.match(res.reasons.join(' '), /not a recognized category/);
});

test('rule 5 does not demote a genuine same-group high-confidence match', () => {
  const res = guard.evaluate({
    postSubject: 'red fox',
    candidateVision: foxVision(), // group 'fox' is known
    similarity: 0.9,
    threshold: THRESHOLD,
    confidenceThreshold: CONF,
    rejectConfidence: REJECT_CONF,
  });
  assert.equal(res.decision, 'suggested');
});

test('missing candidate vision -> rejected, no throw', () => {
  const res = guard.evaluate({
    postSubject: 'red fox',
    candidateVision: null,
    similarity: 0.9,
    threshold: THRESHOLD,
    confidenceThreshold: CONF,
  });
  assert.equal(res.decision, 'rejected');
});
