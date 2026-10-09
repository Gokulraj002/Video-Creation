/** An error that maps 1:1 onto the `{error: {code, message, details?}}` HTTP envelope. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * A stored row failed validation on read (corrupt or incompatible data). Answered as 500 DATA_INTEGRITY with
 * a generic message; the entity, id and validation issues go to the server log only.
 */
export class DataIntegrityError extends AppError {
  constructor(
    readonly entity: string,
    readonly entityId: string,
    readonly issues: readonly string[],
  ) {
    super(500, 'DATA_INTEGRITY', 'Stored data could not be read; the problem has been logged');
    this.name = 'DataIntegrityError';
  }
}

export const notFound = (what = 'Resource'): AppError => new AppError(404, 'NOT_FOUND', `${what} not found`);

export const unauthorized = (message = 'Missing or invalid bearer token'): AppError =>
  new AppError(401, 'UNAUTHORIZED', message);

export const conflict = (code: string, message: string, details?: unknown): AppError =>
  new AppError(409, code, message, details);

export const rateLimited = (retryAfterSeconds: number): AppError =>
  new AppError(429, 'RATE_LIMITED', `Rate limit exceeded, retry in ${Math.max(1, retryAfterSeconds)} s`);
