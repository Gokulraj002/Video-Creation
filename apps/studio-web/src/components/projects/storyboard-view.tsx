import { formatTimecode, type DirectorArtifacts, type Timeline } from '@vc/schema';
import { Camera, Clapperboard, Film, MessageSquareQuote, Type } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatFrameDuration } from '@/lib/duration';
import { humanizeSlug } from '@/lib/format';
import { ENGINE_LABELS } from '@/lib/options';
import { buildStoryboard, type StoryboardRow } from '@/lib/storyboard';

/** Chapters beyond this index start collapsed so multi-hour storyboards stay navigable. */
const OPEN_CHAPTERS = 3;

function SceneCard({ row, fps }: { row: StoryboardRow; fps: number }) {
  const end = row.startFrame + row.durationInFrames;
  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
        <span className="font-mono tabular-nums">
          #{row.index + 1} · {formatTimecode(row.startFrame, fps)} → {formatTimecode(end, fps)}
        </span>
        <span className="tabular-nums">
          {formatFrameDuration(row.durationInFrames, fps)} · {row.durationInFrames.toLocaleString('en-US')} f
        </span>
      </div>
      <CardContent className="flex flex-1 flex-col gap-3 p-4">
        <div className="space-y-1">
          <h4 className="font-semibold leading-snug">{row.title}</h4>
          <p className="line-clamp-2 text-sm text-muted-foreground">{row.primaryText}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant={row.engine === 'three' ? 'warning' : 'default'}>{ENGINE_LABELS[row.engine]}</Badge>
          {row.template ? <Badge variant="secondary">{row.template}</Badge> : null}
          {row.shotType ? <Badge variant="outline">{humanizeSlug(row.shotType)}</Badge> : null}
          {row.cameraPreset ? (
            <Badge variant="outline">
              <Camera />
              {row.cameraPreset}
            </Badge>
          ) : null}
          {row.transitionIn && row.transitionIn !== 'cut' ? (
            <Badge variant="muted">in: {row.transitionIn}</Badge>
          ) : null}
          {row.mood ? <Badge variant="muted">{row.mood}</Badge> : null}
        </div>
        {row.visualDescription ? <p className="text-sm leading-relaxed">{row.visualDescription}</p> : null}
        {row.voiceOver ? (
          <div className="flex gap-2 rounded-md bg-muted/60 p-2.5 text-sm">
            <MessageSquareQuote className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="italic leading-relaxed">“{row.voiceOver}”</p>
          </div>
        ) : null}
        {row.onScreenText ? (
          <div className="flex gap-2 text-sm">
            <Type className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="font-medium">{row.onScreenText}</p>
          </div>
        ) : null}
        {row.shots.length > 0 ? (
          <div className="mt-auto space-y-1.5 border-t pt-3">
            <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Film className="size-3.5" /> Shots
            </p>
            <ul className="space-y-1 text-xs">
              {row.shots.map((shot) => (
                <li key={shot.id} className="flex gap-2">
                  <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{shot.durationSeconds.toFixed(1)}s</span>
                  <span>
                    <span className="font-medium">{humanizeSlug(shot.shotType)}</span> ·{' '}
                    {humanizeSlug(shot.cameraMovement)} — {shot.subject}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {row.engineRationale ? (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">Engine rationale:</span> {row.engineRationale}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function StoryboardView({ artifacts, timeline }: { artifacts: DirectorArtifacts; timeline: Timeline }) {
  const chapters = buildStoryboard(artifacts, timeline);
  const fps = timeline.settings.fps;
  return (
    <div className="flex flex-col gap-6">
      {chapters.map((chapter, chapterIndex) => (
        <details key={chapter.id} open={chapterIndex < OPEN_CHAPTERS} className="group">
          <summary className="mb-3 flex cursor-pointer list-none flex-wrap items-baseline justify-between gap-2 rounded-md py-1 [&::-webkit-details-marker]:hidden">
            <span className="flex items-center gap-2">
              <Clapperboard className="size-4 text-primary" />
              <span className="font-semibold">
                {chapters.length > 1 ? `Chapter ${chapterIndex + 1}: ` : ''}
                {chapter.title}
              </span>
              <span className="text-xs text-muted-foreground group-open:hidden">(collapsed)</span>
            </span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {formatTimecode(chapter.startFrame, fps)} · {formatFrameDuration(chapter.durationInFrames, fps)} ·{' '}
              {chapter.rows.length} scene{chapter.rows.length === 1 ? '' : 's'}
            </span>
          </summary>
          {chapter.summary ? <p className="mb-3 max-w-3xl text-sm text-muted-foreground">{chapter.summary}</p> : null}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {chapter.rows.map((row) => (
              <SceneCard key={row.id} row={row} fps={fps} />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
