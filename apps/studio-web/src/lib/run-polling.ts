import { isActiveRunStatus } from './run-status';
import type { ClientRun } from './client-run';

/**
 * Polling policy for the run panel (pure, unit-tested). The browser polls `/api/runs/:id` while a run is queued /
 * running:
 * - every 1.5 s at first, every 5 s once the run has been watched for 2 minutes (long runs stay cheap);
 * - paused while the tab is hidden (`document.hidden`), resumed immediately when it becomes visible;
 * - transient failures (network, 429, 5xx except 503, unexpected payloads) back off exponentially (3 s → 30 s) and
 *   polling gives up after `POLL_MAX_CONSECUTIVE_FAILURES` in a row;
 * - "fatal" statuses stop at once: 400 (bad id), 401/403 (credentials), 404 (run gone), 503 (API not configured /
 *   unavailable) — retrying cannot fix those without a reload.
 */

export const POLL_BASE_INTERVAL_MS = 1500;
export const POLL_SLOW_INTERVAL_MS = 5000;
export const POLL_SLOWDOWN_AFTER_MS = 2 * 60_000;
export const POLL_MAX_BACKOFF_MS = 30_000;
export const POLL_MAX_CONSECUTIVE_FAILURES = 6;

export type PollFailure =
  | { kind: 'http'; status: number; message: string | null }
  | { kind: 'network' }
  | { kind: 'invalid_payload' };

export function isFatalPollStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403 || status === 404 || status === 503;
}

/** Delay before the next request: steady cadence while healthy, exponential backoff after failures. */
export function nextPollDelay(state: { consecutiveFailures: number; elapsedMs: number }): number {
  if (state.consecutiveFailures > 0) {
    return Math.min(POLL_MAX_BACKOFF_MS, POLL_BASE_INTERVAL_MS * 2 ** state.consecutiveFailures);
  }
  return state.elapsedMs >= POLL_SLOWDOWN_AFTER_MS ? POLL_SLOW_INTERVAL_MS : POLL_BASE_INTERVAL_MS;
}

function fatalMessage(status: number): string {
  switch (status) {
    case 400:
      return 'This run cannot be checked (invalid run id).';
    case 401:
    case 403:
      return 'The studio is not authorized to read this run.';
    case 404:
      return 'This director run no longer exists — the project may have been deleted.';
    default:
      return 'The Studio API is unavailable or not configured.';
  }
}

export type PollDecision =
  | { action: 'retry'; delayMs: number; message: string }
  | { action: 'stop'; message: string };

/**
 * What to do after a failed poll. `consecutiveFailures` includes this failure.
 * Stop messages end with the hint that live updates stopped; the UI offers Reload.
 */
export function decideAfterFailure(failure: PollFailure, consecutiveFailures: number, elapsedMs: number): PollDecision {
  if (failure.kind === 'http' && isFatalPollStatus(failure.status)) {
    return { action: 'stop', message: `${fatalMessage(failure.status)} Live updates stopped.` };
  }
  if (consecutiveFailures >= POLL_MAX_CONSECUTIVE_FAILURES) {
    return {
      action: 'stop',
      message: `Live updates stopped after ${consecutiveFailures} failed status checks in a row.`,
    };
  }
  const delayMs = nextPollDelay({ consecutiveFailures, elapsedMs });
  const what =
    failure.kind === 'network'
      ? 'Lost connection to the studio'
      : failure.kind === 'invalid_payload'
        ? 'Received an unexpected run status'
        : failure.status === 429
          ? 'Too many status checks'
          : `Status check failed (HTTP ${failure.status})`;
  return { action: 'retry', delayMs, message: `${what} — retrying in ${Math.round(delayMs / 1000)} s…` };
}

/**
 * Whether a run delivered by the server (a fresh page render, e.g. after `router.refresh()`) should replace the run
 * the panel currently shows. Server data wins unless it is older than what polling already showed.
 */
export function shouldAdoptServerRun(current: ClientRun | null, incoming: ClientRun | null): boolean {
  if (incoming === null) return false;
  if (current === null || current.id !== incoming.id) return true;
  if (!isActiveRunStatus(incoming.status)) return true;
  if (!isActiveRunStatus(current.status)) return false;
  return incoming.progress.completedSteps >= current.progress.completedSteps;
}
