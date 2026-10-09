'use client';

import { Download, LoaderCircle, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { formatNumber } from '@/lib/format';
import { CopyButton } from './copy-button';
import { useTimeline } from './timeline-loader';

/** Characters of pretty-printed JSON rendered before "Show all" (copy / download always use the full JSON). */
const PREVIEW_CHARS = 200_000;

export default function TimelineJsonInner({
  projectId,
  version,
  sceneCount,
}: {
  projectId: string;
  version: number;
  sceneCount: number | null;
}) {
  const { state, retry } = useTimeline(projectId, version);
  const timeline = state.status === 'ready' ? state.timeline : null;
  const json = useMemo(() => (timeline ? JSON.stringify(timeline, null, 2) : ''), [timeline]);
  const [showAll, setShowAll] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  useEffect(() => {
    if (json === '') return;
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [json]);

  if (state.status === 'loading') {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        Loading the timeline{sceneCount !== null ? ` (${formatNumber(sceneCount)} scenes)` : ''}…
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-destructive">
        <p role="alert">{state.message}</p>
        <Button type="button" variant="outline" size="sm" onClick={retry}>
          <RotateCcw /> Retry
        </Button>
      </div>
    );
  }

  const truncated = !showAll && json.length > PREVIEW_CHARS;
  const shown = truncated ? json.slice(0, PREVIEW_CHARS) : json;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Timeline schema v{state.timeline.schemaVersion} · {formatNumber(state.timeline.scenes.length)} scenes ·{' '}
          {formatNumber(state.timeline.tracks.length)} tracks · {formatNumber(json.length)} characters
        </p>
        <div className="flex flex-wrap gap-2">
          <CopyButton getText={() => json} label="Copy JSON" />
          {downloadUrl ? (
            <Button asChild variant="outline" size="sm">
              <a href={downloadUrl} download={`timeline-v${version}.json`}>
                <Download /> Download
              </a>
            </Button>
          ) : null}
        </div>
      </div>
      <pre
        tabIndex={0}
        aria-label="Timeline JSON"
        className="max-h-[70vh] overflow-auto rounded-xl border bg-muted/40 p-4 font-mono text-xs leading-relaxed"
      >
        {shown}
      </pre>
      {truncated ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>
            Showing the first {formatNumber(PREVIEW_CHARS)} of {formatNumber(json.length)} characters (copy and download
            include everything).
          </span>
          <Button type="button" variant="outline" size="sm" onClick={() => setShowAll(true)}>
            Show all
          </Button>
        </div>
      ) : null}
    </div>
  );
}
