'use client';

import '@/lib/zod-jitless';
import { Player, type CallbackListener, type PlayerRef } from '@remotion/player';
import { formatTimecode, type Timeline } from '@vc/schema';
import { RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTimeline } from '@/components/projects/timeline-loader';
import { Button } from '@/components/ui/button';
import { findSpanIndex } from '@/lib/animatic';
import { formatFrameDuration } from '@/lib/duration';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AnimaticComposition, type AnimaticProps } from './animatic-composition';
import type { AnimaticPlayerProps } from './animatic-player';
import { AnimaticPlaceholder } from './animatic-placeholder';

/** Above this many scenes the jump bar lists chapters instead of individual scenes. */
const MAX_SCENE_CHIPS = 120;

function LoadedPlayer({ timeline }: { timeline: Timeline }) {
  const playerRef = useRef<PlayerRef>(null);
  const [frame, setFrame] = useState(0);
  const inputProps = useMemo<AnimaticProps>(() => ({ timeline }), [timeline]);
  const { width, height, fps } = timeline.settings;

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onFrame: CallbackListener<'frameupdate'> = (event) => setFrame(event.detail.frame);
    const onSeek: CallbackListener<'seeked'> = (event) => setFrame(event.detail.frame);
    player.addEventListener('frameupdate', onFrame);
    player.addEventListener('seeked', onSeek);
    return () => {
      player.removeEventListener('frameupdate', onFrame);
      player.removeEventListener('seeked', onSeek);
    };
  }, []);

  const useChapters = timeline.scenes.length > MAX_SCENE_CHIPS;
  const marks = useChapters ? timeline.chapters : timeline.scenes;
  const activeIndex = findSpanIndex(marks, frame);
  const scenesByStart = useMemo(() => new Map(timeline.scenes.map((s) => [s.startFrame, s])), [timeline]);

  const seek = (target: number) => {
    playerRef.current?.seekTo(target);
    setFrame(target);
  };

  // A scene's first frames belong to its incoming transition, where the previous scene is still
  // showing; jump to the first fully visible frame instead. Chapter starts are scene starts too.
  const settledFrame = (startFrame: number) => {
    const scene = scenesByStart.get(startFrame);
    if (!scene) return startFrame;
    const settle = scene.transitionIn?.durationInFrames ?? 0;
    return Math.min(startFrame + settle, startFrame + scene.durationInFrames - 1);
  };

  return (
    <div className="flex flex-col gap-4">
      <div
        className="mx-auto w-full overflow-hidden rounded-lg border bg-black shadow-sm"
        style={{ maxWidth: `min(100%, calc(70vh * ${width / height}))` }}
      >
        <Player
          ref={playerRef}
          component={AnimaticComposition}
          inputProps={inputProps}
          durationInFrames={timeline.durationInFrames}
          compositionWidth={width}
          compositionHeight={height}
          fps={fps}
          controls
          loop
          clickToPlay
          doubleClickToFullscreen
          allowFullscreen
          // `spaceKeyToPlayOrPause` makes the Player focus its play button on mount and on every play/pause, which
          // steals focus from the tab list (keyboard users lose their place). Space still works on the focused
          // play button.
          spaceKeyToPlayOrPause={false}
          style={{ width: '100%', aspectRatio: `${width} / ${height}` }}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="font-mono tabular-nums">
          {formatTimecode(frame, fps)} / {formatTimecode(Math.max(0, timeline.durationInFrames - 1), fps)}
        </span>
        <span>
          {width}×{height} · {fps} fps · {formatNumber(timeline.durationInFrames)} frames ·{' '}
          {formatFrameDuration(timeline.durationInFrames, fps)}
        </span>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Jump to {useChapters ? 'chapter' : 'scene'}
        </p>
        <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
          {marks.map((mark, index) => (
            <button
              key={mark.id}
              type="button"
              onClick={() => seek(settledFrame(mark.startFrame))}
              title={`${mark.title} · ${formatTimecode(mark.startFrame, fps)}`}
              aria-current={index === activeIndex ? 'true' : undefined}
              className={cn(
                'max-w-56 truncate rounded-md border px-2 py-1 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground',
                index === activeIndex ? 'border-primary bg-primary/10 text-foreground' : 'bg-card text-muted-foreground',
              )}
            >
              <span className="mr-1 font-mono tabular-nums">{index + 1}.</span>
              {mark.title}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function AnimaticPlayerInner({ projectId, version, width, height }: AnimaticPlayerProps) {
  const { state, retry } = useTimeline(projectId, version);
  if (state.status === 'ready') return <LoadedPlayer timeline={state.timeline} />;
  if (state.status === 'error') {
    return (
      <AnimaticPlaceholder width={width} height={height} label={state.message} pulse={false}>
        <Button type="button" variant="outline" size="sm" onClick={retry}>
          <RotateCcw /> Retry
        </Button>
      </AnimaticPlaceholder>
    );
  }
  return <AnimaticPlaceholder width={width} height={height} label="Loading the timeline…" />;
}
