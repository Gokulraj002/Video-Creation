import type { DirectorRunDTO } from '@vc/schema';
import { describe, expect, it } from 'vitest';
import { ClientRunSchema, toClientRun, type ClientRun } from './client-run';
import {
  POLL_BASE_INTERVAL_MS,
  POLL_MAX_BACKOFF_MS,
  POLL_MAX_CONSECUTIVE_FAILURES,
  POLL_SLOW_INTERVAL_MS,
  POLL_SLOWDOWN_AFTER_MS,
  decideAfterFailure,
  isFatalPollStatus,
  nextPollDelay,
  shouldAdoptServerRun,
} from './run-polling';

const RUN: DirectorRunDTO = {
  id: 'run1',
  projectId: 'p1',
  status: 'running',
  provider: 'mock',
  model: 'mock-director-v1',
  progress: { completedSteps: 3, totalSteps: 10, currentStage: 'script', message: null },
  usage: {
    stages: [
      {
        stage: 'brief',
        chunk: null,
        provider: 'mock',
        model: 'mock-director-v1',
        attempts: 1,
        cached: false,
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        latencyMs: 5,
        estimatedCostUsd: 0,
        pricingKnown: true,
      },
    ],
    totals: { calls: 1, cachedCalls: 0, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 },
  },
  error: null,
  versionNumber: null,
  createdAt: '2026-10-09T09:00:00.000Z',
  startedAt: '2026-10-09T09:00:01.000Z',
  finishedAt: null,
};

const client = (overrides: Partial<ClientRun> = {}): ClientRun => ({ ...toClientRun(RUN), ...overrides });

describe('toClientRun', () => {
  it('keeps the usage totals only, and stays schema-valid', () => {
    const slim = toClientRun(RUN);
    expect(slim.usage).toEqual({ totals: RUN.usage?.totals });
    expect(ClientRunSchema.safeParse(slim).success).toBe(true);
    expect(toClientRun({ ...RUN, usage: null }).usage).toBeNull();
  });
});

describe('nextPollDelay', () => {
  it('polls quickly at first, slower for long runs', () => {
    expect(nextPollDelay({ consecutiveFailures: 0, elapsedMs: 0 })).toBe(POLL_BASE_INTERVAL_MS);
    expect(nextPollDelay({ consecutiveFailures: 0, elapsedMs: POLL_SLOWDOWN_AFTER_MS })).toBe(POLL_SLOW_INTERVAL_MS);
  });

  it('backs off exponentially after failures, capped', () => {
    expect(nextPollDelay({ consecutiveFailures: 1, elapsedMs: 0 })).toBe(3000);
    expect(nextPollDelay({ consecutiveFailures: 2, elapsedMs: 0 })).toBe(6000);
    expect(nextPollDelay({ consecutiveFailures: 10, elapsedMs: 0 })).toBe(POLL_MAX_BACKOFF_MS);
  });
});

describe('decideAfterFailure', () => {
  it('stops immediately on fatal statuses with a clear message', () => {
    for (const status of [400, 401, 403, 404, 503]) {
      expect(isFatalPollStatus(status)).toBe(true);
      const decision = decideAfterFailure({ kind: 'http', status, message: null }, 1, 0);
      expect(decision.action).toBe('stop');
      expect(decision.message).toMatch(/Live updates stopped/);
    }
    expect(decideAfterFailure({ kind: 'http', status: 404, message: null }, 1, 0).message).toMatch(/no longer exists/);
  });

  it('retries transient failures with backoff', () => {
    for (const failure of [
      { kind: 'network' as const },
      { kind: 'invalid_payload' as const },
      { kind: 'http' as const, status: 502, message: null },
      { kind: 'http' as const, status: 429, message: null },
    ]) {
      expect(isFatalPollStatus(failure.kind === 'http' ? failure.status : 0)).toBe(false);
      const decision = decideAfterFailure(failure, 2, 0);
      expect(decision).toMatchObject({ action: 'retry', delayMs: 6000 });
      expect(decision.message).toMatch(/retrying in 6 s/);
    }
  });

  it('caps consecutive failures', () => {
    expect(decideAfterFailure({ kind: 'network' }, POLL_MAX_CONSECUTIVE_FAILURES - 1, 0).action).toBe('retry');
    const stop = decideAfterFailure({ kind: 'network' }, POLL_MAX_CONSECUTIVE_FAILURES, 0);
    expect(stop.action).toBe('stop');
    expect(stop.message).toMatch(/6 failed status checks/);
  });
});

describe('shouldAdoptServerRun', () => {
  it('adopts new runs and terminal states from the server', () => {
    expect(shouldAdoptServerRun(null, client())).toBe(true);
    expect(shouldAdoptServerRun(client(), client({ id: 'run2' }))).toBe(true);
    expect(shouldAdoptServerRun(client(), client({ status: 'cancelled' }))).toBe(true);
    expect(shouldAdoptServerRun(client(), null)).toBe(false);
  });

  it('never replaces fresher polled progress with an older snapshot', () => {
    const polled = client({ progress: { ...RUN.progress, completedSteps: 7 } });
    expect(shouldAdoptServerRun(polled, client({ progress: { ...RUN.progress, completedSteps: 5 } }))).toBe(false);
    expect(shouldAdoptServerRun(polled, client({ progress: { ...RUN.progress, completedSteps: 8 } }))).toBe(true);
    // A finished run shown locally is not "re-activated" by a stale server snapshot.
    expect(shouldAdoptServerRun(client({ status: 'succeeded' }), client())).toBe(false);
  });
});
