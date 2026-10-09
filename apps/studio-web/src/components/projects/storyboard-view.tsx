import { formatNumber } from '@/lib/format';
import { planStoryboard, type StoryboardChapter as StoryboardChapterData } from '@/lib/storyboard';
import { StoryboardChapter } from './storyboard-chapter';

/**
 * Storyboard tab: one disclosure per chapter. Only the first chapters start expanded and only a bounded number of
 * scene cards is rendered up front (`planStoryboard`); other chapters load their cards when expanded.
 */
export function StoryboardView({
  projectId,
  version,
  chapters,
  fps,
}: {
  projectId: string;
  version: number;
  chapters: readonly StoryboardChapterData[];
  fps: number;
}) {
  const planned = planStoryboard(chapters);
  const totalScenes = chapters.reduce((n, c) => n + c.rows.length, 0);
  const rendered = planned.reduce((n, p) => n + p.initialRows.length, 0);
  const numbered = chapters.length > 1;
  return (
    <div className="flex flex-col gap-6">
      {rendered < totalScenes ? (
        <p className="text-sm text-muted-foreground">
          {formatNumber(totalScenes)} scenes in {formatNumber(chapters.length)} chapters. Expand a chapter to see its scenes.
        </p>
      ) : null}
      {planned.map((plan, index) => (
        <StoryboardChapter
          key={plan.header.id}
          projectId={projectId}
          version={version}
          header={plan.header}
          label={`${numbered ? `Chapter ${index + 1}: ` : ''}${plan.header.title}`}
          fps={fps}
          initialRows={plan.initialRows}
          defaultOpen={plan.open}
        />
      ))}
    </div>
  );
}
