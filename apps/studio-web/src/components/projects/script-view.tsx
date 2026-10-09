import type { Script } from '@vc/schema';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDuration } from '@/lib/duration';

export function ScriptView({ script }: { script: Script }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Language: <span className="font-mono">{script.language}</span> · {script.chapters.length} chapter
        {script.chapters.length === 1 ? '' : 's'} ·{' '}
        {script.chapters.reduce((n, c) => n + c.segments.length, 0)} segments
      </p>
      {script.chapters.map((chapter, ci) => (
        <Card key={chapter.id}>
          <CardHeader>
            <CardTitle>
              {script.chapters.length > 1 ? `${ci + 1}. ` : ''}
              {chapter.title}
            </CardTitle>
            <CardDescription>
              {formatDuration(chapter.targetDurationSeconds)} target · {chapter.summary}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col divide-y">
              {chapter.segments.map((segment, si) => (
                <li key={segment.id} className="grid gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[4.5rem_minmax(0,1fr)]">
                  <div className="font-mono text-xs tabular-nums text-muted-foreground">
                    {si + 1}. {formatDuration(segment.targetDurationSeconds)}
                  </div>
                  <div className="space-y-1.5 text-sm">
                    {segment.voiceOver ? (
                      <p className="leading-relaxed">
                        <span className="mr-1.5 text-xs font-semibold uppercase tracking-wide text-primary">VO</span>
                        {segment.voiceOver}
                      </p>
                    ) : null}
                    {segment.onScreenText ? (
                      <p>
                        <span className="mr-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          On screen
                        </span>
                        <span className="font-medium">{segment.onScreenText}</span>
                      </p>
                    ) : null}
                    <p className="text-muted-foreground">
                      <span className="mr-1.5 text-xs font-semibold uppercase tracking-wide">Visual</span>
                      {segment.visualIntent}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
