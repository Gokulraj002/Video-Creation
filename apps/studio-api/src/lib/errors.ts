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

export const notFound = (what = 'Resource'): AppError => new AppError(404, 'NOT_FOUND', `${what} not found`);

export const unauthorized = (message = 'Missing or invalid bearer token'): AppError =>
  new AppError(401, 'UNAUTHORIZED', message);

export const conflict = (code: string, message: string, details?: unknown): AppError =>
  new AppError(409, code, message, details);
