import { resolveDimensions, type DirectorRunDTO, type ProjectDetailDTO, type ProjectVersionSummaryDTO } from '@vc/schema';
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
import { cache, Suspense, type ReactNode } from 'react';
import { AnimaticPlayer } from '@/components/animatic/animatic-player';
import { ApiErrorAlert, ApiErrorState } from '@/components/api-error-state';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { ProjectBodySkeleton } from '@/components/page-skeleton';
import { BriefView } from '@/components/projects/brief-view';
import { DeleteProjectButton } from '@/components/projects/delete-project-button';
import { ProjectTabs, type ProjectTabLink } from '@/components/projects/project-tabs';
import { RequestView } from '@/components/projects/request-view';
import { RunPanel } from '@/components/projects/run-panel';
import { ScriptView } from '@/components/projects/script-view';
import { ShotListView } from '@/components/projects/shot-list-view';
import { StoryboardView } from '@/components/projects/storyboard-view';
import { TimelineJsonView } from '@/components/projects/timeline-json-view';
import { UsageView } from '@/components/projects/usage-view';
import { ProjectStatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { toClientRun } from '@/lib/client-run';
import { formatDuration } from '@/lib/duration';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { genreLabel } from '@/lib/options';
import {
  PROJECT_TABS,
  TABS_NEEDING_VERSION_PAYLOAD,
  availableTabs,
  parsePage,
  projectHref,
  resolveTab,
  type ProjectTabId,
} from '@/lib/project-tabs';
import { runErrorNotice } from '@/lib/run-actions';
import { isActiveRunStatus } from '@/lib/run-status';
import { storyboardFor } from '@/lib/storyboard';
import {
  attempt,
  findVersionSummary,
  getProject,
  getProjectVersion,
  getSystemConfig,
  listDirectorRuns,
  listProjectVersions,
} from '@/lib/studio-api';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;
type PageParams = { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> };

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

const TAB_ICONS: Readonly<Record<ProjectTabId, ReactNode>> = {
  storyboard: <Clapperboard />,
  preview: <MonitorPlay />,
  brief: <Sparkles />,
  script: <ScrollText />,
  shots: <Film />,
  timeline: <Braces />,
  usage: <ChartColumn />,
  request: <FileText />,
};

function outputSize(project: ProjectDetailDTO): { width: number; height: number } {
  try {
    return resolveDimensions(project.request);
  } catch {
    return { width: 1920, height: 1080 };
  }
}

/**
 * The project shell (header + run panel) is rendered only after the project itself has loaded — there is no
 * `loading.tsx` above this page — so a missing project produces a real HTTP 404 (`notFound()` before any byte is
 * streamed). Everything below the run panel streams inside a Suspense boundary.
 */
export default async function ProjectPage({ params, searchParams }: PageParams) {
  const { id } = await params;
  const query = await searchParams;
  const [projectResult, configResult] = await Promise.all([loadProject(id), attempt(() => getSystemConfig())]);

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
  const latestRun = project.latestRun;
  const runActive = latestRun ? isActiveRunStatus(latestRun.status) : false;
  const runErrorCode = firstParam(query.runError);
  const notice = runErrorCode && /^[A-Z0-9_]{1,64}$/.test(runErrorCode) ? runErrorNotice(runErrorCode) : null;
  const request = project.request;
  const now = Date.now();
  // Credit-spending runs need a confirmation; an unknown mode (config unavailable) is treated as live.
  const liveProvider = configResult.ok
    ? configResult.data.aiProvider.mode === 'mock'
      ? null
      : { label: `${configResult.data.aiProvider.name} (${configResult.data.aiProvider.model})` }
    : { label: 'the configured AI provider' };

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
        <RunPanel
          key={latestRun?.id ?? 'no-run'}
          projectId={project.id}
          initialRun={latestRun ? toClientRun(latestRun) : null}
          notice={notice}
          liveProvider={liveProvider}
        />
        <Suspense fallback={<ProjectBodySkeleton />}>
          <ProjectBody project={project} query={query} runActive={runActive} />
        </Suspense>
      </div>
    </>
  );
}

/** Versions nav, empty states and the ACTIVE tab only (each tab loads just what it renders). */
async function ProjectBody({
  project,
  query,
  runActive,
}: {
  project: ProjectDetailDTO;
  query: SearchParams;
  runActive: boolean;
}) {
  const basePath = `/projects/${encodeURIComponent(project.id)}`;
  const versionsResult = await attempt(() => listProjectVersions(project.id));
  const versions = versionsResult.ok ? [...versionsResult.data].sort((a, b) => a.version - b.version) : [];
  const requestedVersion = firstParam(query.version);
  const selectedVersion = pickVersion(requestedVersion, versions, project.currentVersion);
  const summary = findVersionSummary(versions, selectedVersion);
  const tabIds = availableTabs(selectedVersion !== null);
  const defaultTab = tabIds[0] ?? 'usage';
  const tab = resolveTab(firstParam(query.tab), tabIds);
  const page = parsePage(firstParam(query.page));
  // Keep `?version=` in links only when the URL chose one explicitly.
  const linkVersion = requestedVersion !== null && selectedVersion !== null && requestedVersion === String(selectedVersion) ? selectedVersion : null;
  const href = (target: ProjectTabId, targetPage?: number) =>
    projectHref(basePath, { version: linkVersion, tab: target, defaultTab, page: targetPage ?? null });

  const [versionResult, runsResult] = await Promise.all([
    selectedVersion !== null && TABS_NEEDING_VERSION_PAYLOAD.has(tab)
      ? attempt(() => getProjectVersion(project.id, selectedVersion))
      : Promise.resolve(null),
    tab === 'usage' ? attempt(() => listDirectorRuns(project.id)) : Promise.resolve(null),
  ]);
  const version = versionResult?.ok ? versionResult.data : null;
  const latestRun = project.latestRun;

  let panel: ReactNode = null;
  if (versionResult && !versionResult.ok) {
    panel = <ApiErrorAlert failure={versionResult.failure} title={`Could not load version ${selectedVersion}`} />;
  } else if (selectedVersion !== null && tab === 'preview') {
    const { width, height } = outputSize(project);
    panel = <AnimaticPlayer projectId={project.id} version={selectedVersion} width={width} height={height} />;
  } else if (selectedVersion !== null && tab === 'timeline') {
    panel = <TimelineJsonView projectId={project.id} version={selectedVersion} sceneCount={summary?.sceneCount ?? null} />;
  } else if (version && tab === 'storyboard') {
    panel = (
      <StoryboardView
        projectId={project.id}
        version={version.version}
        chapters={storyboardFor(version)}
        fps={version.timeline.settings.fps}
      />
    );
  } else if (version && tab === 'brief') {
    panel = <BriefView brief={version.artifacts.brief} />;
  } else if (version && tab === 'script') {
    panel = <ScriptView script={version.artifacts.script} page={page} hrefForPage={(p) => href('script', p)} />;
  } else if (version && tab === 'shots') {
    panel = <ShotListView artifacts={version.artifacts} page={page} hrefForPage={(p) => href('shots', p)} />;
  } else if (tab === 'usage') {
    const runs: DirectorRunDTO[] | null = runsResult?.ok ? runsResult.data : null;
    const usageRun =
      (selectedVersion !== null ? runs?.find((r) => r.versionNumber === selectedVersion) : undefined) ??
      (latestRun?.versionNumber === selectedVersion ? latestRun : null) ??
      latestRun;
    panel = (
      <>
        {runsResult && !runsResult.ok ? <ApiErrorAlert failure={runsResult.failure} title="Could not load the run history" /> : null}
        <UsageView run={usageRun} runs={runs} />
      </>
    );
  } else if (tab === 'request') {
    panel = <RequestView request={project.request} />;
  }

  const tabs: ProjectTabLink[] = PROJECT_TABS.filter((t) => tabIds.includes(t.value)).map((t) => ({
    value: t.value,
    label: t.label,
    icon: TAB_ICONS[t.value],
    href: href(t.value),
  }));

  return (
    <>
      {!versionsResult.ok ? <ApiErrorAlert failure={versionsResult.failure} title="Could not load versions" /> : null}

      {versions.length > 1 ? (
        <nav aria-label="Versions" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <ListVideo className="size-4" aria-hidden="true" /> Versions
          </span>
          {versions.map((v) => (
            <Link
              key={v.id}
              href={projectHref(basePath, { version: v.version, tab, defaultTab })}
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

      {selectedVersion === null ? (
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

      <ProjectTabs tabs={tabs} active={tab}>
        {panel}
      </ProjectTabs>
    </>
  );
}
