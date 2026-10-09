/**
 * Serializable description of a failed Studio API call. Produced server-side by `StudioApiError.toFailure()` and
 * safe to pass to Client Components and to render for any user: it never contains the token, the API base URL,
 * low-level network errors (`connect ECONNREFUSED …`) or schema-validation details — those are logged server-side.
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
  /** User-facing message (generic for infrastructure failures; the API's own message for HTTP errors). */
  message: string;
}

/** Generic, user-facing messages for failures that must not echo internal details. */
export const PUBLIC_FAILURE_MESSAGES: Readonly<Record<Exclude<ApiFailureKind, 'http' | 'not_found'>, string>> = {
  not_configured: 'The web app is not configured to reach the Studio API.',
  unreachable: 'The Studio API did not respond.',
  unauthorized: 'The Studio API rejected the web app’s credentials.',
  invalid_response: 'The Studio API returned data in an unexpected format.',
};

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
        hint: 'An administrator needs to set STUDIO_API_URL and STUDIO_API_TOKEN for the web server (see apps/studio-web/.env.example) and restart it.',
      };
    case 'unreachable':
      return {
        title: 'Can’t reach the Studio API',
        description: failure.message,
        hint: 'Try again in a moment. If it keeps failing, check that the Studio API (and its worker) is running — the Settings page shows the configured connection.',
      };
    case 'unauthorized':
      return {
        title: 'The Studio API rejected the access token',
        description: failure.message,
        hint: 'An administrator needs to check the web server’s STUDIO_API_TOKEN (it must match a token seeded with `pnpm studio:db:seed`).',
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
        hint: 'The web app and the API may be on different versions.',
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

/** HTTP status a same-origin route handler should use when proxying a failed Studio API call to the browser. */
export function proxyStatusFor(failure: ApiFailure): number {
  switch (failure.kind) {
    case 'not_configured':
    case 'unauthorized':
      // The web server's own configuration / credentials are at fault — not the browser's: service unavailable.
      return 503;
    case 'unreachable':
    case 'invalid_response':
      return 502;
    case 'not_found':
      return 404;
    case 'http':
      return failure.status && failure.status >= 400 && failure.status <= 599 ? failure.status : 502;
  }
}

/**
 * Message a route handler may return to the browser: generic copy for infrastructure failures and 5xx responses,
 * the API's own (user-facing) message for 4xx responses.
 */
export function publicFailureMessage(failure: ApiFailure): string {
  switch (failure.kind) {
    case 'not_configured':
    case 'unreachable':
    case 'unauthorized':
    case 'invalid_response':
      return PUBLIC_FAILURE_MESSAGES[failure.kind];
    case 'not_found':
      return failure.message || 'Not found.';
    case 'http':
      return failure.status !== null && failure.status < 500
        ? failure.message || failure.code
        : 'The Studio API could not process the request.';
  }
}
