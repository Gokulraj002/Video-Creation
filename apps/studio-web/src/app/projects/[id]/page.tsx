import type { DirectorRunDTO, ProjectVersionSummaryDTO } from '@vc/schema';
import {
  BookText,
  Braces,
  ChartColumn,
  Clapperboard,
  FileText,
  Film,
  ListVideo,
  LoaderCircle,
  MonitorPlay,
  ScrollText,
  Sparkles,
} from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { AnimaticPlayer } from '@/components/animatic/animatic-player';
import { ApiErrorAlert, ApiErrorState } from '@/components/api-error-state';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { BriefView } from '@/components/projects/brief-view';
import { DeleteProjectButton } from '@/components/projects/delete-project-button';
import { ProjectTabs, type ProjectTab } from '@/components/projects/project-tabs';
import { RequestView } from '@/components/projects/request-view';
import { RunPanel } from '@/components/projects/run-panel';
import { ScriptView } from '@/components/projects/script-view';
import { ShotListView } from '@/components/projects/shot-list-view';
import { StoryboardView } from '@/components/projects/storyboard-view';
import { TimelineJsonView } from '@/components/projects/timeline-json-view';
import { UsageView } from '@/components/projects/usage-view';
import { ProjectStatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { formatDuration } from '@/lib/duration';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { genreLabel } from '@/lib/options';
import { runErrorNotice } from '@/lib/run-actions';
import { isActiveRunStatus } from '@/lib/run-status';
import {
  attempt,
  getProject,
  getProjectVersion,
  listDirectorRuns,
  listProjectVersions,
} from '@/lib/studio-api';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type PageParams = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Memoized per request so metadata and page share one API call. */
const loadProject = cache((id: string) => attempt(() => getProject(id)));

function firstParam(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v ?? null;
}

export async function generateMetadata({ params }: Pick<PageParams, 'params'>): Promise<Metadata> {
  const { id } = await params;
  const result = await loadProject(id);
  return { title: result.ok ? result.data.title : 'Project' };
}

function pickVersion(
  requested: string | null,
  versions: readonly ProjectVersionSummaryDTO[],
  current: number | null,
): number | null {
  const n = requested && /^\d+$/.test(requested) ? Number(requested) : null;
  if (n !== null && (versions.some((v) => v.version === n) || n === current)) return n;
  if (current !== null) return current;
  const latest = versions.reduce<number | null>((max, v) => (max === null || v.version > max ? v.version : max), null);
  return latest;
}

export default async function ProjectPage({ params, searchParams }: PageParams) {
  const { id } = await params;
  const query = await searchParams;
  const projectResult = await loadProject(id);

  if (!projectResult.ok) {
    if (projectResult.failure.kind === 'not_found') notFound();
    return (
      <>
        <PageHeader title="Project" eyebrow={<Link href="/projects">Projects</Link>} />
        <ApiErrorState failure={projectResult.failure} retryHref={`/projects/${encodeURIComponent(id)}`} />
      </>
    );
  }

  const project = projectResult.data;
  const [versionsResult, runsResult] = await Promise.all([
    attempt(() => listProjectVersions(project.id)),
    attempt(() => listDirectorRuns(project.id)),
  ]);
  const versions = versionsResult.ok ? [...versionsResult.data].sort((a, b) => a.version - b.version) : [];
  const runs: DirectorRunDTO[] | null = runsResult.ok ? runsResult.data : null;
  const selectedVersion = pickVersion(firstParam(query.version), versions, project.currentVersion);
  const versionResult = selectedVersion !== null ? await attempt(() => getProjectVersion(project.id, selectedVersion)) : null;
  const version = versionResult?.ok ? versionResult.data : null;

  const latestRun = project.latestRun;
  const runActive = latestRun ? isActiveRunStatus(latestRun.status) : false;
  const usageRun =
    (selectedVersion !== null ? runs?.find((r) => r.versionNumber === selectedVersion) : undefined) ??
    (latestRun?.versionNumber === selectedVersion ? latestRun : null) ??
    latestRun;
  const runErrorCode = firstParam(query.runError);
  const notice = runErrorCode && /^[A-Z0-9_]{1,64}$/.test(runErrorCode) ? runErrorNotice(runErrorCode) : null;
  const request = project.request;
  const now = Date.now();
  const basePath = `/projects/${encodeURIComponent(project.id)}`;

  const tabs: ProjectTab[] = [];
  if (version) {
    tabs.push(
      {
        value: 'storyboard',
        label: 'Storyboard',
        icon: <Clapperboard />,
        content: <StoryboardView artifacts={version.artifacts} timeline={version.timeline} />,
      },
      { value: 'preview', label: 'Preview', icon: <MonitorPlay />, content: <AnimaticPlayer timeline={version.timeline} /> },
      { value: 'brief', label: 'Brief', icon: <Sparkles />, content: <BriefView brief={version.artifacts.brief} /> },
      { value: 'script', label: 'Script', icon: <ScrollText />, content: <ScriptView script={version.artifacts.script} /> },
      { value: 'shots', label: 'Shot list', icon: <Film />, content: <ShotListView artifacts={version.artifacts} /> },
      { value: 'timeline', label: 'Timeline JSON', icon: <Braces />, content: <TimelineJsonView timeline={version.timeline} /> },
    );
  }
  tabs.push(
    { value: 'usage', label: 'Usage', icon: <ChartColumn />, content: <UsageView run={usageRun} runs={runs} /> },
    { value: 'request', label: 'Request', icon: <FileText />, content: <RequestView request={request} /> },
  );

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/projects" className="hover:text-foreground hover:underline">
            Projects
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 break-words">{project.title}</span>
            <ProjectStatusBadge status={project.status} />
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{genreLabel(project.genre)}</span>
            <span>·</span>
            <span>{formatDuration(project.durationSeconds)}</span>
            <span>·</span>
            <span>
              {project.aspectRatio} · {request.resolution} · {request.fps} fps
            </span>
            <span>·</span>
            <span title={formatDateTime(project.createdAt)}>Created {formatRelativeTime(project.createdAt, now)}</span>
          </span>
        }
        actions={<DeleteProjectButton projectId={project.id} title={project.title} disabled={runActive} />}
      />

      <div className="flex flex-col gap-6">
        <RunPanel key={latestRun?.id ?? 'no-run'} projectId={project.id} initialRun={latestRun} notice={notice} />

        {!versionsResult.ok ? <ApiErrorAlert failure={versionsResult.failure} title="Could not load versions" /> : null}
        {versionResult && !versionResult.ok ? (
          <ApiErrorAlert failure={versionResult.failure} title={`Could not load version ${selectedVersion}`} />
        ) : null}

        {versions.length > 1 ? (
          <nav aria-label="Versions" className="flex flex-wrap items-center gap-2 text-sm">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <ListVideo className="size-4" /> Versions
            </span>
            {versions.map((v) => (
              <Link
                key={v.id}
                href={`${basePath}?version=${v.version}`}
                aria-current={v.version === selectedVersion ? 'page' : undefined}
                className={cn(
                  'rounded-md border px-2.5 py-1 tabular-nums transition-colors hover:bg-accent',
                  v.version === selectedVersion ? 'border-primary bg-primary/10 font-medium' : 'bg-card',
                )}
                title={`${v.sceneCount} scenes · ${formatDateTime(v.createdAt)}`}
              >
                v{v.version}
                {v.version === project.currentVersion ? (
                  <Badge variant="muted" className="ml-1.5 px-1.5 py-0">
                    current
                  </Badge>
                ) : null}
              </Link>
            ))}
          </nav>
        ) : null}

        {!version && !(versionResult && !versionResult.ok) ? (
          runActive ? (
            <EmptyState
              icon={LoaderCircle}
              title="The AI Director is working on it"
              description="Brief, outline, script, storyboard, shot list, engine selection and scene specs are generated chapter by chapter, then compiled into a frame-accurate timeline. This page updates automatically."
            />
          ) : (
            <EmptyState
              icon={BookText}
              title="No version yet"
              description={
                latestRun?.status === 'failed'
                  ? 'The last director run failed. Review the error above and re-run the director.'
                  : latestRun?.status === 'cancelled'
                    ? 'The last director run was cancelled. Re-run the director to generate a version.'
                    : 'Start a director run to generate the brief, script, storyboard and timeline.'
              }
            />
          )
        ) : null}

        {/* Keyed by version so the default tab resets when a new version appears. */}
        <ProjectTabs key={version?.version ?? 'none'} tabs={tabs} defaultValue={tabs[0]?.value ?? 'usage'} />
      </div>
    </>
  );
}
