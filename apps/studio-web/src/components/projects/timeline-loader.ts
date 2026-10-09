import '@/lib/zod-jitless';
import { ApiErrorSchema, TimelineSchema, type Timeline } from '@vc/schema';
import { useEffect, useState } from 'react';
import { setTimelineLoaded, takeTimelineResponse, type RawTimelineResponse } from './timeline-fetch';

/**
 * Lazily loads a version's timeline from the same-origin route handler (`/api/projects/:id/versions/:v/timeline`,
 * a server-side proxy — the API token never reaches the browser) and validates it with `TimelineSchema`.
 * The page itself never serializes the timeline (multi-hour timelines are several MB).
 * Client-only module (imported by client components). Results are kept per page session (soft navigations between
 * tabs reuse them); at most two timelines are held. The download itself may already have been started by
 * `prefetchTimeline` (see `timeline-fetch.ts`).
 */

const MAX_CACHED = 2;
const pending = new Map<string, Promise<Timeline>>();
const resolved = new Map<string, Timeline>();

function remember<V>(map: Map<string, V>, key: string, value: V, onEvict?: (key: string) => void): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHED) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
    onEvict?.(oldest.value);
  }
}

function evictResolved(key: string): void {
  const [projectId, version] = splitKey(key);
  if (projectId !== null) setTimelineLoaded(projectId, version, false);
}

function splitKey(key: string): [string | null, number] {
  const at = key.lastIndexOf(':');
  return at > 0 ? [key.slice(0, at), Number(key.slice(at + 1))] : [null, 0];
}

async function fetchTimeline(projectId: string, version: number): Promise<Timeline> {
  let response: RawTimelineResponse;
  try {
    response = await takeTimelineResponse(projectId, version);
  } catch {
    throw new Error('Lost connection to the studio while loading the timeline.');
  }
  if (!response.ok) {
    const envelope = ApiErrorSchema.safeParse(response.body);
    throw new Error(envelope.success ? envelope.data.error.message : `Could not load the timeline (HTTP ${response.status}).`);
  }
  const parsed = TimelineSchema.safeParse(response.body);
  if (!parsed.success) throw new Error('The timeline did not pass validation.');
  return parsed.data;
}

export function loadTimeline(projectId: string, version: number): Promise<Timeline> {
  const key = `${projectId}:${version}`;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const promise = fetchTimeline(projectId, version).then(
    (timeline) => {
      remember(resolved, key, timeline, evictResolved);
      setTimelineLoaded(projectId, version, true);
      return timeline;
    },
    (error: unknown) => {
      if (pending.get(key) === promise) pending.delete(key);
      throw error;
    },
  );
  remember(pending, key, promise);
  return promise;
}

export type TimelineState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; timeline: Timeline };

/** Loads (or reuses) the timeline of `projectId` v`version`; `retry` re-fetches after an error. */
export function useTimeline(projectId: string, version: number): { state: TimelineState; retry: () => void } {
  const key = `${projectId}:${version}`;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; value: TimelineState }>(() => {
    const cached = resolved.get(key);
    return { key, value: cached ? { status: 'ready', timeline: cached } : { status: 'loading' } };
  });

  useEffect(() => {
    let cancelled = false;
    const cached = resolved.get(key);
    if (cached) {
      setState({ key, value: { status: 'ready', timeline: cached } });
      return;
    }
    setState({ key, value: { status: 'loading' } });
    loadTimeline(projectId, version).then(
      (timeline) => {
        if (!cancelled) setState({ key, value: { status: 'ready', timeline } });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ key, value: { status: 'error', message: error instanceof Error ? error.message : 'Could not load the timeline.' } });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, projectId, version, attempt]);

  return {
    state: state.key === key ? state.value : { status: 'loading' },
    retry: () => setAttempt((n) => n + 1),
  };
}
