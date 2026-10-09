import { describe, expect, it } from 'vitest';
import { describeFailure, failureMessage, type ApiFailure } from './api-failure';
import { isActiveRunStatus, runProgressPercent } from './run-status';
import { runErrorNotice } from './run-actions';

const failure = (overrides: Partial<ApiFailure>): ApiFailure => ({
  kind: 'http',
  status: 500,
  code: 'INTERNAL',
  message: 'boom',
  apiUrl: 'http://localhost:4100',
  ...overrides,
});

describe('describeFailure', () => {
  it('explains unreachable and unauthorized states with actionable hints', () => {
    const unreachable = describeFailure(failure({ kind: 'unreachable', status: null, code: 'API_UNREACHABLE', message: 'ECONNREFUSED' }));
    expect(unreachable.title).toMatch(/reach/);
    expect(unreachable.description).toContain('http://localhost:4100');
    expect(unreachable.hint).toMatch(/studio:dev:api/);

    const unauthorized = describeFailure(failure({ kind: 'unauthorized', status: 401, code: 'UNAUTHORIZED' }));
    expect(unauthorized.hint).toMatch(/STUDIO_API_TOKEN/);

    const missing = describeFailure(failure({ kind: 'not_configured', status: null, code: 'CONFIG_MISSING_TOKEN' }));
    expect(missing.hint).toMatch(/\.env/);
  });

  it('never includes a token', () => {
    const copy = describeFailure(failure({ kind: 'unauthorized', status: 401 }));
    expect(JSON.stringify(copy)).not.toMatch(/Bearer/);
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
