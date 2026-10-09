import type { DirectorStage, LimitViolation, TokenUsage, UsageReport } from '@vc/schema';

export const DIRECTOR_ERROR_CODES = [
  'VALIDATION_FAILED',
  'PROVIDER_REFUSAL',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_CONFIG',
  'PROVIDER_REQUEST',
  'PROVIDER_TRUNCATED',
  'CANCELLED',
  'LIMIT_EXCEEDED',
  'INTERNAL',
] as const;
export type DirectorErrorCode = (typeof DIRECTOR_ERROR_CODES)[number];

export interface DirectorErrorOptions {
  retryable?: boolean;
  details?: unknown;
  cause?: unknown;
  stage?: DirectorStage | null;
  chunk?: string | null;
}

/** Base class of every error thrown by the director and its providers. */
export class DirectorError extends Error {
  readonly code: DirectorErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;
  /** Stage / chunk where the error happened (set by the director when known). */
  stage: DirectorStage | null;
  chunk: string | null;
  /** Usage accumulated by the run before it failed (set by the director), so failed runs can still be billed. */
  usage: UsageReport | null = null;

  constructor(code: DirectorErrorCode, message: string, options: DirectorErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DirectorError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.stage = options.stage ?? null;
    this.chunk = options.chunk ?? null;
  }

  toJSON(): { code: DirectorErrorCode; message: string; retryable: boolean; stage: DirectorStage | null; chunk: string | null; details?: unknown } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      stage: this.stage,
      chunk: this.chunk,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

/** Output still failed Zod/semantic validation after all repair attempts (or the input was invalid). */
export class ValidationFailedError extends DirectorError {
  readonly issues: string[];
  constructor(message: string, issues: string[], options: Omit<DirectorErrorOptions, 'details'> = {}) {
    super('VALIDATION_FAILED', message, { ...options, details: { issues } });
    this.name = 'ValidationFailedError';
    this.issues = issues;
  }
}

export interface RefusalDetails {
  category: string | null;
  explanation: string | null;
}

/** The model declined the request (`stop_reason: "refusal"`). Never retried. */
export class ProviderRefusalError extends DirectorError {
  readonly category: string | null;
  constructor(message: string, refusal: RefusalDetails, options: Omit<DirectorErrorOptions, 'details' | 'retryable'> = {}) {
    super('PROVIDER_REFUSAL', message, { ...options, retryable: false, details: refusal });
    this.name = 'ProviderRefusalError';
    this.category = refusal.category;
  }
}

/** Rate limits, overload, 5xx and connection problems: retry later. */
export class ProviderUnavailableError extends DirectorError {
  constructor(message: string, options: Omit<DirectorErrorOptions, 'retryable'> = {}) {
    super('PROVIDER_UNAVAILABLE', message, { ...options, retryable: true });
    this.name = 'ProviderUnavailableError';
  }
}

/** Missing / invalid credentials or permissions. */
export class ProviderConfigError extends DirectorError {
  constructor(message: string, options: Omit<DirectorErrorOptions, 'retryable'> = {}) {
    super('PROVIDER_CONFIG', message, { ...options, retryable: false });
    this.name = 'ProviderConfigError';
  }
}

/** The provider rejected the request (400/404/413/422...). */
export class ProviderRequestError extends DirectorError {
  constructor(message: string, options: Omit<DirectorErrorOptions, 'retryable'> = {}) {
    super('PROVIDER_REQUEST', message, { ...options, retryable: false });
    this.name = 'ProviderRequestError';
  }
}

/** The response hit `max_tokens` before the JSON was complete. */
export class ProviderTruncatedError extends DirectorError {
  /** Tokens consumed by the truncated response (so the director can still account for them). */
  readonly tokenUsage: TokenUsage | null;
  readonly partialOutput: string | null;
  constructor(
    message: string,
    extra: { usage?: TokenUsage | null; partialOutput?: string | null } = {},
    options: Omit<DirectorErrorOptions, 'retryable'> = {},
  ) {
    super('PROVIDER_TRUNCATED', message, { ...options, retryable: false });
    this.name = 'ProviderTruncatedError';
    this.tokenUsage = extra.usage ?? null;
    this.partialOutput = extra.partialOutput ?? null;
  }
}

export class CancelledError extends DirectorError {
  constructor(message = 'The director run was cancelled', options: Omit<DirectorErrorOptions, 'retryable'> = {}) {
    super('CANCELLED', message, { ...options, retryable: false });
    this.name = 'CancelledError';
  }
}

export class LimitExceededError extends DirectorError {
  readonly violations: LimitViolation[];
  constructor(message: string, violations: LimitViolation[], options: Omit<DirectorErrorOptions, 'details' | 'retryable'> = {}) {
    super('LIMIT_EXCEEDED', message, { ...options, retryable: false, details: { violations } });
    this.name = 'LimitExceededError';
    this.violations = violations;
  }
}

export class InternalDirectorError extends DirectorError {
  constructor(message: string, options: Omit<DirectorErrorOptions, 'retryable'> = {}) {
    super('INTERNAL', message, { ...options, retryable: false });
    this.name = 'InternalDirectorError';
  }
}

export function isDirectorError(value: unknown): value is DirectorError {
  return value instanceof DirectorError;
}

/** Wraps any thrown value into a `DirectorError` (unknown errors become `INTERNAL`). */
export function toDirectorError(value: unknown): DirectorError {
  if (value instanceof DirectorError) return value;
  const message = value instanceof Error ? value.message : `Unexpected error: ${String(value)}`;
  return new InternalDirectorError(message, { cause: value });
}
