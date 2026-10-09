'use client';

import type { Timeline } from '@vc/schema';
import dynamic from 'next/dynamic';

/** Remotion's Player is browser-only: load it on the client (no SSR) behind a sized placeholder. */
const AnimaticPlayerInner = dynamic(() => import('./animatic-player-inner'), {
  ssr: false,
  loading: () => (
    <div className="flex aspect-video w-full animate-pulse items-center justify-center rounded-lg border bg-muted text-sm text-muted-foreground">
      Loading animatic player…
    </div>
  ),
});

export function AnimaticPlayer({ timeline }: { timeline: Timeline }) {
  return <AnimaticPlayerInner timeline={timeline} />;
}
