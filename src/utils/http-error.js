'use strict';

// An HTTP-aware error. `status` drives the response code; `expose` decides whether
// the message is safe to show a client (true for our own 4xx/409 messages, false for
// unexpected internal errors, which get a generic 500).
class HttpError extends Error {
  constructor(status, message, { expose = true, code = null, details = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.expose = expose;
    this.code = code;
    this.details = details;
  }
  static badRequest(msg, opts) {
    return new HttpError(400, msg, opts);
  }
  static notFound(msg = 'Resource not found', opts) {
    return new HttpError(404, msg, opts);
  }
  static conflict(msg, opts) {
    return new HttpError(409, msg, opts);
  }
}

module.exports = { HttpError };
