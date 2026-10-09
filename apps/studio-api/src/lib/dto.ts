import type { z } from 'zod';
import {
  AspectRatioSchema,
  DirectorArtifactsSchema,
  DirectorRunProgressSchema,
  formatZodIssues,
  safeParseTimeline,
  UsageReportSchema,
  VideoGenreSchema,
  VideoRequestSchema,
  type DirectorRunDTO,
  type DirectorRunProgress,
  type DirectorRunStatus,
  type MeDTO,
  type ProjectDetailDTO,
  type ProjectStatus as ProjectStatusDTO,
  type ProjectSummaryDTO,
  type ProjectVersionDTO,
  type ProjectVersionSummaryDTO,
} from '@vc/schema';
import type { Prisma, ProjectStatus, RunStatus } from '../db';
import { DataIntegrityError, notFound } from './errors';

// ---------------------------------------------------------------------------------------------
// Prisma include shapes used with the mappers
// ---------------------------------------------------------------------------------------------

export const runInclude = { version: { select: { version: true } } } satisfies Prisma.DirectorRunInclude;
export type RunRow = Prisma.DirectorRunGetPayload<{ include: typeof runInclude }>;

export const projectInclude = {
  currentVersion: { select: { version: true } },
} satisfies Prisma.ProjectInclude;
export type ProjectRow = Prisma.ProjectGetPayload<{ include: typeof projectInclude }>;

export type VersionRow = Prisma.ProjectVersionGetPayload<object>;

export interface VersionSummaryRow {
  id: string;
  projectId: string;
  version: number;
  schemaVersion: number;
  createdAt: Date;
  sceneCount: number;
  durationInFrames: number;
  fps: number;
}

// ---------------------------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------------------------

const PROJECT_STATUS: Record<ProjectStatus, ProjectStatusDTO> = {
  DRAFT: 'draft',
  DIRECTING: 'directing',
  READY: 'ready',
  FAILED: 'failed',
};

const RUN_STATUS: Record<RunStatus, DirectorRunStatus> = {
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export const toProjectStatusDto = (status: ProjectStatus): ProjectStatusDTO => PROJECT_STATUS[status];
export const toRunStatusDto = (status: RunStatus): DirectorRunStatus => RUN_STATUS[status];

const iso = (d: Date): string => d.toISOString();

type SafeResult<T> = { success: true; data: T } | { success: false; error: z.ZodError };

/** Unwraps a safeParse of STORED data: a failure is a data-integrity problem (500), never a client 400. */
function stored<T>(result: SafeResult<T>, entity: string, entityId: string): T {
  if (result.success) return result.data;
  throw new DataIntegrityError(entity, entityId, formatZodIssues(result.error, 20));
}
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

// ---------------------------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------------------------

export function toMeDto(user: { id: string; email: string; name: string | null }): MeDTO {
  return { id: user.id, email: user.email, name: user.name };
}

export const EMPTY_PROGRESS: DirectorRunProgress = {
  completedSteps: 0,
  totalSteps: 0,
  currentStage: null,
  message: null,
};

export function toDirectorRunDto(run: RunRow): DirectorRunDTO {
  // Runs of deleted projects are kept only for usage accounting and are not addressable.
  if (run.projectId === null) throw notFound('Director run');
  const progress = DirectorRunProgressSchema.safeParse(run.progress);
  const usage = run.usage === null ? null : UsageReportSchema.safeParse(run.usage);
  return {
    id: run.id,
    projectId: run.projectId,
    status: toRunStatusDto(run.status),
    provider: run.provider,
    model: run.model,
    progress: progress.success ? progress.data : EMPTY_PROGRESS,
    usage: usage?.success === true ? usage.data : null,
    error: run.errorCode === null ? null : { code: run.errorCode, message: run.errorMessage ?? '' },
    versionNumber: run.version?.version ?? null,
    createdAt: iso(run.createdAt),
    startedAt: isoOrNull(run.startedAt),
    finishedAt: isoOrNull(run.finishedAt),
  };
}

export function toProjectSummaryDto(project: ProjectRow): ProjectSummaryDTO {
  return {
    id: project.id,
    title: project.title,
    status: toProjectStatusDto(project.status),
    genre: stored(VideoGenreSchema.safeParse(project.genre), 'project', project.id),
    durationSeconds: project.durationSeconds,
    aspectRatio: stored(AspectRatioSchema.safeParse(project.aspectRatio), 'project', project.id),
    createdAt: iso(project.createdAt),
    updatedAt: iso(project.updatedAt),
    currentVersion: project.currentVersion?.version ?? null,
  };
}

export function toProjectDetailDto(project: ProjectRow, latestRun: RunRow | null): ProjectDetailDTO {
  return {
    ...toProjectSummaryDto(project),
    request: stored(VideoRequestSchema.safeParse(project.request), 'project.request', project.id),
    latestRun: latestRun === null ? null : toDirectorRunDto(latestRun),
  };
}

export function toVersionSummaryDto(row: VersionSummaryRow): ProjectVersionSummaryDTO {
  return {
    id: row.id,
    projectId: row.projectId,
    version: row.version,
    schemaVersion: row.schemaVersion,
    createdAt: iso(row.createdAt),
    sceneCount: row.sceneCount,
    durationInFrames: row.durationInFrames,
    fps: row.fps,
  };
}

/**
 * Full version DTO. The stored timeline goes through `safeParseTimeline` so older schema versions migrate on
 * read; a row that fails validation is reported as DATA_INTEGRITY (500) instead of a client error.
 */
export function toVersionDto(row: VersionRow): ProjectVersionDTO {
  let timelineResult: ReturnType<typeof safeParseTimeline>;
  try {
    timelineResult = safeParseTimeline(row.timeline);
  } catch (err) {
    throw new DataIntegrityError('projectVersion.timeline', row.id, [err instanceof Error ? err.message : String(err)]);
  }
  const timeline = stored(timelineResult, 'projectVersion.timeline', row.id);
  const artifacts = stored(DirectorArtifactsSchema.safeParse(row.artifacts), 'projectVersion.artifacts', row.id);
  return {
    id: row.id,
    projectId: row.projectId,
    version: row.version,
    schemaVersion: timeline.schemaVersion,
    createdAt: iso(row.createdAt),
    sceneCount: timeline.scenes.length,
    durationInFrames: timeline.durationInFrames,
    fps: timeline.settings.fps,
    artifacts,
    timeline,
  };
}
