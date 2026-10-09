'use client';

import { lazy, Suspense, useEffect, useState } from 'react';
import { prefetchTimeline } from '@/components/projects/timeline-fetch';
import { AnimaticPlaceholder } from './animatic-placeholder';

export interface AnimaticPlayerProps {
  projectId: string;
  version: number;
  /** Output size (for the placeholder's aspect ratio before the timeline has loaded). */
  width: number;
  height: number;
}

/** Remotion Player + timeline validation live in their own chunk. */
const loadInner = () => import('./animatic-player-inner');
const AnimaticPlayerInner = lazy(loadInner);

/**
 * Remotion's Player is browser-only: it is mounted on the client only (the server renders a sized placeholder) and
 * fetches the timeline itself from the timeline route handler, so the (possibly multi-MB) timeline is never
 * serialized into the page.
 */
export function AnimaticPlayer(props: AnimaticPlayerProps) {
  const [mounted, setMounted] = useState(false);
  const { projectId, version } = props;
  useEffect(() => {
    // Download the timeline and the player chunk in parallel instead of one after the other.
    prefetchTimeline(projectId, version);
    void loadInner();
    setMounted(true);
  }, [projectId, version]);
  const placeholder = <AnimaticPlaceholder width={props.width} height={props.height} label="Loading animatic player…" />;
  if (!mounted) return placeholder;
  return (
    <Suspense fallback={placeholder}>
      <AnimaticPlayerInner {...props} />
    </Suspense>
  );
}
