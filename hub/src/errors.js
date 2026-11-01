// Errors a route may show to staff. Anything else becomes a generic failure.
export class HubError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export const forbidden = (message = 'You do not have permission to do that.') => new HubError(403, 'forbidden', message);
export const notFound = (message = 'That record was not found.') => new HubError(404, 'not_found', message);
export const conflict = message => new HubError(409, 'conflict', message);
export const unavailable = message => new HubError(503, 'not_configured', message);
export const invalid = (fields, message = 'Please correct the highlighted fields.') =>
  new HubError(422, 'validation_failed', message, fields);
