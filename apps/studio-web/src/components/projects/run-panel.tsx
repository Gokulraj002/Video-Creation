'use client';

import { ApiErrorSchema, DirectorRunDTOSchema, type DirectorRunDTO } from '@vc/schema';
import { Ban, LoaderCircle, Play, RotateCcw, TriangleAlert, WifiOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { cancelDirectorRunAction, startDirectorRunAction } from '@/app/projects/[id]/actions';
import { RunStatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { formatElapsed } from '@/lib/duration';
import { formatCompactNumber, formatUsd } from '@/lib/format';
import { isActiveRunStatus, runProgressPercent, STAGE_LABELS } from '@/lib/run-status';

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_INTERVAL_MS = 10_000;

/** Polls the run through the Next route handler (`/api/runs/:id`), which proxies server-side with the token. */
function useRunPolling(initial: DirectorRunDTO | null): {
  run: DirectorRunDTO | null;
  setRun: (run: DirectorRunDTO) => void;
  pollError: string | null;
} {
  const router = useRouter();
  const [run, setRun] = useState<DirectorRunDTO | null>(initial);
  const [pollError, setPollError] = useState<string | null>(null);
  const runId = run?.id ?? null;
  const active = run ? isActiveRunStatus(run.status) : false;
  const wasActive = useRef(active);

  // When the run finishes, re-render the server page so the new version / artifacts appear.
  useEffect(() => {
    if (wasActive.current && !active) router.refresh();
    wasActive.current = active;
  }, [active, router]);

  useEffect(() => {
    if (!runId || !active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = POLL_INTERVAL_MS;

    const tick = async () => {
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { cache: 'no-store' });
        const body: unknown = await response.json().catch(() => null);
        if (cancelled) return;
        if (response.ok) {
          const parsed = DirectorRunDTOSchema.safeParse(body);
          if (parsed.success) {
            setRun(parsed.data);
            setPollError(null);
            delay = POLL_INTERVAL_MS;
          } else {
            setPollError('Received an unexpected run status payload.');
          }
        } else {
          const envelope = ApiErrorSchema.safeParse(body);
          setPollError(envelope.success ? envelope.data.error.message : `Status check failed (HTTP ${response.status}).`);
          delay = Math.min(MAX_POLL_INTERVAL_MS, delay * 2);
        }
      } catch {
        if (cancelled) return;
        setPollError('Lost connection to the studio — retrying…');
        delay = Math.min(MAX_POLL_INTERVAL_MS, delay * 2);
      }
      if (!cancelled) timer = setTimeout(tick, delay);
    };

    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, active]);

  return { run, setRun, pollError };
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
}: {
  projectId: string;
  initialRun: DirectorRunDTO | null;
  notice: string | null;
}) {
  const { run, setRun, pollError } = useRunPolling(initialRun);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const active = run ? isActiveRunStatus(run.status) : false;
  const now = useNow(active);

  const start = () =>
    startTransition(async () => {
      setActionError(null);
      // On success the Server Action calls `refresh()`, so the page re-renders with the new run.
      const result = await startDirectorRunAction(projectId);
      if (!result.ok) setActionError(result.message);
      else if (result.run) setRun(result.run);
    });

  const cancel = (runId: string) =>
    startTransition(async () => {
      setActionError(null);
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

        {pollError && active ? (
          <p className="flex items-center gap-2 text-xs text-warning-foreground dark:text-warning">
            <WifiOff className="size-3.5" />
            {pollError}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
