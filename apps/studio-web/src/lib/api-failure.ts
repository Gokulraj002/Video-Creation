/**
 * Serializable description of a failed Studio API call. Produced server-side by `StudioApiError.toFailure()` and
 * safe to pass to Client Components (it never contains the token).
 */
export type ApiFailureKind =
  | 'not_configured'
  | 'unreachable'
  | 'unauthorized'
  | 'not_found'
  | 'invalid_response'
  | 'http';

export interface ApiFailure {
  kind: ApiFailureKind;
  /** HTTP status when a response was received. */
  status: number | null;
  /** API error code (`NOT_FOUND`, `RUN_ACTIVE`, `QUOTA_EXCEEDED`, …) or a client-side code. */
  code: string;
  message: string;
  /** Base URL the server tried to reach (not secret; helps diagnose connectivity). */
  apiUrl: string | null;
}

export interface FailureCopy {
  title: string;
  description: string;
  hint: string | null;
}

/** User-facing copy for a failure (used by the error-state component). */
export function describeFailure(failure: ApiFailure): FailureCopy {
  switch (failure.kind) {
    case 'not_configured':
      return {
        title: 'Studio API is not configured',
        description: failure.message,
        hint: 'Set STUDIO_API_URL and STUDIO_API_TOKEN in apps/studio-web/.env.local (see .env.example), then restart the web server.',
      };
    case 'unreachable':
      return {
        title: 'Can’t reach the Studio API',
        description: failure.apiUrl
          ? `No response from ${failure.apiUrl}. ${failure.message}`
          : failure.message,
        hint: 'Start it with `pnpm studio:dev:api` (and the worker with `pnpm studio:dev:worker` when QUEUE_DRIVER=bullmq).',
      };
    case 'unauthorized':
      return {
        title: 'The Studio API rejected the access token',
        description: failure.message,
        hint: 'Check that STUDIO_API_TOKEN matches a token seeded with `pnpm studio:db:seed` (STUDIO_DEV_API_TOKEN).',
      };
    case 'not_found':
      return {
        title: 'Not found',
        description: failure.message,
        hint: null,
      };
    case 'invalid_response':
      return {
        title: 'Unexpected response from the Studio API',
        description: failure.message,
        hint: 'The response did not match the @vc/schema contract — make sure the web app and API are on the same version.',
      };
    case 'http':
      return {
        title: `Request failed${failure.status ? ` (${failure.status})` : ''}`,
        description: `${failure.code}: ${failure.message}`,
        hint: null,
      };
  }
}

/** Short one-line message for inline action errors (buttons, forms). */
export function failureMessage(failure: ApiFailure): string {
  switch (failure.code) {
    case 'RUN_ACTIVE':
      return 'A director run is already in progress for this project.';
    case 'QUOTA_EXCEEDED':
      return `Daily director quota reached — ${failure.message}`;
    case 'LIMIT_EXCEEDED':
      return `Request exceeds the configured limits — ${failure.message}`;
    case 'RATE_LIMITED':
      return 'Too many requests — please wait a moment and try again.';
    default:
      break;
  }
  if (failure.kind === 'http') return failure.message || failure.code;
  const copy = describeFailure(failure);
  return `${copy.title}. ${copy.description}`;
}
