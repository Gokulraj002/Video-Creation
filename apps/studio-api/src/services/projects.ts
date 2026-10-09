import {
  checkVideoRequestLimits,
  type CreateProjectRequest,
  type ProjectDetailDTO,
  type ProjectSummaryPage,
  type ProjectVersionDTO,
  type ProjectVersionSummaryDTO,
  type ResourceLimits,
} from '@vc/schema';
import { ProjectStatus, type Prisma, type PrismaClient } from '../db';
import {
  projectInclude,
  runInclude,
  toProjectDetailDto,
  toProjectSummaryDto,
  toVersionDto,
  toVersionSummaryDto,
  type VersionSummaryRow,
} from '../lib/dto';
import { AppError, conflict, notFound } from '../lib/errors';
import { toJsonInput } from '../lib/json';
import { ACTIVE_RUN_STATUSES } from './project-status';

export interface ListProjectsOptions {
  limit: number;
  cursor: string | null;
}

export async function listProjects(
  prisma: PrismaClient,
  ownerId: string,
  { limit, cursor }: ListProjectsOptions,
): Promise<ProjectSummaryPage> {
  let where: Prisma.ProjectWhereInput = { ownerId };
  if (cursor !== null) {
    const anchor = await prisma.project.findFirst({
      where: { id: cursor, ownerId },
      select: { id: true, updatedAt: true },
    });
    if (anchor === null) throw new AppError(400, 'INVALID_CURSOR', 'Unknown pagination cursor');
    // Keyset pagination on (updatedAt desc, id desc).
    where = {
      ownerId,
      OR: [{ updatedAt: { lt: anchor.updatedAt } }, { updatedAt: anchor.updatedAt, id: { lt: anchor.id } }],
    };
  }
  const rows = await prisma.project.findMany({
    where,
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include: projectInclude,
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toProjectSummaryDto),
    nextCursor: rows.length > limit && last !== undefined ? last.id : null,
  };
}

export async function createProject(
  prisma: PrismaClient,
  ownerId: string,
  request: CreateProjectRequest,
  limits: ResourceLimits,
): Promise<ProjectDetailDTO> {
  const violations = checkVideoRequestLimits(request, limits);
  if (violations.length > 0) {
    throw new AppError(422, 'LIMIT_EXCEEDED', 'The request exceeds the configured resource limits', {
      violations,
    });
  }
  const project = await prisma.project.create({
    data: {
      ownerId,
      title: request.title,
      genre: request.genre,
      durationSeconds: request.durationSeconds,
      aspectRatio: request.aspectRatio,
      status: ProjectStatus.DRAFT,
      request: toJsonInput(request),
    },
    include: projectInclude,
  });
  return toProjectDetailDto(project, null);
}

export async function getProjectDetail(
  prisma: PrismaClient,
  ownerId: string,
  projectId: string,
): Promise<ProjectDetailDTO> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId },
    include: projectInclude,
  });
  if (project === null) throw notFound('Project');
  const latestRun = await prisma.directorRun.findFirst({
    where: { projectId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: runInclude,
  });
  return toProjectDetailDto(project, latestRun);
}

/** Deletes a project (cascades to versions and runs). Refused with 409 while a run is queued/running. */
export async function deleteProject(prisma: PrismaClient, ownerId: string, projectId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM projects WHERE id = ${projectId} AND owner_id = ${ownerId} FOR UPDATE`;
    if (locked.length === 0) throw notFound('Project');
    const active = await tx.directorRun.findFirst({
      where: { projectId, status: { in: ACTIVE_RUN_STATUSES } },
      select: { id: true },
    });
    if (active !== null) {
      throw conflict('RUN_ACTIVE', 'Cancel the active director run before deleting the project', {
        runId: active.id,
      });
    }
    await tx.project.delete({ where: { id: projectId } });
  });
}

async function assertOwnedProject(prisma: PrismaClient, ownerId: string, projectId: string): Promise<void> {
  const found = await prisma.project.findFirst({ where: { id: projectId, ownerId }, select: { id: true } });
  if (found === null) throw notFound('Project');
}

interface RawVersionSummary {
  id: string;
  project_id: string;
  version: number;
  schema_version: number;
  created_at: Date;
  scene_count: number | null;
  duration_in_frames: number | null;
  fps: number | null;
}

/** Version list, newest first. Scene count / duration / fps are read with jsonb operators (no full timeline load). */
export async function listVersions(
  prisma: PrismaClient,
  ownerId: string,
  projectId: string,
): Promise<ProjectVersionSummaryDTO[]> {
  await assertOwnedProject(prisma, ownerId, projectId);
  const rows = await prisma.$queryRaw<RawVersionSummary[]>`
    SELECT id,
           project_id,
           version,
           schema_version,
           created_at,
           jsonb_array_length(COALESCE(timeline->'scenes', '[]'::jsonb))::int AS scene_count,
           (timeline->>'durationInFrames')::int AS duration_in_frames,
           (timeline->'settings'->>'fps')::int AS fps
      FROM project_versions
     WHERE project_id = ${projectId}
     ORDER BY version DESC`;
  return rows.map((row) => {
    const summary: VersionSummaryRow = {
      id: row.id,
      projectId: row.project_id,
      version: row.version,
      schemaVersion: row.schema_version,
      createdAt: row.created_at,
      sceneCount: row.scene_count ?? 0,
      durationInFrames: row.duration_in_frames ?? 1,
      fps: row.fps ?? 30,
    };
    return toVersionSummaryDto(summary);
  });
}

export async function getVersion(
  prisma: PrismaClient,
  ownerId: string,
  projectId: string,
  version: number,
): Promise<ProjectVersionDTO> {
  await assertOwnedProject(prisma, ownerId, projectId);
  const row = await prisma.projectVersion.findUnique({
    where: { projectId_version: { projectId, version } },
  });
  if (row === null) throw notFound('Project version');
  return toVersionDto(row);
}
