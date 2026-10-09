'use client';

import '@/lib/zod-jitless';
import { ApiErrorSchema, formatTimecode } from '@vc/schema';
import { ChevronRight, Clapperboard, LoaderCircle, RotateCcw } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { formatFrameDuration } from '@/lib/duration';
import { formatNumber } from '@/lib/format';
import {
  STORYBOARD_PAGE_SIZE,
  StoryboardPageSchema,
  type StoryboardChapterHeader,
  type StoryboardRow,
} from '@/lib/storyboard';
import { cn } from '@/lib/utils';
import { SceneCard } from './scene-card';

async function fetchRows(projectId: string, version: number, chapterId: string, offset: number) {
  const params = new URLSearchParams({ chapter: chapterId, offset: String(offset), limit: String(STORYBOARD_PAGE_SIZE) });
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/versions/${version}/storyboard?${params.toString()}`,
    { cache: 'no-store' },
  );
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope = ApiErrorSchema.safeParse(body);
    throw new Error(envelope.success ? envelope.data.error.message : `Could not load scenes (HTTP ${response.status}).`);
  }
  const page = StoryboardPageSchema.safeParse(body);
  if (!page.success || page.data.chapterId !== chapterId || page.data.offset !== offset) {
    throw new Error('Received unexpected storyboard data.');
  }
  return page.data;
}

/**
 * One storyboard chapter as a disclosure. Scene cards are rendered only while the chapter is expanded: the server
 * provides the first cards of the initially expanded chapters, the rest is fetched page by page on demand.
 */
export function StoryboardChapter({
  projectId,
  version,
  header,
  label,
  fps,
  initialRows,
  defaultOpen,
}: {
  projectId: string;
  version: number;
  header: StoryboardChapterHeader;
  label: string;
  fps: number;
  initialRows: StoryboardRow[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [rows, setRows] = useState<StoryboardRow[]>(initialRows);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const panelId = useId();
  const remaining = Math.max(0, header.sceneCount - rows.length);

  const load = async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const offset = rows.length;
      const page = await fetchRows(projectId, version, header.id, offset);
      setRows((current) => (current.length === offset ? [...current, ...page.rows] : current));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load scenes.');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && rows.length === 0 && header.sceneCount > 0) void load();
  };

  return (
    <section className="flex flex-col gap-3">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={toggle}
          className="flex w-full flex-wrap items-baseline justify-between gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex min-w-0 items-center gap-2">
            <ChevronRight
              className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
              aria-hidden="true"
            />
            <Clapperboard className="size-4 shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0 font-semibold">{label}</span>
          </span>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {formatTimecode(header.startFrame, fps)} · {formatFrameDuration(header.durationInFrames, fps)} ·{' '}
            {formatNumber(header.sceneCount)} scene{header.sceneCount === 1 ? '' : 's'}
          </span>
        </button>
      </h3>
      <div id={panelId} hidden={!open} className="flex flex-col gap-3">
        {open ? (
          <>
            {header.summary ? <p className="max-w-3xl text-sm text-muted-foreground">{header.summary}</p> : null}
            {rows.length > 0 ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {rows.map((row) => (
                  <SceneCard key={row.id} row={row} fps={fps} />
                ))}
              </div>
            ) : null}
            {loading ? (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> Loading scenes…
              </p>
            ) : null}
            {error ? (
              <div className="flex flex-wrap items-center gap-2 text-sm text-destructive">
                <p role="alert">{error}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
                  <RotateCcw /> Retry
                </Button>
              </div>
            ) : null}
            {!loading && !error && remaining > 0 && rows.length > 0 ? (
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
                  Show {formatNumber(Math.min(STORYBOARD_PAGE_SIZE, remaining))} more of {formatNumber(remaining)} remaining
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
