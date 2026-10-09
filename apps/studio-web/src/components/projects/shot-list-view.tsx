import type { DirectorArtifacts } from '@vc/schema';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { humanizeSlug } from '@/lib/format';

export function ShotListView({ artifacts }: { artifacts: DirectorArtifacts }) {
  const titles = new Map(artifacts.storyboard.scenes.map((s, i) => [s.id, { title: s.title, index: i }]));
  const totalShots = artifacts.shotList.scenes.reduce((n, s) => n + s.shots.length, 0);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {totalShots} shots across {artifacts.shotList.scenes.length} scenes.
      </p>
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
            {artifacts.shotList.scenes.flatMap((scene) => {
              const meta = titles.get(scene.sceneId);
              return scene.shots.map((shot, i) => (
                <TableRow key={`${scene.sceneId}-${shot.id}`}>
                  <TableCell className="max-w-48 align-top">
                    {i === 0 ? (
                      <span className="block truncate font-medium" title={meta?.title}>
                        {meta ? `${meta.index + 1}. ${meta.title}` : scene.sceneId}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="align-top font-mono text-xs text-muted-foreground">{shot.id}</TableCell>
                  <TableCell className="whitespace-nowrap align-top">{humanizeSlug(shot.shotType)}</TableCell>
                  <TableCell className="whitespace-nowrap align-top">{humanizeSlug(shot.cameraMovement)}</TableCell>
                  <TableCell className="align-top">{shot.subject}</TableCell>
                  <TableCell className="whitespace-nowrap text-right align-top tabular-nums">
                    {shot.durationSeconds.toFixed(1)}s
                  </TableCell>
                  <TableCell className="hidden align-top text-muted-foreground lg:table-cell">{shot.notes ?? '—'}</TableCell>
                </TableRow>
              ));
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
