import 'server-only';

import { DbIdSchema } from '@vc/schema';
import { proxyStatusFor, publicFailureMessage } from './api-failure';
import { isStudioApiError } from './studio-api';

/**
 * Helpers for the same-origin route handlers the browser calls (`/api/...`). They proxy the Studio API server-side
 * (the token never reaches the browser) and only ever return generic / user-facing messages: internal details
 * (base URL, network errors, schema issues) are logged by `studio-api.ts`, never sent to the client.
 */

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function jsonOk(body: unknown): Response {
  return Response.json(body, { headers: NO_STORE });
}

export function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: NO_STORE });
}

/** Browser-safe JSON error for anything thrown while handling `context` (e.g. `GET /api/runs/:id`). */
export function errorResponse(error: unknown, context: string): Response {
  if (isStudioApiError(error)) {
    const failure = error.toFailure();
    return jsonError(proxyStatusFor(failure), failure.code, publicFailureMessage(failure));
  }
  console.error(`[web] ${context} failed:`, error);
  return jsonError(500, 'INTERNAL', 'Something went wrong. Please try again.');
}

/** Database id safe to interpolate into an API path. */
export function isValidId(id: string): boolean {
  return DbIdSchema.safeParse(id).success && /^[A-Za-z0-9_-]+$/.test(id);
}

/** Positive integer version from a path segment, or `null`. */
export function parseVersionParam(raw: string): number | null {
  return /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : null;
}
