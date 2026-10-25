'use strict';

// Convenience re-export so scripts (eval.js) and tests can import the pure cosine
// helper from utils without reaching into services. Single implementation lives in
// src/services/matching.js to keep one source of truth.
const { cosineSimilarity, rankImages } = require('../services/matching');

module.exports = { cosineSimilarity, rankImages };
