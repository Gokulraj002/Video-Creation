import type { DirectorRunStatus, ProjectStatus } from '@vc/schema';
import { CircleCheck, CircleDashed, CircleSlash, CircleX, LoaderCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { PROJECT_STATUS_META, RUN_STATUS_META } from '@/lib/run-status';

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const meta = PROJECT_STATUS_META[status];
  return (
    <Badge variant={meta.variant}>
      {status === 'directing' ? <LoaderCircle className="animate-spin" /> : null}
      {status === 'ready' ? <CircleCheck /> : null}
      {status === 'failed' ? <CircleX /> : null}
      {status === 'draft' ? <CircleDashed /> : null}
      {meta.label}
    </Badge>
  );
}

export function RunStatusBadge({ status }: { status: DirectorRunStatus }) {
  const meta = RUN_STATUS_META[status];
  return (
    <Badge variant={meta.variant}>
      {status === 'running' ? <LoaderCircle className="animate-spin" /> : null}
      {status === 'queued' ? <CircleDashed /> : null}
      {status === 'succeeded' ? <CircleCheck /> : null}
      {status === 'failed' ? <CircleX /> : null}
      {status === 'cancelled' ? <CircleSlash /> : null}
      {meta.label}
    </Badge>
  );
}
