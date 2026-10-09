'use client';

import dynamic from 'next/dynamic';
import { useEffect } from 'react';
import { prefetchTimeline } from './timeline-fetch';

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
  const { projectId, version } = props;
  // Start the download while the inner chunk loads.
  useEffect(() => prefetchTimeline(projectId, version), [projectId, version]);
  return <TimelineJsonInner {...props} />;
}
