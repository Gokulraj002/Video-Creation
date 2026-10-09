import '@/lib/zod-jitless';
import { ApiErrorSchema, TimelineSchema, type Timeline } from '@vc/schema';
import { useEffect, useState } from 'react';

/**
 * Lazily loads a version's timeline from the same-origin route handler (`/api/projects/:id/versions/:v/timeline`,
 * a server-side proxy — the API token never reaches the browser) and validates it with `TimelineSchema`.
 * The page itself never serializes the timeline (multi-hour timelines are several MB).
 * Client-only module (imported by client components). Results are kept per page session (soft navigations between tabs reuse them); at most two timelines are held.
 */

const MAX_CACHED = 2;
const pending = new Map<string, Promise<Timeline>>();
const resolved = new Map<string, Timeline>();

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHED) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

async function fetchTimeline(projectId: string, version: number): Promise<Timeline> {
  let response: Response;
  try {
    response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/versions/${version}/timeline`, {
      cache: 'no-store',
    });
  } catch {
    throw new Error('Lost connection to the studio while loading the timeline.');
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const envelope = ApiErrorSchema.safeParse(body);
    throw new Error(envelope.success ? envelope.data.error.message : `Could not load the timeline (HTTP ${response.status}).`);
  }
  const parsed = TimelineSchema.safeParse(body);
  if (!parsed.success) throw new Error('The timeline did not pass validation.');
  return parsed.data;
}

export function loadTimeline(projectId: string, version: number): Promise<Timeline> {
  const key = `${projectId}:${version}`;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const promise = fetchTimeline(projectId, version).then(
    (timeline) => {
      remember(resolved, key, timeline);
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
