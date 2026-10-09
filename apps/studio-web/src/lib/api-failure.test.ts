import { describe, expect, it } from 'vitest';
import {
  PUBLIC_FAILURE_MESSAGES,
  describeFailure,
  failureMessage,
  proxyStatusFor,
  publicFailureMessage,
  type ApiFailure,
} from './api-failure';
import { isActiveRunStatus, runProgressPercent } from './run-status';
import { runErrorNotice } from './run-actions';

const failure = (overrides: Partial<ApiFailure>): ApiFailure => ({
  kind: 'http',
  status: 500,
  code: 'INTERNAL',
  message: 'boom',
  ...overrides,
});

describe('describeFailure', () => {
  it('explains unreachable and unauthorized states with actionable hints', () => {
    const unreachable = describeFailure(
      failure({ kind: 'unreachable', status: null, code: 'API_UNREACHABLE', message: PUBLIC_FAILURE_MESSAGES.unreachable }),
    );
    expect(unreachable.title).toMatch(/reach/);
    expect(unreachable.hint).toMatch(/Settings/);

    const unauthorized = describeFailure(failure({ kind: 'unauthorized', status: 401, code: 'UNAUTHORIZED' }));
    expect(unauthorized.hint).toMatch(/STUDIO_API_TOKEN/);

    const missing = describeFailure(failure({ kind: 'not_configured', status: null, code: 'CONFIG_MISSING_TOKEN' }));
    expect(missing.hint).toMatch(/\.env/);
  });

  it('never includes a token or the API base URL', () => {
    for (const kind of ['unreachable', 'unauthorized', 'not_configured', 'invalid_response'] as const) {
      const copy = describeFailure(failure({ kind, status: null, message: PUBLIC_FAILURE_MESSAGES[kind] }));
      expect(JSON.stringify(copy)).not.toMatch(/Bearer|localhost|http:\/\//);
    }
  });
});

describe('route handler mapping', () => {
  it('maps failures to proxy status codes', () => {
    expect(proxyStatusFor(failure({ kind: 'not_configured', status: null }))).toBe(503);
    expect(proxyStatusFor(failure({ kind: 'unauthorized', status: 401 }))).toBe(503);
    expect(proxyStatusFor(failure({ kind: 'unreachable', status: null }))).toBe(502);
    expect(proxyStatusFor(failure({ kind: 'not_found', status: 404 }))).toBe(404);
    expect(proxyStatusFor(failure({ kind: 'http', status: 429 }))).toBe(429);
    expect(proxyStatusFor(failure({ kind: 'http', status: null }))).toBe(502);
  });

  it('returns generic messages for infrastructure failures and 5xx', () => {
    // Even if a raw detail slipped into `message`, the public message is generic.
    expect(publicFailureMessage(failure({ kind: 'unreachable', status: null, message: 'connect ECONNREFUSED 127.0.0.1:4100' }))).toBe(
      PUBLIC_FAILURE_MESSAGES.unreachable,
    );
    expect(publicFailureMessage(failure({ kind: 'http', status: 500, message: 'Error: stack trace…' }))).not.toMatch(/stack/);
    expect(publicFailureMessage(failure({ kind: 'http', status: 409, code: 'RUN_ACTIVE', message: 'Run active' }))).toBe('Run active');
    expect(publicFailureMessage(failure({ kind: 'not_found', status: 404, message: 'Director run not found' }))).toBe(
      'Director run not found',
    );
  });
});

describe('failureMessage', () => {
  it('maps well-known API codes', () => {
    expect(failureMessage(failure({ status: 409, code: 'RUN_ACTIVE' }))).toMatch(/already in progress/);
    expect(failureMessage(failure({ status: 429, code: 'QUOTA_EXCEEDED', message: '50 runs' }))).toMatch(/quota/);
    expect(failureMessage(failure({ status: 400, code: 'VALIDATION_ERROR', message: 'Bad title' }))).toBe('Bad title');
  });
});

describe('run status helpers', () => {
  it('detects active runs', () => {
    expect(isActiveRunStatus('queued')).toBe(true);
    expect(isActiveRunStatus('running')).toBe(true);
    expect(isActiveRunStatus('succeeded')).toBe(false);
    expect(isActiveRunStatus('cancelled')).toBe(false);
  });

  it('computes progress percentages', () => {
    const progress = { completedSteps: 4, totalSteps: 8, currentStage: 'script' as const, message: null };
    expect(runProgressPercent(progress)).toBe(50);
    expect(runProgressPercent({ ...progress, totalSteps: 0 })).toBe(0);
    expect(runProgressPercent(progress, 'succeeded')).toBe(100);
    expect(runProgressPercent({ ...progress, completedSteps: 12 })).toBe(100);
  });

  it('describes run start errors passed through the URL', () => {
    expect(runErrorNotice('QUOTA_EXCEEDED')).toMatch(/quota/);
    expect(runErrorNotice('SOMETHING')).toMatch(/SOMETHING/);
  });
});
