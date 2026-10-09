import type { ProjectSummaryDTO } from '@vc/schema';
import Link from 'next/link';
import { ProjectStatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDuration } from '@/lib/duration';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { genreLabel } from '@/lib/options';

export function ProjectsTable({ projects, now }: { projects: readonly ProjectSummaryDTO[]; now: number }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Project</TableHead>
          <TableHead className="hidden md:table-cell">Genre</TableHead>
          <TableHead className="hidden sm:table-cell">Duration</TableHead>
          <TableHead className="hidden lg:table-cell">Aspect</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="hidden sm:table-cell">Version</TableHead>
          <TableHead className="text-right">Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {projects.map((project) => (
          <TableRow key={project.id}>
            <TableCell className="max-w-72">
              <Link
                href={`/projects/${encodeURIComponent(project.id)}`}
                className="block truncate font-medium hover:text-primary hover:underline"
              >
                {project.title}
              </Link>
              <span className="text-xs text-muted-foreground md:hidden">{genreLabel(project.genre)}</span>
            </TableCell>
            <TableCell className="hidden md:table-cell">
              <Badge variant="secondary">{genreLabel(project.genre)}</Badge>
            </TableCell>
            <TableCell className="hidden tabular-nums sm:table-cell">{formatDuration(project.durationSeconds)}</TableCell>
            <TableCell className="hidden tabular-nums lg:table-cell">{project.aspectRatio}</TableCell>
            <TableCell>
              <ProjectStatusBadge status={project.status} />
            </TableCell>
            <TableCell className="hidden tabular-nums sm:table-cell">
              {project.currentVersion ? `v${project.currentVersion}` : <span className="text-muted-foreground">—</span>}
            </TableCell>
            <TableCell className="whitespace-nowrap text-right text-muted-foreground" title={formatDateTime(project.updatedAt)}>
              {formatRelativeTime(project.updatedAt, now)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
