/**
 * HTTP contract between `@vc/studio-api` and `@vc/studio-web` (request bodies + response DTOs).
 * Timestamps are ISO-8601 strings; database ids are opaque non-empty strings.
 */
import { z } from 'zod';
import { IsoDateTimeSchema } from './common';
import {
  DirectorArtifactsSchema,
  DirectorStageSchema,
  UsageReportSchema,
  VideoGenreSchema,
  VideoRequestSchema,
} from './director';
import { ResourceLimitsSchema } from './limits';
import { AspectRatioSchema, FpsSchema } from './render-settings';
import { EngineTypeSchema } from './scene-content';
import { TemplateSummarySchema } from './templates/catalog';
import { TimelineSchema } from './timeline';

/** Opaque database identifier (e.g. a cuid). */
export const DbIdSchema = z.string().min(1).max(128);
export type DbId = z.infer<typeof DbIdSchema>;

const NonNegativeInt = z.number().int().min(0);

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/** `POST /v1/projects` body. */
export const CreateProjectRequestSchema = VideoRequestSchema;
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;
export type CreateProjectRequestInput = z.input<typeof CreateProjectRequestSchema>;

/** `POST /v1/projects/:id/director-runs` body (empty object; reserved for future options). */
export const CreateDirectorRunRequestSchema = z.object({});
export type CreateDirectorRunRequest = z.infer<typeof CreateDirectorRunRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------------------------

export const ProjectStatusSchema = z.enum(['draft', 'directing', 'ready', 'failed']);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const DirectorRunStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type DirectorRunStatus = z.infer<typeof DirectorRunStatusSchema>;

// ---------------------------------------------------------------------------------------------
// Director runs
// ---------------------------------------------------------------------------------------------

export const DirectorRunProgressSchema = z.object({
  completedSteps: NonNegativeInt,
  totalSteps: NonNegativeInt,
  currentStage: DirectorStageSchema.nullable(),
  message: z.string().nullable(),
});
export type DirectorRunProgress = z.infer<typeof DirectorRunProgressSchema>;

export const DirectorRunErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
});
export type DirectorRunError = z.infer<typeof DirectorRunErrorSchema>;

export const DirectorRunDTOSchema = z.object({
  id: DbIdSchema,
  projectId: DbIdSchema,
  status: DirectorRunStatusSchema,
  provider: z.string(),
  model: z.string(),
  progress: DirectorRunProgressSchema,
  usage: UsageReportSchema.nullable(),
  error: DirectorRunErrorSchema.nullable(),
  versionNumber: z.number().int().min(1).nullable(),
  createdAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  finishedAt: IsoDateTimeSchema.nullable(),
});
export type DirectorRunDTO = z.infer<typeof DirectorRunDTOSchema>;

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

export const ProjectSummaryDTOSchema = z.object({
  id: DbIdSchema,
  title: z.string(),
  status: ProjectStatusSchema,
  genre: VideoGenreSchema,
  durationSeconds: z.number().positive(),
  aspectRatio: AspectRatioSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  currentVersion: z.number().int().min(1).nullable(),
});
export type ProjectSummaryDTO = z.infer<typeof ProjectSummaryDTOSchema>;

export const ProjectDetailDTOSchema = ProjectSummaryDTOSchema.extend({
  request: VideoRequestSchema,
  latestRun: DirectorRunDTOSchema.nullable(),
});
export type ProjectDetailDTO = z.infer<typeof ProjectDetailDTOSchema>;

// ---------------------------------------------------------------------------------------------
// Project versions
// ---------------------------------------------------------------------------------------------

export const ProjectVersionSummaryDTOSchema = z.object({
  id: DbIdSchema,
  projectId: DbIdSchema,
  version: z.number().int().min(1),
  schemaVersion: z.number().int().min(1),
  createdAt: IsoDateTimeSchema,
  sceneCount: NonNegativeInt,
  durationInFrames: z.number().int().min(1),
  fps: FpsSchema,
});
export type ProjectVersionSummaryDTO = z.infer<typeof ProjectVersionSummaryDTOSchema>;

export const ProjectVersionDTOSchema = ProjectVersionSummaryDTOSchema.extend({
  artifacts: DirectorArtifactsSchema,
  timeline: TimelineSchema,
});
export type ProjectVersionDTO = z.infer<typeof ProjectVersionDTOSchema>;

// ---------------------------------------------------------------------------------------------
// System config
// ---------------------------------------------------------------------------------------------

export const AiProviderModeSchema = z.enum(['mock', 'live']);
export type AiProviderMode = z.infer<typeof AiProviderModeSchema>;

export const QueueDriverSchema = z.enum(['bullmq', 'inline']);
export type QueueDriver = z.infer<typeof QueueDriverSchema>;

export const AiProviderInfoSchema = z.object({
  name: z.string(),
  model: z.string(),
  mode: AiProviderModeSchema,
  configured: z.boolean(),
});
export type AiProviderInfo = z.infer<typeof AiProviderInfoSchema>;

export const EngineAvailabilityEntrySchema = z.object({
  engine: EngineTypeSchema,
  available: z.boolean(),
  reason: z.string().nullable(),
});
export type EngineAvailabilityEntry = z.infer<typeof EngineAvailabilityEntrySchema>;

/** `GET /v1/system/config` — never contains secrets. */
export const SystemConfigDTOSchema = z.object({
  aiProvider: AiProviderInfoSchema,
  queueDriver: QueueDriverSchema,
  limits: ResourceLimitsSchema,
  engines: z.array(EngineAvailabilityEntrySchema),
  templates: z.array(TemplateSummarySchema),
  promptVersion: z.string(),
});
export type SystemConfigDTO = z.infer<typeof SystemConfigDTOSchema>;

// ---------------------------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------------------------

export const UsageWindowSchema = z.object({
  runs: NonNegativeInt,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  cacheWriteTokens: NonNegativeInt,
  estimatedCostUsd: z.number().min(0),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

/** `GET /v1/usage` (today = current UTC day). */
export const UsageSummaryDTOSchema = z.object({
  today: UsageWindowSchema,
  month: UsageWindowSchema,
});
export type UsageSummaryDTO = z.infer<typeof UsageSummaryDTOSchema>;

// ---------------------------------------------------------------------------------------------
// Me, errors, pagination
// ---------------------------------------------------------------------------------------------

export const MeDTOSchema = z.object({
  id: DbIdSchema,
  email: z.string().min(1).max(320),
  name: z.string().nullable(),
});
export type MeDTO = z.infer<typeof MeDTOSchema>;

/** Error envelope for every non-2xx response. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * Cursor-paginated list envelope: `{items, nextCursor, total?}` (`nextCursor` null on the last page; `total`, when
 * present, is the number of matching items over ALL pages).
 */
export function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().min(1).nullable(),
    total: NonNegativeInt.optional(),
  });
}
export type Paginated<T> = { items: T[]; nextCursor: string | null; total?: number };

export const ProjectSummaryPageSchema = paginated(ProjectSummaryDTOSchema);
export type ProjectSummaryPage = z.infer<typeof ProjectSummaryPageSchema>;

// ---------------------------------------------------------------------------------------------
// Aliases (spec names without the DTO suffix)
// ---------------------------------------------------------------------------------------------

export const ProjectSummarySchema = ProjectSummaryDTOSchema;
export type ProjectSummary = ProjectSummaryDTO;
export const ProjectDetailSchema = ProjectDetailDTOSchema;
export type ProjectDetail = ProjectDetailDTO;
export const DirectorRunSchema = DirectorRunDTOSchema;
export type DirectorRun = DirectorRunDTO;
export const ProjectVersionSummarySchema = ProjectVersionSummaryDTOSchema;
export type ProjectVersionSummary = ProjectVersionSummaryDTO;
export const ProjectVersionSchema = ProjectVersionDTOSchema;
export type ProjectVersion = ProjectVersionDTO;
export const SystemConfigSchema = SystemConfigDTOSchema;
export type SystemConfig = SystemConfigDTO;
export const UsageSummarySchema = UsageSummaryDTOSchema;
export type UsageSummary = UsageSummaryDTO;
export const MeSchema = MeDTOSchema;
export type Me = MeDTO;
