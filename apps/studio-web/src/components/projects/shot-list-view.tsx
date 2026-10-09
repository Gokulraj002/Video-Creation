import type { DirectorArtifacts, Shot } from '@vc/schema';
import { Pager } from '@/components/pager';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatNumber, humanizeSlug } from '@/lib/format';
import { paginate } from '@/lib/project-tabs';

/** Shots per page (multi-hour plans have thousands). */
export const SHOTS_PER_PAGE = 200;

interface ShotRow {
  key: string;
  sceneLabel: string;
  firstOfScene: boolean;
  shot: Shot;
}

export function ShotListView({
  artifacts,
  page,
  hrefForPage,
}: {
  artifacts: DirectorArtifacts;
  page: number;
  hrefForPage: (page: number) => string;
}) {
  const titles = new Map(artifacts.storyboard.scenes.map((s, i) => [s.id, `${i + 1}. ${s.title}`]));
  const rows: ShotRow[] = artifacts.shotList.scenes.flatMap((scene) =>
    scene.shots.map((shot, i) => ({
      key: `${scene.sceneId}-${shot.id}`,
      sceneLabel: titles.get(scene.sceneId) ?? scene.sceneId,
      firstOfScene: i === 0,
      shot,
    })),
  );
  const slice = paginate(rows, page, SHOTS_PER_PAGE);
  const pager = (
    <Pager
      label="Shot list pages"
      noun="shots"
      page={slice.page}
      pageCount={slice.pageCount}
      start={slice.start}
      shown={slice.items.length}
      total={slice.total}
      hrefFor={hrefForPage}
    />
  );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {formatNumber(rows.length)} shots across {formatNumber(artifacts.shotList.scenes.length)} scenes.
      </p>
      {pager}
      <div className="rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Scene</TableHead>
              <TableHead>Shot</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Camera</TableHead>
              <TableHead className="min-w-64">Subject</TableHead>
              <TableHead className="text-right">Duration</TableHead>
              <TableHead className="hidden min-w-48 lg:table-cell">Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {slice.items.map((row, i) => (
              <TableRow key={row.key}>
                <TableCell className="max-w-48 align-top">
                  {row.firstOfScene || i === 0 ? (
                    <span className="block truncate font-medium" title={row.sceneLabel}>
                      {row.sceneLabel}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="align-top font-mono text-xs text-muted-foreground">{row.shot.id}</TableCell>
                <TableCell className="whitespace-nowrap align-top">{humanizeSlug(row.shot.shotType)}</TableCell>
                <TableCell className="whitespace-nowrap align-top">{humanizeSlug(row.shot.cameraMovement)}</TableCell>
                <TableCell className="align-top">{row.shot.subject}</TableCell>
                <TableCell className="whitespace-nowrap text-right align-top tabular-nums">
                  {row.shot.durationSeconds.toFixed(1)}s
                </TableCell>
                <TableCell className="hidden align-top text-muted-foreground lg:table-cell">{row.shot.notes ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {pager}
    </div>
  );
}
