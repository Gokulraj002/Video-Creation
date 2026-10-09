import 'server-only';

import {
  ApiErrorSchema,
  CreateProjectRequestSchema,
  DbIdSchema,
  DirectorRunDTOSchema,
  MeDTOSchema,
  ProjectDetailDTOSchema,
  ProjectSummaryPageSchema,
  ProjectVersionDTOSchema,
  ProjectVersionSummaryDTOSchema,
  SystemConfigDTOSchema,
  UsageSummaryDTOSchema,
  type CreateProjectRequest,
  type DirectorRunDTO,
  type MeDTO,
  type ProjectDetailDTO,
  type ProjectSummaryPage,
  type ProjectVersionDTO,
  type ProjectVersionSummaryDTO,
  type SystemConfigDTO,
  type UsageSummaryDTO,
} from '@vc/schema';
import { z } from 'zod';
import type { ApiFailure, ApiFailureKind } from './api-failure';

/**
 * Server-only client for `@vc/studio-api`. Reads `STUDIO_API_URL` + `STUDIO_API_TOKEN` (never `NEXT_PUBLIC_`),
 * validates EVERY response body with the `@vc/schema` DTO schemas and throws `StudioApiError` on any failure.
 * The token is only ever placed in the outgoing `Authorization` header — it is never logged or returned.
 */

const DEFAULT_API_URL = 'http://localhost:4100';
const REQUEST_TIMEOUT_MS = 15_000;

export class StudioApiError extends Error {
  readonly kind: ApiFailureKind;
  readonly status: number | null;
  readonly code: string;
  readonly details: unknown;
  readonly apiUrl: string | null;

  constructor(init: {
    kind: ApiFailureKind;
    message: string;
    code: string;
    status?: number | null;
    details?: unknown;
    apiUrl?: string | null;
  }) {
    super(init.message);
    this.name = 'StudioApiError';
    this.kind = init.kind;
    this.code = init.code;
    this.status = init.status ?? null;
    this.details = init.details;
    this.apiUrl = init.apiUrl ?? null;
  }

  /** Serializable, token-free view for rendering (Server → Client Components). */
  toFailure(): ApiFailure {
    return { kind: this.kind, status: this.status, code: this.code, message: this.message, apiUrl: this.apiUrl };
  }
}

export function isStudioApiError(error: unknown): error is StudioApiError {
  return error instanceof StudioApiError;
}

interface StudioApiConfig {
  baseUrl: string;
  token: string | null;
}

/** Public, non-secret view of the connection settings (for the Settings page). */
export function getStudioApiConnectionInfo(): { baseUrl: string; tokenConfigured: boolean } {
  const raw = process.env.STUDIO_API_URL?.trim();
  return {
    baseUrl: (raw && raw !== '' ? raw : DEFAULT_API_URL).replace(/\/+$/, ''),
    tokenConfigured: (process.env.STUDIO_API_TOKEN ?? '').trim() !== '',
  };
}

function readConfig(requireToken: boolean): StudioApiConfig {
  const { baseUrl } = getStudioApiConnectionInfo();
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new StudioApiError({
      kind: 'not_configured',
      code: 'CONFIG_INVALID_URL',
      message: `STUDIO_API_URL "${baseUrl}" is not a valid URL.`,
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new StudioApiError({
      kind: 'not_configured',
      code: 'CONFIG_INVALID_URL',
      message: 'STUDIO_API_URL must use http or https.',
    });
  }
  const token = (process.env.STUDIO_API_TOKEN ?? '').trim();
  if (token === '' && requireToken) {
    throw new StudioApiError({
      kind: 'not_configured',
      code: 'CONFIG_MISSING_TOKEN',
      message: 'STUDIO_API_TOKEN is not set, so the web app cannot authenticate to the Studio API.',
      apiUrl: baseUrl,
    });
  }
  return { baseUrl, token: token === '' ? null : token };
}

function kindForStatus(status: number): ApiFailureKind {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  return 'http';
}

function defaultCodeForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'VALIDATION_ERROR';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'LIMIT_EXCEEDED';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL' : `HTTP_${status}`;
  }
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return `The request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`;
    }
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return error.message;
  }
  return 'Network error.';
}

/** Shortens a Zod error for logs / messages without dumping payloads. */
function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

type HttpMethod = 'GET' | 'POST' | 'DELETE';

interface SendOptions {
  body?: unknown;
  /** `false` only for public endpoints (`/health`). */
  auth?: boolean;
}

async function send(method: HttpMethod, path: string, opts: SendOptions = {}): Promise<{ status: number; json: unknown }> {
  const auth = opts.auth ?? true;
  const { baseUrl, token } = readConfig(auth);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (auth && token !== null) headers.Authorization = `Bearer ${token}`;
  const body = opts.body;
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: payload,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new StudioApiError({
      kind: 'unreachable',
      code: 'API_UNREACHABLE',
      message: describeNetworkError(error),
      apiUrl: baseUrl,
    });
  }

  const raw = await response.text().catch(() => '');
  let json: unknown = null;
  if (raw !== '') {
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
  }

  if (!response.ok) {
    const envelope = ApiErrorSchema.safeParse(json);
    const code = envelope.success ? envelope.data.error.code : defaultCodeForStatus(response.status);
    const message = envelope.success
      ? envelope.data.error.message
      : `The Studio API responded with HTTP ${response.status}.`;
    throw new StudioApiError({
      kind: kindForStatus(response.status),
      status: response.status,
      code,
      message,
      details: envelope.success ? envelope.data.error.details : undefined,
      apiUrl: baseUrl,
    });
  }

  if (json === undefined) {
    throw new StudioApiError({
      kind: 'invalid_response',
      status: response.status,
      code: 'INVALID_JSON',
      message: `${method} ${path} returned a body that is not valid JSON.`,
      apiUrl: baseUrl,
    });
  }
  return { status: response.status, json };
}

async function requestJson<S extends z.ZodType>(
  method: HttpMethod,
  path: string,
  schema: S,
  opts: SendOptions = {},
): Promise<z.output<S>> {
  const { status, json } = await send(method, path, opts);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const summary = summarizeIssues(parsed.error);
    console.error(`[studio-api] ${method} ${path} response failed validation: ${summary}`);
    throw new StudioApiError({
      kind: 'invalid_response',
      status,
      code: 'INVALID_RESPONSE',
      message: `${method} ${path} returned data that does not match the expected schema (${summary}).`,
      apiUrl: getStudioApiConnectionInfo().baseUrl,
    });
  }
  return parsed.data;
}

/** Validates an id before interpolating it into a path (defense in depth on top of encodeURIComponent). */
function idSegment(id: string, label: string): string {
  if (!DbIdSchema.safeParse(id).success || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new StudioApiError({
      kind: 'not_found',
      status: 404,
      code: 'NOT_FOUND',
      message: `Invalid ${label} id.`,
    });
  }
  return encodeURIComponent(id);
}

// ---------------------------------------------------------------------------------------------
// Endpoints (spec section 3)
// ---------------------------------------------------------------------------------------------

const HealthSchema = z.object({ ok: z.literal(true), version: z.string() });
export type Health = z.infer<typeof HealthSchema>;

/** `GET /health` (public). */
export async function getHealth(): Promise<Health> {
  return requestJson('GET', '/health', HealthSchema, { auth: false });
}

/** `GET /v1/me`. */
export async function getMe(): Promise<MeDTO> {
  return requestJson('GET', '/v1/me', MeDTOSchema);
}

/** `GET /v1/system/config`. */
export async function getSystemConfig(): Promise<SystemConfigDTO> {
  return requestJson('GET', '/v1/system/config', SystemConfigDTOSchema);
}

/** `GET /v1/usage`. */
export async function getUsageSummary(): Promise<UsageSummaryDTO> {
  return requestJson('GET', '/v1/usage', UsageSummaryDTOSchema);
}

/** `GET /v1/projects?limit=&cursor=` (owner-scoped, updatedAt desc). */
export async function listProjects(opts: { limit?: number; cursor?: string | null } = {}): Promise<ProjectSummaryPage> {
  const params = new URLSearchParams();
  params.set('limit', String(Math.max(1, Math.min(100, Math.trunc(opts.limit ?? 20)))));
  if (opts.cursor) params.set('cursor', opts.cursor);
  return requestJson('GET', `/v1/projects?${params.toString()}`, ProjectSummaryPageSchema);
}

/** `POST /v1/projects` → 201 ProjectDetailDTO. The body is re-validated before sending. */
export async function createProject(request: CreateProjectRequest): Promise<ProjectDetailDTO> {
  const body = CreateProjectRequestSchema.parse(request);
  return requestJson('POST', '/v1/projects', ProjectDetailDTOSchema, { body });
}

/** `GET /v1/projects/:id`. */
export async function getProject(projectId: string): Promise<ProjectDetailDTO> {
  return requestJson('GET', `/v1/projects/${idSegment(projectId, 'project')}`, ProjectDetailDTOSchema);
}

/** `DELETE /v1/projects/:id` → 204 (409 while a run is active). */
export async function deleteProject(projectId: string): Promise<void> {
  await send('DELETE', `/v1/projects/${idSegment(projectId, 'project')}`);
}

/** `POST /v1/projects/:id/director-runs` → 202 DirectorRunDTO (409 RUN_ACTIVE, 429 QUOTA_EXCEEDED). */
export async function startDirectorRun(projectId: string): Promise<DirectorRunDTO> {
  return requestJson(
    'POST',
    `/v1/projects/${idSegment(projectId, 'project')}/director-runs`,
    DirectorRunDTOSchema,
    { body: {} },
  );
}

/** `GET /v1/projects/:id/director-runs` → DirectorRunDTO[] (latest 20). */
export async function listDirectorRuns(projectId: string): Promise<DirectorRunDTO[]> {
  return requestJson(
    'GET',
    `/v1/projects/${idSegment(projectId, 'project')}/director-runs`,
    z.array(DirectorRunDTOSchema),
  );
}

/** `GET /v1/director-runs/:runId`. */
export async function getDirectorRun(runId: string): Promise<DirectorRunDTO> {
  return requestJson('GET', `/v1/director-runs/${idSegment(runId, 'run')}`, DirectorRunDTOSchema);
}

/** `POST /v1/director-runs/:runId/cancel` → DirectorRunDTO (409 when not queued/running). */
export async function cancelDirectorRun(runId: string): Promise<DirectorRunDTO> {
  return requestJson('POST', `/v1/director-runs/${idSegment(runId, 'run')}/cancel`, DirectorRunDTOSchema, { body: {} });
}

/** `GET /v1/projects/:id/versions`. */
export async function listProjectVersions(projectId: string): Promise<ProjectVersionSummaryDTO[]> {
  return requestJson(
    'GET',
    `/v1/projects/${idSegment(projectId, 'project')}/versions`,
    z.array(ProjectVersionSummaryDTOSchema),
  );
}

/** `GET /v1/projects/:id/versions/:version`. */
export async function getProjectVersion(projectId: string, version: number): Promise<ProjectVersionDTO> {
  if (!Number.isInteger(version) || version < 1) {
    throw new StudioApiError({ kind: 'not_found', status: 404, code: 'NOT_FOUND', message: 'Invalid version.' });
  }
  return requestJson(
    'GET',
    `/v1/projects/${idSegment(projectId, 'project')}/versions/${version}`,
    ProjectVersionDTOSchema,
  );
}

// ---------------------------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------------------------

export type ApiResult<T> = { ok: true; data: T } | { ok: false; failure: ApiFailure };

/** Runs an API call and converts `StudioApiError` into a serializable failure (other errors propagate). */
export async function attempt<T>(call: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    return { ok: true, data: await call() };
  } catch (error) {
    if (error instanceof StudioApiError) return { ok: false, failure: error.toFailure() };
    throw error;
  }
}
