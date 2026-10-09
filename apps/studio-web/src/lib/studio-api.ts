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
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PUBLIC_FAILURE_MESSAGES, type ApiFailure, type ApiFailureKind } from './api-failure';
import { TtlCache } from './ttl-cache';

/**
 * Server-only client for `@vc/studio-api`. Reads `STUDIO_API_URL` + `STUDIO_API_TOKEN` (never `NEXT_PUBLIC_`),
 * validates EVERY response body with the `@vc/schema` DTO schemas and throws `StudioApiError` on any failure.
 * The token is only ever placed in the outgoing `Authorization` header — it is never logged or returned.
 *
 * Errors carry two messages: `message` (internal detail — base URL, network error, schema issues; logged
 * server-side only) and `publicMessage` (safe to render for any user; what `toFailure()` exposes).
 */

const DEFAULT_API_URL = 'http://localhost:4100';
const REQUEST_TIMEOUT_MS = 15_000;

export class StudioApiError extends Error {
  readonly kind: ApiFailureKind;
  readonly status: number | null;
  readonly code: string;
  readonly details: unknown;
  /** User-facing message (never contains internal details). */
  readonly publicMessage: string;

  constructor(init: {
    kind: ApiFailureKind;
    /** Internal detail, for server logs. */
    message: string;
    code: string;
    status?: number | null;
    details?: unknown;
    /** Defaults to a generic message for the kind (or `message` for API-provided `http` / `not_found` errors). */
    publicMessage?: string;
  }) {
    super(init.message);
    this.name = 'StudioApiError';
    this.kind = init.kind;
    this.code = init.code;
    this.status = init.status ?? null;
    this.details = init.details;
    this.publicMessage =
      init.publicMessage ??
      (init.kind === 'http' || init.kind === 'not_found' ? init.message : PUBLIC_FAILURE_MESSAGES[init.kind]);
  }

  /** Serializable, token- and detail-free view for rendering (Server → Client Components). */
  toFailure(): ApiFailure {
    return { kind: this.kind, status: this.status, code: this.code, message: this.publicMessage };
  }
}

/** Logs the internal detail of a failed call (never the token: it is not part of any message). */
function logFailure(method: string, path: string, error: StudioApiError): void {
  console.error(`[studio-api] ${method} ${path} failed (${error.kind}/${error.code}): ${error.message}`);
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
  try {
    return await sendOnce(method, path, opts);
  } catch (error) {
    if (error instanceof StudioApiError && shouldLog(error)) logFailure(method, path, error);
    throw error;
  }
}

/** Expected outcomes (404, 409 run active, 422 limits, 429 quota…) are part of normal flow and not logged. */
function shouldLog(error: StudioApiError): boolean {
  return error.kind !== 'http' && error.kind !== 'not_found' ? true : (error.status ?? 500) >= 500;
}

async function sendOnce(method: HttpMethod, path: string, opts: SendOptions): Promise<{ status: number; json: unknown }> {
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
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new StudioApiError({
      kind: 'unreachable',
      code: 'API_UNREACHABLE',
      message: `${baseUrl}: ${describeNetworkError(error)}`,
      publicMessage: timedOut ? 'The Studio API did not respond in time.' : PUBLIC_FAILURE_MESSAGES.unreachable,
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
    const kind = kindForStatus(response.status);
    throw new StudioApiError({
      kind,
      status: response.status,
      code,
      message,
      // 5xx bodies may carry internals (stack traces from a proxy, …): keep them out of the UI.
      publicMessage:
        kind === 'unauthorized'
          ? PUBLIC_FAILURE_MESSAGES.unauthorized
          : response.status >= 500
            ? `The Studio API could not process the request (HTTP ${response.status}).`
            : message,
      details: envelope.success ? envelope.data.error.details : undefined,
    });
  }

  if (json === undefined) {
    throw new StudioApiError({
      kind: 'invalid_response',
      status: response.status,
      code: 'INVALID_JSON',
      message: `${method} ${path} returned a body that is not valid JSON.`,
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

/**
 * Page envelope with the optional `total` (number of projects over ALL pages). Declared here as well so the count is
 * kept whether or not the installed `@vc/schema` already lists `total` (older schemas would strip the unknown key).
 */
const ProjectSummaryPageWithTotalSchema = ProjectSummaryPageSchema.extend({
  total: z.number().int().min(0).optional(),
});
export type ProjectSummaryPageWithTotal = ProjectSummaryPage & { total?: number | undefined };

/** `GET /v1/projects?limit=&cursor=` (owner-scoped, updatedAt desc). */
export async function listProjects(
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<ProjectSummaryPageWithTotal> {
  const params = new URLSearchParams();
  params.set('limit', String(Math.max(1, Math.min(100, Math.trunc(opts.limit ?? 20)))));
  if (opts.cursor) params.set('cursor', opts.cursor);
  return requestJson('GET', `/v1/projects?${params.toString()}`, ProjectSummaryPageWithTotalSchema);
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
  forgetProjectVersions(projectId);
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

/**
 * Parsed project versions, shared across requests. A version is immutable once created (the API only ever adds
 * `max + 1`), and a multi-hour version is several MB of JSON (~0.3 s to fetch + validate), so tab switches, the
 * storyboard chapter loader and the timeline route reuse it instead of refetching. Keyed by the token fingerprint
 * too (entries are only ever served to the identity that fetched them). Bounded (entries × TTL) to cap memory;
 * in-flight requests are shared; failures are never cached; deleting a project evicts its versions.
 */
const versionCache = new TtlCache<string, Promise<ProjectVersionDTO>>({ maxEntries: 3, ttlMs: 5 * 60_000 });

function tokenFingerprint(): string {
  return createHash('sha256')
    .update((process.env.STUDIO_API_TOKEN ?? '').trim())
    .digest('hex')
    .slice(0, 16);
}

function versionCacheKey(projectId: string, version: number): string {
  return `${tokenFingerprint()}:${projectId}:${version}`;
}

/** Drops cached versions of a project (after deleting it). */
export function forgetProjectVersions(projectId: string): void {
  const marker = `:${projectId}:`;
  versionCache.deleteWhere((key) => key.includes(marker));
}

/** `GET /v1/projects/:id/versions/:version` (cached — see `versionCache`). */
export async function getProjectVersion(projectId: string, version: number): Promise<ProjectVersionDTO> {
  if (!Number.isInteger(version) || version < 1) {
    throw new StudioApiError({ kind: 'not_found', status: 404, code: 'NOT_FOUND', message: 'Invalid version.' });
  }
  const path = `/v1/projects/${idSegment(projectId, 'project')}/versions/${version}`;
  const key = versionCacheKey(projectId, version);
  const cached = versionCache.get(key);
  if (cached) return cached;
  const pending = requestJson('GET', path, ProjectVersionDTOSchema);
  versionCache.set(key, pending);
  pending.catch(() => {
    if (versionCache.peek(key) === pending) versionCache.delete(key);
  });
  return pending;
}

/** Version summary (no artifacts / timeline) from `listProjectVersions`, for pages that do not need the payload. */
export function findVersionSummary(
  versions: readonly ProjectVersionSummaryDTO[],
  version: number | null,
): ProjectVersionSummaryDTO | null {
  return version === null ? null : (versions.find((v) => v.version === version) ?? null);
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
