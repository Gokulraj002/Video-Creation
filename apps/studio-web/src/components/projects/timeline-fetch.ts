/**
 * Raw timeline download, kept free of Zod / `@vc/schema` so the light tab components can start it immediately — in
 * parallel with loading the heavy chunk (Remotion Player, timeline schema) that validates and renders it.
 * `timeline-loader.ts` consumes the prefetched response (once; a retry downloads again).
 */

export interface RawTimelineResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

const prefetched = new Map<string, Promise<RawTimelineResponse>>();
/** Timelines the loader already validated and holds (no need to prefetch them again). */
const loaded = new Set<string>();

function key(projectId: string, version: number): string {
  return `${projectId}:${version}`;
}

async function download(projectId: string, version: number): Promise<RawTimelineResponse> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/versions/${version}/timeline`, {
    cache: 'no-store',
  });
  const body: unknown = await response.json().catch(() => undefined);
  return { ok: response.ok, status: response.status, body };
}

/** Starts downloading the timeline (no-op when a download is already pending). Network errors surface on `take`. */
export function prefetchTimeline(projectId: string, version: number): void {
  const k = key(projectId, version);
  if (prefetched.has(k) || loaded.has(k)) return;
  const pending = download(projectId, version);
  pending.catch(() => undefined); // handled by whoever takes it
  prefetched.set(k, pending);
}

/** The prefetched download if any (removed from the cache), otherwise a fresh one. */
export function takeTimelineResponse(projectId: string, version: number): Promise<RawTimelineResponse> {
  const k = key(projectId, version);
  const pending = prefetched.get(k);
  if (pending) {
    prefetched.delete(k);
    return pending;
  }
  return download(projectId, version);
}

/** Called by the loader when it holds / evicts a validated timeline. */
export function setTimelineLoaded(projectId: string, version: number, isLoaded: boolean): void {
  if (isLoaded) loaded.add(key(projectId, version));
  else loaded.delete(key(projectId, version));
}
