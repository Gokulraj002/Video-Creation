import type { Script, ScriptChapter, ScriptSegment } from '@vc/schema';
import { Pager } from '@/components/pager';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDuration } from '@/lib/duration';
import { formatNumber } from '@/lib/format';
import { paginate } from '@/lib/project-tabs';

/** Script segments per page (multi-hour scripts have thousands). */
export const SCRIPT_SEGMENTS_PER_PAGE = 150;

interface SegmentRef {
  chapterIndex: number;
  segmentIndex: number;
  segment: ScriptSegment;
}

/** Consecutive segments of one chapter on the current page. */
interface ChapterGroup {
  chapter: ScriptChapter;
  chapterIndex: number;
  segments: SegmentRef[];
}

function groupByChapter(script: Script, refs: readonly SegmentRef[]): ChapterGroup[] {
  const groups: ChapterGroup[] = [];
  for (const ref of refs) {
    const last = groups[groups.length - 1];
    if (last && last.chapterIndex === ref.chapterIndex) {
      last.segments.push(ref);
      continue;
    }
    const chapter = script.chapters[ref.chapterIndex];
    if (chapter) groups.push({ chapter, chapterIndex: ref.chapterIndex, segments: [ref] });
  }
  return groups;
}

export function ScriptView({
  script,
  page,
  hrefForPage,
}: {
  script: Script;
  page: number;
  hrefForPage: (page: number) => string;
}) {
  const refs: SegmentRef[] = script.chapters.flatMap((chapter, chapterIndex) =>
    chapter.segments.map((segment, segmentIndex) => ({ chapterIndex, segmentIndex, segment })),
  );
  const slice = paginate(refs, page, SCRIPT_SEGMENTS_PER_PAGE);
  const groups = groupByChapter(script, slice.items);
  const numbered = script.chapters.length > 1;
  const pager = (
    <Pager
      label="Script pages"
      noun="segments"
      page={slice.page}
      pageCount={slice.pageCount}
      start={slice.start}
      shown={slice.items.length}
      total={slice.total}
      hrefFor={hrefForPage}
    />
  );
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Language: <span className="font-mono">{script.language}</span> · {formatNumber(script.chapters.length)} chapter
        {script.chapters.length === 1 ? '' : 's'} · {formatNumber(refs.length)} segments
      </p>
      {pager}
      {groups.map(({ chapter, chapterIndex, segments }) => {
        const continued = (segments[0]?.segmentIndex ?? 0) > 0;
        return (
          <Card key={chapter.id}>
            <CardHeader>
              <CardTitle>
                {numbered ? `${chapterIndex + 1}. ` : ''}
                {chapter.title}
                {continued ? <span className="font-normal text-muted-foreground"> (continued)</span> : null}
              </CardTitle>
              <CardDescription>
                {formatDuration(chapter.targetDurationSeconds)} target · {chapter.summary}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="flex flex-col divide-y" start={(segments[0]?.segmentIndex ?? 0) + 1}>
                {segments.map(({ segment, segmentIndex }) => (
                  <li key={segment.id} className="grid gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[4.5rem_minmax(0,1fr)]">
                    <div className="font-mono text-xs tabular-nums text-muted-foreground">
                      {segmentIndex + 1}. {formatDuration(segment.targetDurationSeconds)}
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
        );
      })}
      {pager}
    </div>
  );
}
