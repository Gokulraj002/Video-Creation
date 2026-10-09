import type { Timeline } from '@vc/schema';
import { formatNumber } from '@/lib/format';
import { CopyButton } from './copy-button';

export function TimelineJsonView({ timeline }: { timeline: Timeline }) {
  const json = JSON.stringify(timeline, null, 2);
  const id = 'timeline-json';
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Timeline schema v{timeline.schemaVersion} · {formatNumber(timeline.scenes.length)} scenes ·{' '}
          {formatNumber(timeline.tracks.length)} tracks · {formatNumber(json.length)} characters
        </p>
        <CopyButton targetId={id} label="Copy JSON" />
      </div>
      <pre
        id={id}
        className="max-h-[70vh] overflow-auto rounded-xl border bg-muted/40 p-4 font-mono text-xs leading-relaxed"
      >
        {json}
      </pre>
    </div>
  );
}
