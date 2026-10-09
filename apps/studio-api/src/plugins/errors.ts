import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface ValidationIssueDetail {
  path: string;
  message: string;
  code: string;
}

export function zodIssues(error: ZodError): ValidationIssueDetail[] {
  return error.issues.slice(0, 100).map((issue) => ({
    path: issue.path.map((p) => String(p)).join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

function send(reply: FastifyReply, statusCode: number, body: ErrorBody): FastifyReply {
  return reply.status(statusCode).type('application/json; charset=utf-8').send(body);
}

function isFastifyError(error: unknown): error is FastifyError {
  return error instanceof Error && typeof (error as Partial<FastifyError>).statusCode === 'number';
}

/** Maps Fastify's own client errors (body parsing, size, content type) onto stable codes. */
function fastifyClientErrorCode(error: FastifyError): string {
  switch (error.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return 'PAYLOAD_TOO_LARGE';
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
      return 'INVALID_BODY';
    default:
      break;
  }
  if (error instanceof SyntaxError) return 'INVALID_BODY';
  switch (error.statusCode) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 405:
      return 'METHOD_NOT_ALLOWED';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'BAD_REQUEST';
  }
}

/**
 * Uniform error envelope: `{error: {code, message, details?}}`.
 * ZodError → 400 VALIDATION_ERROR (with issues); AppError → its status/code; Fastify 4xx → mapped code;
 * anything else → 500 INTERNAL with a generic message (never a stack trace).
 */
export const errorsPlugin = fp(
  async (app: FastifyInstance) => {
    app.setErrorHandler((error: unknown, request, reply) => {
      if (error instanceof AppError) {
        if (error.statusCode >= 500) request.log.error({ err: error }, 'request failed');
        const body: ErrorBody = { error: { code: error.code, message: error.message } };
        if (error.details !== undefined) body.error.details = error.details;
        return send(reply, error.statusCode, body);
      }
      if (error instanceof ZodError) {
        return send(reply, 400, {
          error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: zodIssues(error) },
        });
      }
      if (isFastifyError(error) && error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
        return send(reply, error.statusCode, {
          error: { code: fastifyClientErrorCode(error), message: error.message },
        });
      }
      request.log.error({ err: error }, 'unhandled error');
      return send(reply, 500, { error: { code: 'INTERNAL', message: 'Internal server error' } });
    });

    app.setNotFoundHandler((request, reply) =>
      send(reply, 404, { error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url.split('?')[0] ?? ''} not found` } }),
    );
  },
  { name: 'studio-errors' },
);
