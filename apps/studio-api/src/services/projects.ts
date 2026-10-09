import {
  checkVideoRequestLimits,
  DbIdSchema,
  type CreateProjectRequest,
  type ProjectDetailDTO,
  type ProjectSummaryPage,
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
} from '../lib/dto';
import { AppError, conflict, notFound } from '../lib/errors';
import { toJsonInput } from '../lib/json';
import type { SizeBoundedLru } from '../lib/lru';
import { ACTIVE_RUN_STATUSES } from './project-status';

export interface ListProjectsOptions {
  limit: number;
  cursor: string | null;
}

/** Page of the owner's projects plus their total count (`total` is optional in ProjectSummaryPageSchema). */
export type ProjectSummaryPageWithTotal = ProjectSummaryPage & { total: number };

interface ProjectCursor {
  updatedAt: Date;
  id: string;
}

const CURSOR_SEPARATOR = '~';

/** Opaque keyset cursor: (updatedAt, id) of the last row served, base64url-encoded. */
export function encodeProjectCursor(cursor: ProjectCursor): string {
  return Buffer.from(`${cursor.updatedAt.toISOString()}${CURSOR_SEPARATOR}${cursor.id}`, 'utf8').toString('base64url');
}

export function decodeProjectCursor(raw: string): ProjectCursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const at = text.indexOf(CURSOR_SEPARATOR);
  if (at <= 0) return null;
  const iso = text.slice(0, at);
  const id = DbIdSchema.safeParse(text.slice(at + 1));
  const updatedAt = new Date(iso);
  if (!id.success || Number.isNaN(updatedAt.getTime()) || updatedAt.toISOString() !== iso) return null;
  return { updatedAt, id: id.data };
}

/**
 * Owner's projects, keyset-paginated on (updatedAt desc, id desc). The cursor carries the position of the
 * last row served (not a row reference), so rows touched or deleted between pages never cause duplicates or
 * errors; an undecodable cursor is 400 INVALID_CURSOR.
 */
export async function listProjects(
  prisma: PrismaClient,
  ownerId: string,
  { limit, cursor }: ListProjectsOptions,
): Promise<ProjectSummaryPageWithTotal> {
  let where: Prisma.ProjectWhereInput = { ownerId };
  if (cursor !== null) {
    const position = decodeProjectCursor(cursor);
    if (position === null) throw new AppError(400, 'INVALID_CURSOR', 'Invalid pagination cursor');
    where = {
      ownerId,
      OR: [{ updatedAt: { lt: position.updatedAt } }, { updatedAt: position.updatedAt, id: { lt: position.id } }],
    };
  }
  const [rows, total] = await Promise.all([
    prisma.project.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: projectInclude,
    }),
    prisma.project.count({ where: { ownerId } }),
  ]);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toProjectSummaryDto),
    nextCursor: rows.length > limit && last !== undefined ? encodeProjectCursor(last) : null,
    total,
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

/** The version list is not paginated (its DTO is a plain array): it returns the latest versions only. */
export const VERSION_LIST_LIMIT = 100;

/**
 * Latest VERSION_LIST_LIMIT versions, newest first, from the summary columns written with each version
 * (the timeline JSON is never loaded for the list).
 */
export async function listVersions(
  prisma: PrismaClient,
  ownerId: string,
  projectId: string,
): Promise<ProjectVersionSummaryDTO[]> {
  await assertOwnedProject(prisma, ownerId, projectId);
  const rows = await prisma.projectVersion.findMany({
    where: { projectId },
    orderBy: { version: 'desc' },
    take: VERSION_LIST_LIMIT,
    select: {
      id: true,
      projectId: true,
      version: true,
      schemaVersion: true,
      createdAt: true,
      sceneCount: true,
      durationInFrames: true,
      fps: true,
    },
  });
  return rows.map(toVersionSummaryDto);
}

/** Owner-scoped id of a project version (404 when the project or the version does not exist / is not owned). */
export async function findVersionId(
  prisma: PrismaClient,
  ownerId: string,
  projectId: string,
  version: number,
): Promise<string> {
  const row = await prisma.projectVersion.findFirst({
    where: { projectId, version, project: { ownerId } },
    select: { id: true },
  });
  if (row !== null) return row.id;
  await assertOwnedProject(prisma, ownerId, projectId);
  throw notFound('Project version');
}

/**
 * Serialized ProjectVersionDTO of a version id. Versions are immutable, so the validated + migrated JSON is
 * cached (byte-bounded LRU): a version is loaded and validated once per process, not on every view.
 */
export async function versionDtoJson(prisma: PrismaClient, cache: SizeBoundedLru | null, versionId: string): Promise<string> {
  const cached = cache?.get(versionId);
  if (cached !== undefined) return cached;
  const row = await prisma.projectVersion.findUnique({ where: { id: versionId } });
  if (row === null) throw notFound('Project version');
  const json = JSON.stringify(toVersionDto(row));
  cache?.set(versionId, json);
  return json;
}
