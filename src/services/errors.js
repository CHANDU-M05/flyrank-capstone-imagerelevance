'use strict';

// Typed errors so callers can distinguish "stop spending" from "retry" from
// "input is bad". Message strings are safe to surface/log — they never contain
// the API key or raw provider bodies.

class BudgetExceededError extends Error {
  constructor({ projected, spent, budget }) {
    super(
      `Budget guard: projected call ($${Number(projected).toFixed(6)}) on top of spent ` +
        `($${Number(spent).toFixed(6)}) would exceed budget $${Number(budget).toFixed(2)}`
    );
    this.name = 'BudgetExceededError';
    this.code = 'BUDGET_EXCEEDED';
    this.projected = projected;
    this.spent = spent;
    this.budget = budget;
  }
}

// A provider call failed. `retryable` tells the batch job whether to try again.
class ProviderError extends Error {
  constructor(message, { status = null, retryable = false, kind = 'unknown' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = 'PROVIDER_ERROR';
    this.status = status;
    this.retryable = retryable;
    this.kind = kind;
  }
}

// Model output that did not match our schema — a permanent input/quality error,
// not something a blind retry will fix (though the batch may re-ask the model).
class SchemaValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'SchemaValidationError';
    this.code = 'SCHEMA_INVALID';
    this.issues = issues;
  }
}

module.exports = { BudgetExceededError, ProviderError, SchemaValidationError };
