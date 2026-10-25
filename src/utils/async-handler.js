'use strict';

// Wrap an async route so a thrown error (or rejected promise) reaches the central
// error handler instead of hanging the request. Express 4 does not do this natively.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
