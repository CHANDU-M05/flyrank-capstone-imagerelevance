'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { cosineSimilarity, rankImages } = require('../services/matching');
const reexport = require('../utils/cosine');

test('cosine re-export exposes the same functions', () => {
  assert.equal(reexport.cosineSimilarity, cosineSimilarity);
  assert.equal(reexport.rankImages, rankImages);
});

test('identical vectors -> 1', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
});

test('orthogonal vectors -> 0', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
});

test('opposite vectors -> -1', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 1], [-1, -1]) + 1) < 1e-9);
});

test('zero vector -> 0 (no direction, not NaN)', () => {
  assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
});

test('dimension mismatch -> NaN', () => {
  assert.ok(Number.isNaN(cosineSimilarity([1, 2], [1, 2, 3])));
});

test('non-array inputs -> NaN', () => {
  assert.ok(Number.isNaN(cosineSimilarity(null, [1])));
  assert.ok(Number.isNaN(cosineSimilarity('x', [1])));
});

test('invalid numeric values -> NaN', () => {
  assert.ok(Number.isNaN(cosineSimilarity([1, NaN], [1, 1])));
  assert.ok(Number.isNaN(cosineSimilarity([1, Infinity], [1, 1])));
});

test('rankImages orders by similarity desc', () => {
  const post = [1, 0, 0];
  const candidates = [
    { imageId: 'b', embedding: [0, 1, 0] }, // orthogonal -> 0
    { imageId: 'a', embedding: [1, 0, 0] }, // identical -> 1
    { imageId: 'c', embedding: [0.7, 0.7, 0] }, // partial
  ];
  const ranked = rankImages(post, candidates, 3);
  assert.deepEqual(ranked.map((r) => r.imageId), ['a', 'c', 'b']);
});

test('rankImages ties break deterministically on imageId ascending', () => {
  const post = [1, 0];
  const candidates = [
    { imageId: 'z', embedding: [1, 0] },
    { imageId: 'm', embedding: [1, 0] },
    { imageId: 'a', embedding: [1, 0] },
  ];
  const ranked = rankImages(post, candidates, 3);
  assert.deepEqual(ranked.map((r) => r.imageId), ['a', 'm', 'z']);
});

test('rankImages bounds result to topK', () => {
  const post = [1, 0];
  const candidates = [
    { imageId: '1', embedding: [1, 0] },
    { imageId: '2', embedding: [1, 0] },
    { imageId: '3', embedding: [1, 0] },
  ];
  assert.equal(rankImages(post, candidates, 2).length, 2);
});

test('rankImages pushes NaN-similarity candidates to the end', () => {
  const post = [1, 0];
  const candidates = [
    { imageId: 'bad', embedding: [1, 0, 0] }, // dim mismatch -> NaN
    { imageId: 'good', embedding: [1, 0] }, // 1.0
  ];
  const ranked = rankImages(post, candidates, 2);
  assert.deepEqual(ranked.map((r) => r.imageId), ['good', 'bad']);
});

test('rankImages with non-array candidates returns []', () => {
  assert.deepEqual(rankImages([1, 0], undefined, 3), []);
});
