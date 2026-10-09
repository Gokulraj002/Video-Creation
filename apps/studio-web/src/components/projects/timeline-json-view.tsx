'use client';

import dynamic from 'next/dynamic';

/**
 * Timeline JSON tab. The timeline is NOT part of the page payload: the inner view (its own chunk, with the Zod
 * timeline schema) fetches it from `/api/projects/:id/versions/:v/timeline` when the tab opens.
 */
const TimelineJsonInner = dynamic(() => import('./timeline-json-inner'), {
  ssr: false,
  loading: () => (
    <p role="status" className="text-sm text-muted-foreground">
      Loading timeline JSON…
    </p>
  ),
});

export function TimelineJsonView(props: { projectId: string; version: number; sceneCount: number | null }) {
  return <TimelineJsonInner {...props} />;
}
