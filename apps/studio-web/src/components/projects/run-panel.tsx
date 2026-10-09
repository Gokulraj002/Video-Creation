'use client';

import '@/lib/zod-jitless';
import { ApiErrorSchema } from '@vc/schema';
import { Ban, LoaderCircle, Play, RefreshCw, RotateCcw, TriangleAlert, WifiOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { cancelDirectorRunAction, startDirectorRunAction } from '@/app/projects/[id]/actions';
import { RunStatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { ClientRunSchema, type ClientRun } from '@/lib/client-run';
import { formatElapsed } from '@/lib/duration';
import { formatCompactNumber, formatUsd } from '@/lib/format';
import { POLL_BASE_INTERVAL_MS, decideAfterFailure, nextPollDelay, shouldAdoptServerRun, type PollFailure } from '@/lib/run-polling';
import { isActiveRunStatus, runProgressPercent, STAGE_LABELS } from '@/lib/run-status';

type PollResult = { ok: true; run: ClientRun } | { ok: false; failure: PollFailure };

async function fetchRun(runId: string): Promise<PollResult> {
  let response: Response;
  try {
    response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { cache: 'no-store' });
  } catch {
    return { ok: false, failure: { kind: 'network' } };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope = ApiErrorSchema.safeParse(body);
    return { ok: false, failure: { kind: 'http', status: response.status, message: envelope.success ? envelope.data.error.message : null } };
  }
  const parsed = ClientRunSchema.safeParse(body);
  return parsed.success ? { ok: true, run: parsed.data } : { ok: false, failure: { kind: 'invalid_payload' } };
}

/**
 * Polls the run through the Next route handler (`/api/runs/:id`, a server-side proxy with the token) while it is
 * queued / running, following the policy in `@/lib/run-polling` (backoff, pause while the tab is hidden, stop on
 * fatal statuses or after repeated failures). Server renders (refreshes, tab switches) are reconciled into the
 * shown run with `shouldAdoptServerRun`.
 */
function useRunPolling(serverRun: ClientRun | null) {
  const router = useRouter();
  const [run, setRun] = useState<ClientRun | null>(serverRun);
  const [lastServerRun, setLastServerRun] = useState<ClientRun | null>(serverRun);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const [stopped, setStopped] = useState<string | null>(null);
  const [resumeToken, setResumeToken] = useState(0);
  const runId = run?.id ?? null;
  const active = run ? isActiveRunStatus(run.status) : false;

  // Adopt fresher server data (e.g. after a refresh that reconciles a stopped poller); never go back in time.
  if (serverRun !== lastServerRun) {
    setLastServerRun(serverRun);
    if (shouldAdoptServerRun(run, serverRun)) setRun(serverRun);
  }

  useEffect(() => {
    if (!runId || !active || stopped !== null) return;
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const startedAt = Date.now();

    const schedule = (delayMs: number) => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (!cancelled && !document.hidden) timer = setTimeout(tick, delayMs);
    };

    const tick = async () => {
      if (cancelled || inFlight || document.hidden) return;
      inFlight = true;
      const result = await fetchRun(runId);
      inFlight = false;
      if (cancelled) return;
      const elapsedMs = Date.now() - startedAt;
      if (result.ok) {
        failures = 0;
        setRetryNote(null);
        setRun(result.run);
        if (!isActiveRunStatus(result.run.status)) {
          // Finished while we watched: re-render the server page once so the new version / artifacts appear.
          router.refresh();
          return;
        }
        schedule(nextPollDelay({ consecutiveFailures: 0, elapsedMs }));
        return;
      }
      failures += 1;
      const decision = decideAfterFailure(result.failure, failures, elapsedMs);
      if (decision.action === 'stop') {
        setRetryNote(null);
        setStopped(decision.message);
        // Reconcile with the server: the refreshed page carries the authoritative run state (or a not-found page).
        router.refresh();
        return;
      }
      setRetryNote(decision.message);
      schedule(decision.delayMs);
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        if (timer) clearTimeout(timer);
        timer = undefined;
      } else if (!inFlight) {
        schedule(0);
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    schedule(POLL_BASE_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [runId, active, stopped, resumeToken, router]);

  // A run that turned out to be finished makes a "live updates stopped" notice moot.
  const stoppedNotice = active ? stopped : null;

  return {
    run,
    setRun,
    retryNote: active && stopped === null ? retryNote : null,
    stopped: stoppedNotice,
    resume: () => {
      setStopped(null);
      setRetryNote(null);
      setResumeToken((n) => n + 1);
    },
  };
}

/** Ticking clock for elapsed times; `null` until mounted so server and client markup match. */
function useNow(enabled: boolean): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

export function RunPanel({
  projectId,
  initialRun,
  notice,
  liveProvider,
}: {
  projectId: string;
  initialRun: ClientRun | null;
  notice: string | null;
  /**
   * Set when new runs use a live (credit-spending) provider — or when the provider mode is unknown — so starting a
   * run asks for confirmation. `null` for the mock provider.
   */
  liveProvider: { label: string } | null;
}) {
  const { run, setRun, retryNote, stopped, resume } = useRunPolling(initialRun);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const active = run ? isActiveRunStatus(run.status) : false;
  const now = useNow(active);

  const start = () => {
    if (liveProvider) {
      const what = run ? 'Re-run the AI Director' : 'Start the AI Director';
      const ok = window.confirm(
        `${what} with ${liveProvider.label}? This uses the live AI provider and spends credits (see the Usage tab for estimates).`,
      );
      if (!ok) return;
    }
    startTransition(async () => {
      setActionError(null);
      // On success the Server Action calls `refresh()`, so the page re-renders with the new run (and a fresh panel).
      const result = await startDirectorRunAction(projectId);
      if (!result.ok) setActionError(result.message);
      else if (result.run) setRun(result.run);
    });
  };

  const cancel = (runId: string) =>
    startTransition(async () => {
      setActionError(null);
      // The Server Action already refreshes the page; setting the cancelled run here must not trigger a second refresh
      // (only runs that finish while being polled do).
      const result = await cancelDirectorRunAction(runId);
      if (!result.ok) setActionError(result.message);
      else if (result.run) setRun(result.run);
    });

  const percent = run ? runProgressPercent(run.progress, run.status) : 0;
  const stage = run?.progress.currentStage ? STAGE_LABELS[run.progress.currentStage] : null;
  const elapsed =
    run && (run.finishedAt !== null || now !== null) ? formatElapsed(run.startedAt, run.finishedAt, now ?? 0) : null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="font-semibold">Director run</span>
            {run ? <RunStatusBadge status={run.status} /> : null}
            {run ? (
              <span className="truncate text-sm text-muted-foreground">
                {run.provider} · {run.model}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">No run yet</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {run && active ? (
              <Button variant="outline" size="sm" onClick={() => cancel(run.id)} disabled={pending}>
                {pending ? <LoaderCircle className="animate-spin" /> : <Ban />}
                Cancel run
              </Button>
            ) : (
              <Button size="sm" onClick={start} disabled={pending}>
                {pending ? <LoaderCircle className="animate-spin" /> : run ? <RotateCcw /> : <Play />}
                {run ? 'Re-run director' : 'Start director run'}
              </Button>
            )}
          </div>
        </div>

        {run ? (
          <div className="flex flex-col gap-2">
            <Progress
              value={percent}
              aria-label="Director progress"
              indicatorClassName={
                run.status === 'failed' ? 'bg-destructive' : run.status === 'cancelled' ? 'bg-muted-foreground' : undefined
              }
            />
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="tabular-nums">
                Step {Math.min(run.progress.completedSteps, run.progress.totalSteps)} of {run.progress.totalSteps || '—'} ·{' '}
                {percent}%{stage ? ` · ${stage}` : ''}
                {run.progress.message ? ` — ${run.progress.message}` : ''}
              </span>
              <span className="tabular-nums">
                {elapsed ? `${run.finishedAt ? 'Took' : 'Elapsed'} ${elapsed}` : run.status === 'queued' ? 'Waiting for a worker…' : ''}
                {run.usage
                  ? ` · ${formatCompactNumber(run.usage.totals.inputTokens + run.usage.totals.outputTokens)} tokens · ${formatUsd(run.usage.totals.estimatedCostUsd)}`
                  : ''}
                {run.versionNumber ? ` · produced v${run.versionNumber}` : ''}
              </span>
            </div>
          </div>
        ) : null}

        {notice && !run ? (
          <Alert variant="warning">
            <TriangleAlert />
            <AlertTitle>Director run not started</AlertTitle>
            <AlertDescription>
              <p>{notice}</p>
            </AlertDescription>
          </Alert>
        ) : null}

        {run?.status === 'failed' && run.error ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Run failed · {run.error.code}</AlertTitle>
            <AlertDescription>
              <p className="break-words">{run.error.message}</p>
            </AlertDescription>
          </Alert>
        ) : null}

        {actionError ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Action failed</AlertTitle>
            <AlertDescription>
              <p>{actionError}</p>
            </AlertDescription>
          </Alert>
        ) : null}

        {stopped ? (
          <Alert variant="warning">
            <WifiOff />
            <AlertTitle>Run status unknown</AlertTitle>
            <AlertDescription>
              <p>{stopped} The progress shown may be out of date.</p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button type="button" size="sm" variant="outline" onClick={() => window.location.reload()}>
                  <RefreshCw /> Reload
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={resume}>
                  Try again
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        {retryNote ? (
          <p role="status" className="flex items-center gap-2 text-xs text-warning-foreground dark:text-warning">
            <WifiOff className="size-3.5" />
            {retryNote}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
