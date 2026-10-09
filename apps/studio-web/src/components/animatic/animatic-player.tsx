'use client';

import { lazy, Suspense, useEffect, useState } from 'react';
import { AnimaticPlaceholder } from './animatic-placeholder';

export interface AnimaticPlayerProps {
  projectId: string;
  version: number;
  /** Output size (for the placeholder's aspect ratio before the timeline has loaded). */
  width: number;
  height: number;
}

/** Remotion Player + timeline loading live in their own chunk. */
const AnimaticPlayerInner = lazy(() => import('./animatic-player-inner'));

/**
 * Remotion's Player is browser-only: it is mounted on the client only (the server renders a sized placeholder) and
 * fetches the timeline itself from the timeline route handler, so the (possibly multi-MB) timeline is never
 * serialized into the page.
 */
export function AnimaticPlayer(props: AnimaticPlayerProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const placeholder = <AnimaticPlaceholder width={props.width} height={props.height} label="Loading animatic player…" />;
  if (!mounted) return placeholder;
  return (
    <Suspense fallback={placeholder}>
      <AnimaticPlayerInner {...props} />
    </Suspense>
  );
}
