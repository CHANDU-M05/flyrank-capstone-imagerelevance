'use strict';

// Deterministic, case-insensitive taxonomy of subject aliases -> canonical group.
//
// This map is deliberately small and explicit. It is the single source of truth
// for "what group is this subject in", shared by the mismatch guard and the
// vision-output normalizer so both agree. Two things it deliberately does NOT do:
//
//   1. It does not merge species that merely sound alike or are closely related.
//      `coyote` is its own group, NOT folded into `wolf`; `dog` is NOT `fox`.
//      A red fox post and a wolf image are different groups -> that is the whole
//      point of the guard.
//   2. It does not invent a group for unknown subjects. An unrecognized subject
//      resolves to `null`, which the guard treats as "no taxonomy signal" and
//      falls through to the similarity/confidence rules (a weaker guarantee, and
//      documented as a limitation).
//
// Matching is on normalized whole-phrase equality (lowercased, punctuation and
// article noise stripped), plus a word-boundary substring fallback for phrases
// like "a red fox kit" so a descriptive subject string still resolves.

// Each entry: canonical group -> array of aliases (already lowercase).
const TAXONOMY = {
  fox: ['fox', 'red fox', 'vulpes', 'vulpes vulpes', 'fox kit', 'red foxes'],
  wolf: ['wolf', 'gray wolf', 'grey wolf', 'canis lupus', 'timber wolf', 'wolfs', 'wolves'],
  coyote: ['coyote', 'canis latrans'],
  dog: ['dog', 'domestic dog', 'canis familiaris', 'puppy', 'dogs'],
  bear: ['bear', 'brown bear', 'grizzly', 'grizzly bear', 'ursus arctos'],
  deer: ['deer', 'white-tailed deer', 'whitetail deer', 'venison', 'fawn'],
  // Non-animal controls so out-of-scope posts refuse rather than grab wildlife.
  'city skyline': ['city skyline', 'skyline', 'city', 'urban skyline', 'downtown'],
  'coffee cup': ['coffee cup', 'cup of coffee', 'coffee', 'espresso', 'mug'],
};

// Normalize a free-text subject/phrase: lowercase, strip punctuation, drop
// leading articles and filler words, collapse whitespace.
function normalize(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(a|an|the|with|and|of|in|on|at)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Resolve any subject string to a canonical group, or null if unknown.
// Order matters: check exact normalized alias match first (fast, unambiguous),
// then a word-boundary substring scan across groups in map order.
function resolveGroup(subject) {
  const norm = normalize(subject);
  if (!norm) return null;

  for (const [group, aliases] of Object.entries(TAXONOMY)) {
    if (aliases.includes(norm)) return group;
  }

  // Substring fallback: "a red fox kit in forest" normalized contains "red fox".
  // Prefer the longest matching alias so "red fox" wins over "fox" if both apply
  // within the same group anyway; across groups, longer (more specific) aliases
  // are checked first to avoid "wild dog" matching "wild" partials incorrectly.
  const candidates = [];
  for (const [group, aliases] of Object.entries(TAXONOMY)) {
    for (const alias of aliases) {
      const boundary = new RegExp(`(^|\\s)${alias.replace(/\s+/g, '\\s')}(\\s|$)`);
      if (boundary.test(norm)) candidates.push({ group, len: alias.length });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.len - a.len);
  return candidates[0].group;
}

// True when the two subjects resolve to two *different, known* groups.
// Unknown (null) on either side is NOT a conflict — it is "no taxonomy signal".
function groupsConflict(subjectA, subjectB) {
  const a = resolveGroup(subjectA);
  const b = resolveGroup(subjectB);
  if (a === null || b === null) return false;
  return a !== b;
}

module.exports = { TAXONOMY, normalize, resolveGroup, groupsConflict };
