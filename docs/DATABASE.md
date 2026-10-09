# Database

| | |
|---|---|
| Document status | Living document. Revised at each milestone close. |
| Last updated | 2026-10-09 |
| Current milestone | **M1 Foundation (in progress)**. See [ROADMAP.md](ROADMAP.md). |
| Source of truth | **`apps/studio-api/prisma/schema.prisma`** and the committed SQL in `apps/studio-api/prisma/migrations/` |
| Related | [ARCHITECTURE.md](ARCHITECTURE.md) · [TIMELINE_SCHEMA.md](TIMELINE_SCHEMA.md) · [AI_DIRECTOR.md](AI_DIRECTOR.md) · [DEVELOPMENT.md](DEVELOPMENT.md) · [M1 spec, section 3](milestones/M1_IMPLEMENTATION_SPEC.md#3-vcstudio-api-appsstudio-api--contract) |

> **The Prisma schema file `apps/studio-api/prisma/schema.prisma` is the source of truth.** This document explains it. If the
> two disagree, the schema file is right and this document must be updated. The generated SQL is in three migrations under
> `apps/studio-api/prisma/migrations/`: `20261009082453_init`, `20261009085125_run_accounting` and
> `20261009140000_run_reservations_heartbeat_version_summary` (section 1).

**Status labels.** Everything in sections 1 to 7 and 9 is **M1** unless marked **Planned (Mx)**. Section 8 is entirely
planned: none of those tables exist.

This document covers the studio database only. The campaigns MVP uses its own database (`video_creation`) with raw SQL
migrations in `db/migrations/`. The two share no tables before M7 (PRD open question Q13).

---

## 1. Overview

| Item | Value |
|---|---|
| Engine | PostgreSQL 16 (`docker-compose.yml`) |
| Databases | `video_studio` (development), `video_studio_test` (API tests). Both are created by `docker/postgres/init-databases.sql` on the first start of an empty Postgres volume. |
| ORM | Prisma 7.10 with the `prisma-client` generator. The client is generated into `apps/studio-api/src/generated/prisma` (gitignored) and used with the driver adapter `@prisma/adapter-pg`: `createPrisma(url, pool)` in `src/db.ts` builds `new PrismaClient({ adapter: new PrismaPg({ connectionString, max, connectionTimeoutMillis }) })`. |
| Connection URL | `DATABASE_URL`. The app reads it in `src/config.ts`. The Prisma CLI reads it through `apps/studio-api/prisma.config.ts`, which loads `apps/studio-api/.env` with `process.loadEnvFile` when the file exists (variables already set in the shell win) and otherwise falls back to `postgres://postgres:postgres@localhost:5432/video_studio`. Tests use `TEST_DATABASE_URL` (default `.../video_studio_test`). |
| Connection pool | One `pg` pool per process (API, worker), `DATABASE_POOL_MAX` connections (default 10). A query that waits longer than `DATABASE_CONNECTION_TIMEOUT_MS` (default 5 000) for a free connection fails instead of hanging. The seed script uses 2 connections. |
| Naming | PascalCase models and camelCase fields in Prisma; snake_case in Postgres through `@@map` and `@map`. Tables: `users`, `api_tokens`, `projects`, `project_versions`, `director_runs`, `director_cache_entries`. Enum types: `project_status`, `run_status`. Example: `DirectorRun.requestedById` is the column `director_runs.requested_by_id`. |
| Migrations | `20261009082453_init` creates both enums, all six tables, their indexes and foreign keys. `20261009085125_run_accounting` makes `director_runs.project_id` nullable with `ON DELETE SET NULL` (it was `NOT NULL` with `ON DELETE CASCADE`), adds `director_runs.warnings` (`jsonb NOT NULL DEFAULT '[]'`) and adds `director_cache_entries.chunk` (`text`, nullable). `20261009140000_run_reservations_heartbeat_version_summary` adds `director_runs.heartbeat_at` (nullable; set to now for runs already `RUNNING`) and `director_runs.reserved_cost_usd` (`DECIMAL(12,6) NOT NULL DEFAULT 0`), adds `project_versions.scene_count`, `duration_in_frames` and `fps` (backfilled from the stored timeline JSON), and creates the indexes `director_runs (requested_by_id, status)` and `director_runs (status, heartbeat_at)`. |
| Primary keys | `String @id @default(cuid())` on every model except `DirectorCacheEntry`, whose key is a user-scoped SHA-256 cache key (section 3.6) |
| JSON | Prisma `Json` fields are `jsonb` in Postgres. Their contents are validated with Zod schemas from `@vc/schema` before they are written (section 4). The exception is `DirectorRun.warnings`, a capped array of plain strings. Postgres `jsonb` rejects lone UTF-16 surrogates, so `VideoRequestSchema`, `DirectorArtifactsSchema`, `TimelineSchema` and `JsonValueSchema` reject ill-formed strings before a write. |
| Money | `DirectorRun.estimatedCostUsd` and `DirectorRun.reservedCostUsd` are `Decimal(12,6)` so sums are exact. DTOs expose costs as numbers; the reservation is not exposed. |
| Only writer | `@vc/studio-api` (API process and director worker). studio-web never touches the database. |

## 2. Entity-relationship diagram

```mermaid
erDiagram
  User ||--o{ ApiToken : "authenticates with"
  User ||--o{ Project : "owns"
  User ||--o{ DirectorRun : "requested"
  Project ||--o{ ProjectVersion : "has versions"
  Project |o--o| ProjectVersion : "currentVersionId"
  Project |o--o{ DirectorRun : "has runs (projectId nullable)"
  DirectorRun |o--o| ProjectVersion : "produced (directorRunId)"

  User {
    String id PK "cuid"
    String email UK
    String name "nullable"
    DateTime createdAt
    DateTime updatedAt
  }
  ApiToken {
    String id PK
    String userId FK "indexed, on delete cascade"
    String label
    String tokenHash UK "sha256 hex of the raw token"
    DateTime createdAt
    DateTime lastUsedAt "nullable"
    DateTime revokedAt "nullable"
  }
  Project {
    String id PK
    String ownerId FK "on delete cascade"
    String title
    String genre "VideoGenre value"
    Float durationSeconds
    String aspectRatio
    ProjectStatus status "default DRAFT"
    Json request "VideoRequest"
    String currentVersionId FK, UK "nullable, on delete set null"
    DateTime createdAt
    DateTime updatedAt
  }
  ProjectVersion {
    String id PK
    String projectId FK "on delete cascade"
    Int version "unique per project"
    Int schemaVersion "timeline schemaVersion"
    Json timeline "Timeline v1"
    Json artifacts "DirectorArtifacts"
    Int sceneCount "summary column, default 0"
    Int durationInFrames "summary column, default 1"
    Int fps "summary column, default 30"
    String directorRunId FK, UK "nullable, on delete set null"
    DateTime createdAt
  }
  DirectorRun {
    String id PK
    String projectId FK "nullable, on delete set null"
    String requestedById FK "on delete cascade"
    RunStatus status "default QUEUED"
    String provider
    String model
    String promptVersion
    Json progress
    Json usage "UsageReport, nullable"
    Json warnings "string array, default empty array"
    Int inputTokens "default 0"
    Int outputTokens "default 0"
    Int cacheReadTokens "default 0"
    Int cacheWriteTokens "default 0"
    Decimal estimatedCostUsd "Decimal(12,6), default 0"
    Decimal reservedCostUsd "Decimal(12,6), default 0, cost ceiling"
    String errorCode "nullable"
    String errorMessage "nullable"
    DateTime createdAt
    DateTime startedAt "nullable"
    DateTime finishedAt "nullable"
    DateTime heartbeatAt "nullable, liveness while RUNNING"
  }
  DirectorCacheEntry {
    String key PK "sha256 of owner scope + director cache key"
    String stage
    String chunk "nullable"
    String model
    String provider
    Json output "validated stage output"
    Json usage "TokenUsage of the original call"
    Int hits "default 0"
    DateTime createdAt
    DateTime lastHitAt "nullable"
  }
```

`DirectorCacheEntry` has no foreign keys. Its entries are scoped to one user through the key (the requesting user's id is
hashed into it), but no owner column is stored, so deleting a user or a project does not delete cache entries.

`DirectorRun.projectId` is nullable so that runs outlive their project: deleting a project sets it to null and keeps the run
rows for usage accounting and daily quotas (sections 3.5 and 9).

## 3. Tables

### 3.1 `User` (table `users`)

A person who can call the API. In M1 the only way to create one is the seed script (`pnpm studio:db:seed`), which upserts the
user named by `STUDIO_DEV_USER_EMAIL`. There is no sign-up or user-management endpoint; OIDC login is **planned (M8)**.

| Field | Type | Notes |
|---|---|---|
| `id` | String, PK | cuid |
| `email` | String, unique | |
| `name` | String, nullable | Returned by `GET /v1/me` |
| `createdAt`, `updatedAt` | DateTime | `updatedAt` maintained by Prisma |

Indexes: unique on `email`.

### 3.2 `ApiToken` (table `api_tokens`)

Bearer tokens for `/v1/*`. The raw token is never stored, only its SHA-256 hex digest.

| Field | Type | Notes |
|---|---|---|
| `id` | String, PK | |
| `userId` | String, FK to `User.id` | `onDelete: Cascade` |
| `label` | String | Human-readable name for the token |
| `tokenHash` | String, unique | `sha256(rawToken)` as hex (`hashToken` in `src/lib/tokens.ts`). Lookups go through this unique index. |
| `createdAt` | DateTime | |
| `lastUsedAt` | DateTime, nullable | Refreshed by the auth hook at most once per minute per token, to keep authentication cheap |
| `revokedAt` | DateTime, nullable | When set, the auth hook rejects the token with 401 |

Indexes: unique on `tokenHash`; `@@index([userId])`.

In M1 tokens are created only by the seed script from `STUDIO_DEV_API_TOKEN` (at least 32 characters; `openssl rand -hex 32`
works, and `.env.example` shows how to generate a `vcs_`-prefixed random token). The seed upserts by `tokenHash` and never
modifies an existing row: the same token value keeps one row, and a new value adds a row while older tokens stay valid.
Revoking a token means setting `revokedAt` directly in the database. Re-seeding a revoked token value does **not** re-activate
it, and a token row that belongs to another user is not reassigned; the seed prints a warning in both cases and a new token
value is needed. The auth hook accepts bearer values of 16 to 512 characters. Token-management endpoints are
**planned (M8)**.

### 3.3 `Project` (table `projects`)

One video project: the user's request plus its lifecycle status and a pointer to the current version.

| Field | Type | Notes |
|---|---|---|
| `id` | String, PK | Tie-breaker of the `GET /v1/projects` keyset order (`updatedAt` desc, `id` desc) |
| `ownerId` | String, FK to `User.id` | `onDelete: Cascade`. Every project query filters on it. |
| `title` | String | Copied from `request.title` for listing |
| `genre` | String | Copied from `request.genre` (a `VideoGenre` value) |
| `durationSeconds` | Float | Copied from `request.durationSeconds`. No database maximum; limits are enforced by the API. |
| `aspectRatio` | String | Copied from `request.aspectRatio` (`9:16`, `16:9`, `1:1`, `4:5`, `custom`) |
| `status` | `ProjectStatus` enum, default `DRAFT` | `DRAFT`, `DIRECTING`, `READY`, `FAILED` (section 5) |
| `request` | Json | The full `VideoRequest` (section 4) |
| `currentVersionId` | String, nullable, unique, FK to `ProjectVersion.id` | The version shown by default. Set by each successful run. `onDelete: SetNull`. |
| `createdAt`, `updatedAt` | DateTime | `updatedAt` is bumped by every update, including status changes, so a project moves to the top of the dashboard when a run starts or ends. |

Indexes: `@@index([ownerId, updatedAt])` for the owner-scoped, `updatedAt`-descending project list; unique on
`currentVersionId`.

The copied columns exist so the list endpoint and dashboard never have to read the `request` JSON. M1 has no endpoint that
changes `request` after creation, so the copies cannot drift.

### 3.4 `ProjectVersion` (table `project_versions`)

An immutable snapshot of a timeline and the director artifacts that produced it. Each successful director run adds one.

| Field | Type | Notes |
|---|---|---|
| `id` | String, PK | |
| `projectId` | String, FK to `Project.id` | `onDelete: Cascade` |
| `version` | Int | 1, 2, 3, ... per project. The new version is the previous maximum plus one, computed inside the success transaction. |
| `schemaVersion` | Int | The timeline's `schemaVersion` when written (always 1 in M1). Lets old documents be found without parsing JSON. |
| `timeline` | Json | `Timeline` v1 (section 4) |
| `artifacts` | Json | `DirectorArtifacts` (section 4) |
| `sceneCount`, `durationInFrames`, `fps` | Int, defaults 0, 1, 30 | Summary columns copied from the timeline in the success transaction (`scenes.length`, `durationInFrames`, `settings.fps`). The version list reads only these. The migration backfilled them from existing timeline JSON. |
| `directorRunId` | String, nullable, unique, FK to `DirectorRun.id` | The run that produced this version, set in the run's success transaction. The API reports it back as `DirectorRunDTO.versionNumber`. `onDelete: SetNull`, so the version survives if the run row is removed. Unique, so a run produces at most one version. Nullable so versions created without a run (planned M2 editor edits) fit the same table. |
| `createdAt` | DateTime | |

Indexes: `@@unique([projectId, version])`, which also serves "versions of a project" lookups and guards against two writers
assigning the same number; unique on `directorRunId`.

Rows are never updated after insert. They are deleted with their project (cascade), which also removes the link from the
producing run. `GET /v1/projects/:id/versions` selects only the id, version, `schemaVersion`, `createdAt` and the three summary
columns of the **latest 100** versions (`VERSION_LIST_LIMIT`; the list is a plain array, not paginated), so it never reads
timeline JSON. `GET /v1/projects/:id/versions/:version` loads one row, validates and migrates it (`toVersionDto`) and keeps the
serialized DTO in an in-process LRU (`VERSION_CACHE_MAX_BYTES`, default 64 MiB): versions are immutable, so each one is
validated once per process. The response carries a strong `ETag` (`"pv-<versionId>-t<timeline version>-<API version>"`) and
`Cache-Control: private, max-age=31536000, immutable`, and a matching `If-None-Match` gets 304 after an owner-scoped id lookup,
without loading the timeline.

### 3.5 `DirectorRun` (table `director_runs`)

One execution of the AI Director for a project. It is the source of truth for run state; the queue job only carries its id.

| Field | Type | Notes |
|---|---|---|
| `id` | String, PK | The BullMQ job payload is `{runId: id}`, and the job id is the run id |
| `projectId` | String, nullable, FK to `Project.id` | `onDelete: SetNull`. Null once the project was deleted: the run row is kept so usage and daily quotas stay accurate. Such runs are no longer addressable through the API (`GET /v1/director-runs/:runId` returns 404), and the worker skips them. |
| `requestedById` | String, FK to `User.id` | Who started the run. `onDelete: Cascade`. M1 has no user-deletion endpoint. |
| `status` | `RunStatus` enum, default `QUEUED` | `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED` (section 5) |
| `provider` | String | Provider name configured in the API process when the run was created (for example `mock`) |
| `model` | String | Configured model (for example `mock-director-v1`, `claude-opus-5-5`). The model actually served for each call is in `usage.stages[].model`. |
| `promptVersion` | String | `PROMPT_VERSION` of `@vc/ai-director` (`m1.1`) |
| `progress` | Json | `{completedSteps, totalSteps, currentStage, message}` (section 4) |
| `usage` | Json, nullable | `UsageReport` (section 4). Written when the run ends: on success, and also on failure, timeout, spend-limit stop, shutdown or cancellation with the usage consumed so far. Null for runs that made no provider calls and for runs reaped after a worker crash (`WORKER_LOST`, or `INTERNAL` from the failed-job handler; section 5.2). |
| `warnings` | Json, default `[]` | Director warnings as a string array, for example engine-coercion notices. At most 500 entries of at most 2000 characters each. Written together with `usage`. Not exposed by the M1 API; read it from the database. |
| `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` | Int, default 0 | Run totals, so usage and quota queries can sum columns. Updated with every progress write while the run is `RUNNING` (live meter of every provider request, refused and truncated attempts included), then overwritten from `usage.totals` when the run ends with a report. |
| `estimatedCostUsd` | Decimal(12,6), default 0 | Estimated USD for the run, from the pricing table, each request priced at the model that served it (unknown models count as 0). Updated together with the token columns. |
| `reservedCostUsd` | Decimal(12,6), default 0 | The run's cost ceiling, computed from its plan when it is created (`estimateRunCostCeilingUsd`; 0 for the mock and for unpriced models). While the run is `QUEUED` or `RUNNING`, its unspent part (`reservedCostUsd − estimatedCostUsd`, at least 0) counts against the user's daily USD quota ([DEVELOPMENT.md section 4.4](DEVELOPMENT.md#44-quotas)). Never changed afterwards. |
| `errorCode` | String, nullable | Set only on `FAILED` runs (a cancelled run has none). Either a `DirectorError` code (`VALIDATION_FAILED`, `PROVIDER_REFUSAL`, `PROVIDER_UNAVAILABLE`, `PROVIDER_CONFIG`, `PROVIDER_REQUEST`, `PROVIDER_TRUNCATED`, `CANCELLED`, `LIMIT_EXCEEDED`, `INTERNAL`), or one set by studio-api (section 5.2): `TIMEOUT` (the run exceeded its effective timeout), `QUOTA_EXCEEDED` (stopped because today's spend reached `LIMIT_DIRECTOR_USD_PER_DAY`), `SHUTDOWN` (the worker or inline API shut down while the run was in flight, or before it started), `WORKER_LOST` (heartbeat went stale), `QUEUE_LOST` (an old `QUEUED` run whose queue job is gone), `QUEUE_UNAVAILABLE` (the job could not be enqueued), `INTERNAL` (unexpected error, or BullMQ gave up on the job while nobody was processing it) |
| `errorMessage` | String, nullable | Sanitized message, safe to show to the user: credentials that look like Anthropic keys or bearer tokens are redacted, control characters removed, length capped at 1000. Unexpected errors get a generic message; details go to the server log. |
| `createdAt` | DateTime | When the run was queued. Usage and quotas attribute the run to this UTC day. |
| `startedAt`, `finishedAt` | DateTime, nullable | `startedAt` is set when the worker claims the run. `finishedAt` is set on reaching a terminal state, including by the cancel endpoint and the reaper. |
| `heartbeatAt` | DateTime, nullable | Set when the worker claims the run, then refreshed about every 2 s (and with every progress write) while it is `RUNNING`. The reaper fails a `RUNNING` run whose heartbeat is older than `DIRECTOR_HEARTBEAT_STALE_MS` with `WORKER_LOST`. |

The optional `version` back-relation is the `ProjectVersion` whose `directorRunId` points at this run.

Indexes:

- `@@index([projectId, createdAt])`: runs of a project, newest first (latest 20), and the active-run check.
- `@@index([requestedById, createdAt])`: per-user usage for today and this month, and the daily quota checks.
- `@@index([requestedById, status])`: the user's active runs (`LIMIT_ACTIVE_RUNS_PER_USER` and their cost reservations).
- `@@index([status, heartbeatAt])`: the reaper's stale-run scans.

**Usage is recorded for every run that did work.** While a run is `RUNNING`, every progress write also stores the token and cost
columns of the provider requests made so far. When it ends, the success transaction, `markRunFailed` (failure, timeout,
spend-limit stop, shutdown) and the worker's cancellation finaliser write the full `usage` report and `warnings` (the
finaliser only if `usage` is still null). Runs cancelled while `QUEUED`, and runs failed with `QUEUE_UNAVAILABLE` or
`QUEUE_LOST`, keep zeros and `usage = null` because they made no provider calls. A run reaped after its worker died
(`WORKER_LOST`) keeps the columns of its last progress write, so only the spend of the stage that was in progress (its attempts
since the last progress write) is missing from `/v1/usage` and the USD quota. Every run counts toward the daily run quota, except runs that failed before they
started because the queue was unavailable or lost them (`status = FAILED`, `startedAt` null, `errorCode` `QUEUE_UNAVAILABLE` or
`QUEUE_LOST`). Because run rows survive project deletion, `/v1/usage` and the quotas include runs of deleted projects.

### 3.6 `DirectorCacheEntry` (table `director_cache_entries`)

Stage-level cache used by `PrismaDirectorCache` (`src/director/prisma-cache.ts`) when `DIRECTOR_CACHE=on` (the default). A hit
skips the provider call entirely.

| Field | Type | Notes |
|---|---|---|
| `key` | String, PK | User-scoped: `sha256(scope + "\n" + directorKey)` as hex, where `scope` is the id of the user who requested the run (`DirectorRun.requestedById`) and `directorKey` is `computeCacheKey(...)` of `@vc/ai-director`: SHA-256 hex of canonical (sorted-key) JSON of `{stage, chunk, promptVersion, provider, model, schemaName, system, prompt, inputHash, providerFingerprint}`, where `inputHash` is the SHA-256 of the structured stage input and `providerFingerprint` covers the provider settings that change outputs (for Anthropic: model, effort, max output tokens, fallbacks, structured-output mode). One user's runs can therefore never hit, and so reveal, another user's entries. |
| `stage` | String | The `DirectorStage` that produced the output (`brief`, `outline`, `script`, `storyboard`, `shotList`, `engineSelection`, `sceneSpecs`). A row whose `stage` is not a valid stage is treated as a miss. |
| `chunk` | String, nullable | The chunk the output belongs to, for example a chapter id such as `c1`. Null for whole-project stages (`brief`, `outline`). |
| `model`, `provider` | String | For inspection and targeted cleanup |
| `output` | Json | The validated output of the stage. Only outputs that passed Zod and the semantic validator are cached. |
| `usage` | Json | `TokenUsage` of the call that produced the output. A row whose `usage` fails `TokenUsageSchema` is treated as a miss. |
| `hits` | Int, default 0 | Incremented on each hit |
| `createdAt` | DateTime | |
| `lastHitAt` | DateTime, nullable | Last hit time. Null if never hit. |

No indexes beyond the primary key. Writes are upserts by `key`. A hit is recorded in the run's usage as a `StageUsage` with
`cached: true`, zero tokens and zero cost; the stored `usage` keeps what the original call cost. The table has no owner column:
the user id only exists inside the hash, so entries cannot be selected by user.

The prompt version, the input hash and the provider fingerprint are part of the hashed key, so bumping `PROMPT_VERSION` or
changing the key's composition makes old entries unreachable without deleting them. The M1 review did both
(`PROMPT_VERSION` `m1.0` → `m1.1`, plus the two new key parts), so every row written before it is now an orphan that no run can
hit; clean them up by age (section 9). Changing an LLM-facing schema without bumping `PROMPT_VERSION` can still serve an output
generated under the old schema, because the key covers the schema name but not the schema body; hits are re-validated against the
current schema, so only outputs that still validate are reused ([ROADMAP known gaps](ROADMAP.md#known-gaps-carried-out-of-m1)).
`regenerateScene` neither reads nor writes the cache.

## 4. JSON columns

Every JSON document except `DirectorRun.warnings` is validated with a `@vc/schema` Zod schema before it is written. Readers should parse it again with the
same schema (for timelines, with `parseTimeline`) rather than trusting the database. studio-api does: a stored project row
(`genre`, `aspectRatio`, `request`) or version row (`timeline`, `artifacts`) that fails validation on read is answered as 500
`DATA_INTEGRITY` with a generic message, and the entity, id and issues are logged (`DataIntegrityError` in `src/lib/errors.ts`).
A run's `progress` or `usage` that fails validation is served as empty progress or `usage: null` instead.

| Column | Contents | Schema in `@vc/schema` | Written | Versioning |
|---|---|---|---|---|
| `Project.request` | The user's request: title, prompt, genre, style notes, duration, aspect ratio, resolution, custom dimensions, fps, language, brand, voice-over and music intent, reference asset ids | `VideoRequestSchema` (also checked with `checkVideoRequestLimits`) | `POST /v1/projects` | No version field in M1 |
| `ProjectVersion.timeline` | The compiled timeline: render settings, `durationInFrames`, brand kit, assets, chapters, scenes, tracks, generator metadata | `TimelineSchema` v1 with all invariants. See [TIMELINE_SCHEMA.md](TIMELINE_SCHEMA.md). | Success transaction | `schemaVersion` inside the document, mirrored in the `schemaVersion` column, plus `TIMELINE_MIGRATIONS` |
| `ProjectVersion.artifacts` | `{brief, outline, script, storyboard, shotList, engineSelection, sceneSpecs}` | `DirectorArtifactsSchema` | Success transaction | No version field in M1 |
| `DirectorRun.progress` | `{completedSteps, totalSteps, currentStage: DirectorStage \| null, message: string \| null}` | `DirectorRunProgressSchema` (the `progress` shape of `DirectorRunDTO`) | Created as `{0, N, null, "Queued"}`, where `N` is the planned step count of the project's request (0 if it no longer plans, for example after limits were lowered). Reset to `"Starting AI Director"` when the worker claims the run. Then written immediately whenever the stage or chunk changes, and otherwise at most every 500 ms with a trailing write, always together with `heartbeatAt` and the live token and cost columns. On success it ends at `completedSteps = totalSteps`, stage `compile`, message `"Timeline ready"`. Not changed by cancellation, failure or the reaper. | — |
| `DirectorRun.usage` | `{stages: StageUsage[], totals}` | `UsageReportSchema` | When the run ends: success, failure, timeout, spend-limit stop, shutdown, or cancellation while running (partial usage). Not written for reaped runs. | — |
| `DirectorRun.warnings` | `string[]`, for example engine-coercion notices | None (plain strings, capped at 500 entries of 2000 characters) | Together with `usage` | — |
| `DirectorCacheEntry.output` | One stage output, for example a `CreativeBrief` or one chapter's script, storyboard, shot list, engine selection or scene specs | The stage's LLM-facing schema | After validation | Covered by `PROMPT_VERSION` in the key |
| `DirectorCacheEntry.usage` | `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}` | `TokenUsageSchema` | With the entry | — |

Example `DirectorRun.progress` for a one-chapter plan (`totalSteps = 2 + 5 × 1 + 1 = 8`), after brief, outline and script.
Values are illustrative:

```json
{ "completedSteps": 3, "totalSteps": 8, "currentStage": "storyboard", "message": "Storyboarding chapter 1 of 1" }
```

Example `DirectorRun.usage`, shortened to one stage. Values are illustrative; the cost follows the default `claude-opus-5-5`
pricing (USD per million tokens: input 4.00, output 20.00, cache write 5.00): 0.012 + 0.030 + 0.010 = 0.052.

```json
{
  "stages": [
    {
      "stage": "brief", "chunk": null, "provider": "anthropic", "model": "claude-opus-5-5",
      "attempts": 1, "cached": false,
      "usage": { "inputTokens": 3000, "outputTokens": 1500, "cacheReadTokens": 0, "cacheWriteTokens": 2000 },
      "estimatedCostUsd": 0.052, "pricingKnown": true, "latencyMs": 18500
    }
  ],
  "totals": {
    "inputTokens": 3000, "outputTokens": 1500, "cacheReadTokens": 0, "cacheWriteTokens": 2000,
    "estimatedCostUsd": 0.052, "calls": 1, "cachedCalls": 0
  }
}
```

Evolving JSON documents (separate from SQL migrations):

- **Timeline.** Stored rows are never rewritten. A future timeline v2 adds a migration to `TIMELINE_MIGRATIONS`, and readers
  upgrade old documents on read with `parseTimeline` (migrate, then parse). Documents with a newer `schemaVersion` than the
  code knows are rejected ([ADR-011](DECISIONS.md#adr-011-integer-frames-and-a-versioned-timeline-with-migrations)).
- **Artifacts and request.** Neither carries a version number in M1. A breaking change to `DirectorArtifactsSchema` or
  `VideoRequestSchema` would make old rows fail validation. Before making one, add a version field and a migration path the
  same way the timeline does (**planned**, when first needed).
- **Cache outputs.** Bump `PROMPT_VERSION` whenever a prompt or an LLM-facing schema changes.

## 5. Status enums and state machines

The database stores upper-case Prisma enums. The API maps them to the lower-case values of `ProjectStatusSchema` and
`DirectorRunStatusSchema` in `apps/studio-api/src/lib/dto.ts`.

| Prisma enum | Values | DTO values |
|---|---|---|
| `ProjectStatus` | `DRAFT`, `DIRECTING`, `READY`, `FAILED` | `draft`, `directing`, `ready`, `failed` |
| `RunStatus` | `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED` | `queued`, `running`, `succeeded`, `failed`, `cancelled` |

### 5.1 Project

```mermaid
stateDiagram-v2
  [*] --> DRAFT: POST /v1/projects
  DRAFT --> DIRECTING: director run queued
  DIRECTING --> READY: run SUCCEEDED, new version is current
  DIRECTING --> READY: run FAILED or CANCELLED, project already has a version
  DIRECTING --> FAILED: run FAILED, no version yet
  DIRECTING --> DRAFT: run CANCELLED, no version yet
  READY --> DIRECTING: re-run
  FAILED --> DIRECTING: re-run
  DRAFT --> [*]: DELETE
  READY --> [*]: DELETE
  FAILED --> [*]: DELETE

  note right of DIRECTING
    DELETE returns 409 RUN_ACTIVE while
    a run is QUEUED or RUNNING
  end note
```

A successful run sets `READY` and the new `currentVersionId` in its success transaction. The status after a run stops
**without** producing a version is decided in one place, `restoreProjectStatus` (`src/services/project-status.ts`), called by
the cancel endpoint, `markRunFailed`, the reaper and the worker's cancellation finaliser:

| Run outcome | Project has a current version | Project has no version yet |
|---|---|---|
| `FAILED` (any error code, including `TIMEOUT`, `QUOTA_EXCEEDED`, `SHUTDOWN`, `WORKER_LOST` and `QUEUE_LOST`) | `READY` | `FAILED` |
| `CANCELLED` | `READY` | `DRAFT` |

It does nothing while another run of the project is still active, so a late finaliser cannot overwrite `DIRECTING` after a
quick re-run.

- The web app starts a run right after creating a project, so `DRAFT` is usually brief. Through the API, or after cancelling a
  first run, a project can stay `DRAFT` indefinitely.
- A failed or cancelled re-run never loses work: the project returns to `READY` and keeps its current version.
- If the job cannot be enqueued (Redis does not answer within `QUEUE_ENQUEUE_TIMEOUT_MS`), the run is marked `FAILED`
  (`QUEUE_UNAVAILABLE`), the project returns to the status it had **before** the start (a `DRAFT` project stays `DRAFT`), and
  the API returns 503 ([DEVELOPMENT.md troubleshooting](DEVELOPMENT.md#11-troubleshooting)).
- `READY` does not mean rendered. Rendering is **planned (M2)**, with its own status on the planned `Render` table.

### 5.2 DirectorRun

```mermaid
stateDiagram-v2
  [*] --> QUEUED: POST director-runs (202), cost ceiling reserved
  QUEUED --> RUNNING: worker claims the job (startedAt, heartbeatAt)
  QUEUED --> CANCELLED: POST cancel
  QUEUED --> FAILED: enqueue failed (QUEUE_UNAVAILABLE), job lost (QUEUE_LOST, reaper), delivered during shutdown (SHUTDOWN) or BullMQ gave up (INTERNAL)
  RUNNING --> SUCCEEDED: version committed in one transaction
  RUNNING --> FAILED: DirectorError, TIMEOUT, QUOTA_EXCEEDED, SHUTDOWN or INTERNAL (partial usage kept)
  RUNNING --> FAILED: heartbeat stale (WORKER_LOST by the reaper, usage from the last progress write)
  RUNNING --> CANCELLED: POST cancel, worker aborts (partial usage kept)
  SUCCEEDED --> [*]
  FAILED --> [*]
  CANCELLED --> [*]

  note right of RUNNING
    Heartbeat about every 2 s. Runs are
    never re-queued after a crash or shutdown.
  end note
```

**Worker crashes and shutdowns** ([ADR-019](DECISIONS.md#adr-019-run-heartbeat-and-stale-run-reaper-failed-runs-are-never-re-queued)).
A `RUNNING` run writes `heartbeatAt` about every 2 s. The stale-run reaper (`src/director/reaper.ts`) runs every
`DIRECTOR_REAPER_INTERVAL_MS` (default 30 s) in every worker process, and in the API process with `QUEUE_DRIVER=inline`:

- a `RUNNING` run whose heartbeat (or, before the first heartbeat, `startedAt`) is older than `DIRECTOR_HEARTBEAT_STALE_MS`
  (default 60 s) becomes `FAILED` with `WORKER_LOST`; its token and cost columns keep what was written with progress;
- a `QUEUED` run older than `DIRECTOR_QUEUED_STALE_MS` (default 10 min) whose queue job is missing, failed or completed becomes
  `FAILED` with `QUEUE_LOST`. A job that is still waiting or active, or whose state cannot be read (Redis down), is left for a
  later pass.

Both are conditional updates in one transaction with the project status restore, so concurrent reapers and workers are safe and
a late worker cannot revive a reaped run (its next heartbeat or progress write matches no `RUNNING` row and it aborts). The
migration set `heartbeat_at` to the migration time for runs that were already `RUNNING`, which gives them a grace period.

BullMQ jobs use `maxStalledCount: 0` and a lock of `DIRECTOR_JOB_LOCK_MS` (default 5 min). When BullMQ gives up on a job (stalled
lock, or an unexpected processor error), the worker marks the run `FAILED` with `INTERNAL` ("The director worker stopped
unexpectedly while processing this run") only if no process is still working on it: not the local process, and no heartbeat
fresher than `DIRECTOR_HEARTBEAT_STALE_MS`. On SIGINT or SIGTERM a worker aborts its in-flight runs and records them `FAILED`
with `SHUTDOWN` (partial usage kept); a job delivered during shutdown is recorded `SHUTDOWN` without starting. The final writes
of a run (success, failure, cancellation) are retried with backoff for about a minute (`FINAL_WRITE_RETRY_DELAYS_MS`), so a short
database outage does not strand a row in `RUNNING`.

Invariants:

1. A project is `DIRECTING` exactly while it has a `QUEUED` or `RUNNING` run.
2. A project has at most one `QUEUED` or `RUNNING` run (`POST director-runs` returns 409 `RUN_ACTIVE` otherwise).
3. Terminal run states (`SUCCEEDED`, `FAILED`, `CANCELLED`) are final. Every write that ends a run is a conditional update on
   the current status (section 6).
4. `startedAt` and `heartbeatAt` are set when a run becomes `RUNNING`; `finishedAt` when it reaches a terminal state. A run
   that ends while `QUEUED` (cancelled, `QUEUE_UNAVAILABLE`, `QUEUE_LOST`, `SHUTDOWN`) never gets a `startedAt`.
5. A `SUCCEEDED` run has exactly one `ProjectVersion` with its id in `directorRunId` (unique) while its project exists. Failed and
   cancelled runs have none.
6. Deleting a project never deletes runs: its versions cascade away, and its runs keep their status, usage and error with
   `projectId = null`. Only terminal runs can be in that state, because deletion is refused while a run is active.

## 6. Query patterns, indexes and concurrency

| Operation | Query shape | Index used |
|---|---|---|
| Authenticate a request | `ApiToken` by `tokenHash`, with its `User`; `lastUsedAt` updated at most once per minute. Skipped entirely for a client IP over its failed-auth budget (`RATE_LIMIT_UNAUTH_PER_MINUTE`). | unique `tokenHash` |
| `GET /v1/projects` | `Project` where `ownerId`, order by `updatedAt` desc then `id` desc (keyset). The cursor is opaque: base64url of `<updatedAt ISO>~<id>` of the last row served, and the next page is `updatedAt < c.updatedAt OR (updatedAt = c.updatedAt AND id < c.id)`. An undecodable cursor is 400 `INVALID_CURSOR`. A second query counts all of the owner's projects for `total`. | `[ownerId, updatedAt]` |
| `GET /v1/projects/:id` and every project-scoped route | `Project` where `id` and `ownerId` | primary key |
| Run by id, cancel | `DirectorRun` where `id` and `project.ownerId`. A run whose project was deleted (`projectId = null`) matches nothing, so it returns 404. | primary key |
| Latest runs of a project, active-run check | `DirectorRun` where `projectId` (and `status` in `QUEUED`, `RUNNING`), order by `createdAt` desc then `id` desc | `[projectId, createdAt]` |
| Usage today and this month, daily quotas | Aggregate `DirectorRun` where `requestedById` and `createdAt` at or after the start of the current UTC day or UTC month, excluding runs that never started (`FAILED` with `startedAt` null and `errorCode` `QUEUE_UNAVAILABLE` or `QUEUE_LOST`): count of runs and sums of the token and cost columns. No join to `Project`, so runs of deleted projects are included. | `[requestedById, createdAt]` |
| Active runs and reservations of a user | `DirectorRun` where `requestedById` and `status` in `QUEUED`, `RUNNING`: count, `createdAt`, `reservedCostUsd`, `estimatedCostUsd` | `[requestedById, status]` |
| Live spend check of a running run | Sum of `estimatedCostUsd` of the user's other runs created today | `[requestedById, createdAt]` |
| Reaper | `RUNNING` runs with a stale `heartbeatAt`; `QUEUED` runs with an old `createdAt`; 100 per pass each | `[status, heartbeatAt]` |
| Versions of a project | `ProjectVersion` where `projectId`, order by `version` desc, latest 100, summary columns only (section 3.4) | unique `[projectId, version]` |
| One version | Owner-scoped id lookup by `(projectId, version)`, then the row by id unless the serialized DTO is cached | unique `[projectId, version]`, primary key |
| Cache lookup | `DirectorCacheEntry` by `key` (the user-scoped hash) | primary key |

Because `updatedAt` changes whenever a run starts or ends, a project can move between pages while someone is paging through the
project list. The cursor encodes a position, not a row, so a row that moved or was deleted never causes an error or a
duplicate; a project that moved to the front after page 1 was fetched is not shown again on later pages.

How M1 keeps concurrent writers consistent:

- **Quotas are serialized per user.** `startDirectorRun` (`src/services/director-runs.ts`) runs in one transaction that first
  takes a transaction-scoped advisory lock for the user (`pg_advisory_xact_lock(0x56430001, hashtext(userId))`), so concurrent
  starts by the same user on any of their projects run one after another. Every quota read runs on that same transaction, never
  on a second pooled connection, so a burst of starts cannot exhaust the pool or deadlock (tested with 20 concurrent starts).
- **One active run per project.** Inside that transaction it takes the owner-scoped row lock on the project
  (`SELECT ... FOR UPDATE`; 404 when the project is gone or not owned), then checks for an active run (409 `RUN_ACTIVE`), checks
  the quotas, inserts the run with its `reservedCostUsd` and sets the project to `DIRECTING`. `deleteProject` takes the same
  project lock before its active-run check, so a project cannot be deleted while a run is being started for it, and a start on a
  project deleted meanwhile answers 404, not a foreign-key error.
- **The USD quota is a reservation.** Each active run reserves its cost ceiling, so concurrent starts cannot over-commit the
  daily budget, and the worker stops a run whose live spend reaches the limit ([ADR-018](DECISIONS.md#adr-018-spend-caps-enforced-with-a-per-run-cost-ceiling-reservation-and-a-live-budget-check)).
  Spend can still exceed the limit by what the stages already in flight cost after the limit is reached.
- **Claiming a run is atomic.** The worker skips a run that is not `QUEUED` or whose `projectId` is null, then moves it from
  `QUEUED` to `RUNNING` with one conditional update (`updateMany where status = QUEUED`). If that matches no row (already
  claimed or cancelled), the job is skipped.
- **Ending a run is conditional.** Progress writes and the success update match only `status = RUNNING`. If a cancel landed
  first, the success transaction rolls back and the run is finalised as cancelled. Marking `FAILED` matches only `QUEUED` or
  `RUNNING`; cancelling matches only `QUEUED` or `RUNNING` (otherwise 409 `RUN_NOT_ACTIVE`). The cancellation finaliser in the
  worker only fills `finishedAt` if it is still null and the usage columns if `usage` is still null, so it never overwrites what
  the cancel endpoint or an earlier write recorded.
- **Cancellation reaches a running director** through the run row: the heartbeat (about every 2 s) and every progress write
  are conditional updates on `status = RUNNING`, so when one matches no row the worker aborts the in-flight provider call. The
  same mechanism stops a worker whose run was reaped.
- **Final writes are retried.** Saving the result, recording a failure and recording a cancellation are retried with backoff
  for about a minute (`retryTransient`, `FINAL_WRITE_RETRY_DELAYS_MS`). A result that still cannot be saved is recorded as
  `FAILED` instead of leaving the run `RUNNING`.
- **Version numbers** are `max(version) + 1` inside the success transaction, backed by `@@unique([projectId, version])`.

## 7. Migration workflow

Prisma CLI commands read `DATABASE_URL` through `apps/studio-api/prisma.config.ts`, which loads `apps/studio-api/.env` with
`process.loadEnvFile` when the file exists (the package scripts and `pnpm --filter @vc/studio-api exec` run in
`apps/studio-api`). A `DATABASE_URL` already set in the shell wins over the file, and without either the CLI falls back to the
local `video_studio` database, so the commands below only set it when they target a database other than the one in `.env`.

### 7.1 First-time setup

```bash
pnpm install                                      # postinstall runs prisma generate -> src/generated/prisma (gitignored)
docker compose up -d                              # Postgres 16 + Redis 7
cp apps/studio-api/.env.example apps/studio-api/.env   # then set STUDIO_DEV_API_TOKEN (openssl rand -hex 32)
pnpm studio:db:migrate                            # prisma migrate deploy (DATABASE_URL from apps/studio-api/.env)
pnpm studio:db:seed                               # dev user + hashed STUDIO_DEV_API_TOKEN
```

The full local setup, including the web app, is in [DEVELOPMENT.md](DEVELOPMENT.md#2-first-time-setup).

`docker/postgres/init-databases.sql` only runs on an empty volume. If your `pgdata` volume existed before the studio, create the
databases once:

```bash
docker compose exec postgres psql -U postgres -c 'CREATE DATABASE video_studio' -c 'CREATE DATABASE video_studio_test'
```

`pnpm install` generates the Prisma client through the `@vc/studio-api` `postinstall` script, without needing a database. Run
`pnpm --filter @vc/studio-api db:generate` by hand after changing `schema.prisma` or checking out a commit that changes it. CI
runs it explicitly before `pnpm typecheck`.

### 7.2 Changing the schema (development)

```bash
# 1. Edit apps/studio-api/prisma/schema.prisma
# 2. Create and apply a migration against the development database (video_studio)
pnpm --filter @vc/studio-api exec prisma migrate dev --name <short_snake_case_change>
# 3. Regenerate the client
pnpm --filter @vc/studio-api db:generate
```

- `migrate dev` writes `apps/studio-api/prisma/migrations/<timestamp>_<name>/migration.sql` and applies it. It uses a temporary
  shadow database, so the database user needs permission to create databases (the local `postgres` user has it).
- To review or hand-edit the SQL first (partial indexes, data backfills), add `--create-only`, edit `migration.sql`, then run
  `migrate dev` again to apply it.
- Commit `schema.prisma`, the new migration directory and `migration_lock.toml` together. The committed migrations are
  `20261009082453_init`, `20261009085125_run_accounting` and `20261009140000_run_reservations_heartbeat_version_summary`
  (section 1). The last one contains hand-written SQL besides the generated DDL: the heartbeat grace period and the
  summary-column backfill.
- Keep `@map` / `@@map` on every new field and model so Postgres names stay snake_case.
- Never edit or delete a migration that has been applied anywhere else. Fix forward with a new migration.
- Prefer additive changes. For renames and drops, use expand and contract: add the new column, deploy code that writes both,
  backfill, switch reads, then drop the old column in a later migration.
- Never run `migrate dev` or `migrate reset` against `video_studio_test` or any shared or production database.

### 7.3 Applying migrations (CI, test, production)

```bash
DATABASE_URL=<target database URL> pnpm --filter @vc/studio-api db:migrate          # prisma migrate deploy
DATABASE_URL=<target database URL> pnpm --filter @vc/studio-api exec prisma migrate status
```

- `migrate deploy` applies pending committed migrations in order. It never generates migrations or resets data.
- In a deployment, run `migrate deploy` before starting the new API and worker versions. The API and the worker share the
  schema, so each migration must work with the code version that is still running.
- Code running against a database that is behind it fails on the first query that touches a missing column, for example
  500 `INTERNAL` on `GET /v1/projects/:id/versions` with "The column `project_versions.scene_count` does not exist" in the API
  log. `prisma migrate status` shows what is pending.

### 7.4 Test database

- `video_studio_test` is migrated automatically. The studio-api vitest global setup (`test/global-setup.ts`) runs
  `prisma migrate deploy` with `DATABASE_URL` set to `TEST_DATABASE_URL` (default
  `postgres://postgres:postgres@localhost:5432/video_studio_test`), and refuses to run unless the database name in that URL
  ends with `_test`. Tables are truncated between tests, and `fileParallelism: false` keeps test files from sharing the
  database concurrently.
- In CI, the Postgres service container creates `video_studio_test` (`POSTGRES_DB`).
- To migrate it by hand:
  `DATABASE_URL=postgres://postgres:postgres@localhost:5432/video_studio_test pnpm --filter @vc/studio-api db:migrate`.

### 7.5 Resetting local data

```bash
pnpm --filter @vc/studio-api exec prisma migrate reset   # drops ALL data in video_studio, re-applies migrations
pnpm studio:db:seed
```

## 8. Planned tables (later milestones)

> **Planned.** None of the tables in this section exist in `schema.prisma`. Names and fields are a sketch of the intended design
> and will change when each milestone is built.

```mermaid
erDiagram
  User ||--o{ Asset : "owns"
  Asset ||--o{ ReferenceProfile : "analysed into"
  Project ||--o{ Render : "rendered as"
  ProjectVersion ||--o{ Render : "source version"
  Render ||--|{ RenderSegment : "split into"
  Render |o--o| Asset : "output"
  Project ||--o{ ProviderJob : "provider jobs"
  ProviderJob |o--o| Asset : "result"

  Asset {
    String id PK "referenced as asset://id"
    String ownerId FK
    AssetKind kind "image video audio font model3d document subtitle"
    String mimeType "sniffed from content"
    BigInt sizeBytes
    String sha256
    String storageKey
    AssetStatus status
    Json metadata "ffprobe or image metadata"
    DateTime createdAt
    DateTime deletedAt "nullable"
  }
  ReferenceProfile {
    String id PK
    String assetId FK
    String ownerId FK
    AnalysisStatus status
    Int schemaVersion
    Json profile "ReferenceProfile v1"
    String errorCode "nullable"
    DateTime createdAt
    DateTime finishedAt "nullable"
  }
  Render {
    String id PK
    String projectId FK
    String projectVersionId FK
    String requestedById FK
    RenderStatus status
    Json settings "RenderSettings"
    Json progress
    String outputAssetId FK "nullable"
    Json validation "ffprobe report"
    String errorCode "nullable"
    DateTime createdAt
    DateTime startedAt "nullable"
    DateTime finishedAt "nullable"
  }
  RenderSegment {
    String id PK
    String renderId FK
    Int index "unique per render"
    String chapterId
    Int startFrame
    Int endFrame
    SegmentStatus status
    Int attempts
    String storageKey "nullable"
    String checksum "nullable"
    DateTime leaseExpiresAt "nullable, M7"
  }
  ProviderJob {
    String id PK
    String ownerId FK
    String projectId FK
    String sceneId "nullable"
    String kind "video-generation tts music transcription"
    String provider
    String externalJobId "nullable"
    String idempotencyKey UK
    JobStatus status
    Json request
    String resultAssetId FK "nullable"
    Decimal estimatedCostUsd
    Decimal actualCostUsd "nullable"
    DateTime createdAt
    DateTime finishedAt "nullable"
  }
```

| Planned table | Milestone | Purpose | Notes |
|---|---|---|---|
| `Asset` | M3 (GLB models M5) | Uploaded and generated files in S3-compatible storage. Timelines reference them as `asset://<id>` (`SafeUriSchema`). | MIME type sniffed from content, size limits checked during upload, owner-scoped like projects. Soft delete, then object deletion. |
| `ReferenceProfile` | M3 | Analysis results for a reference asset: a validated `ReferenceProfile` v1 document plus job status. | The analysis job is queued and cancellable, with temp-file cleanup. `VideoRequest.referenceAssetIds` resolve to these. |
| `Render` | M2 | One render of one `ProjectVersion` with given `RenderSettings`: status, progress, the output asset, the ffprobe validation report. | Mirrors `DirectorRun`: database is the source of truth, jobs carry ids, terminal states are final. |
| `RenderSegment` | M2 (leases and resume M7) | One frame-range segment of a render: status, attempts, stored file, checksum. | `@@unique([renderId, index])`. Segments are contiguous and their frame counts sum to `durationInFrames`. In M7 a worker lease lets crashed renders resume. |
| `ProviderJob` | M4 (TTS, music), M6 (video generation) | External asynchronous provider jobs: request, external id, status, result asset, estimated and actual cost. | Unique `idempotencyKey` so a retried submit never creates a second paid job. Cost columns feed the M6 cost controls. |
| Organizations, memberships, sessions, plans and quotas | M8 | OIDC login, teams, roles, billing and per-plan quotas. | Not designed yet. |
| Campaigns tables | M7 | Campaigns merged as a studio module. | Whether they move into Prisma or stay raw SQL is PRD open question Q13. |

## 9. Retention and cleanup

M1 deletes nothing automatically. There is no TTL job, no archival and no backup automation.

| Data | Growth | M1 behaviour | Planned |
|---|---|---|---|
| `Project` with its versions | Per project | `DELETE /v1/projects/:id` (refused with 409 while a run is active) cascades to its `ProjectVersion` rows. Its `DirectorRun` rows are kept with `projectId` set to null. | Delete with storage cleanup once assets and renders exist (M2, M3) |
| `ProjectVersion` | One per successful run. Each row holds a full timeline and all artifacts; size grows with scene count. | Kept until the project is deleted. No pruning. | Retention policy, for example keep the current version plus the last N, with the versions UI (M2) |
| `DirectorRun` | One per run | Never pruned. Runs are the usage and quota history, so they survive project deletion (`projectId = null`). Deleted only with the user who requested them. The reaper only moves stale runs to `FAILED`; it deletes nothing. | Usage ledger with billing (M8) |
| `ApiToken` | Rare | Revoked tokens stay in the table. Deleted only with their user. | Token management (M8) |
| `User` | Rare | No delete endpoint. Deleting a user in the database cascades to their tokens, projects (with versions) and the runs they requested. Their cache entries stay (no foreign key). | Account deletion (M8) |
| `DirectorCacheEntry` | One per distinct stage call per user | Unbounded: no TTL, no eviction ([ROADMAP known gaps](ROADMAP.md#known-gaps-carried-out-of-m1), PRD Q5). Entries are already scoped per user through the key. Rows written before the M1 review (prompt version `m1.0`, older key composition) can no longer be hit. `DIRECTOR_CACHE=off` stops new reads and writes. | TTL or eviction decision, and organization scope with M8 |
| BullMQ job records (Redis) | Per job | `removeOnComplete: 1000`, `removeOnFail: 5000`. Postgres stays the source of truth. | — |
| `video_studio_test` | Per test | All six tables truncated between tests (`test/helpers.ts`). | — |

Things to know before deleting data:

- **Deleting a project keeps its runs in usage and quota totals.** `/v1/usage` and the daily quotas are computed from
  `DirectorRun` rows, which survive the project with `projectId = null`, so deleting projects does not lower today's counted runs
  or spend. Run rows hold accounting data (provider, model, tokens, cost, reservation, status, error, warnings, progress
  message), not the request or its prompts. Usage figures are estimates from the pricing table, and runs ended by a worker crash
  keep only the usage written with their last progress update (section 3.5). A usage ledger that records every provider call
  is planned with billing (M8).
- **Cache entries outlive projects and users.** Deleting a project or a user does not delete cache entries derived from their
  prompts. They hold model outputs (briefs, scripts, storyboards) that may contain content from the user's request. Because the
  owner is only hashed into the key, one user's entries cannot be selected; for a privacy deletion, clear the cache table (or
  delete by age, below).
- **Cache entries are always safe to delete.** The only cost is cache misses, which means new provider calls and new spend on the
  next identical run. Entries from an old `PROMPT_VERSION` cannot be selected directly because the version is hashed into the
  key, but age-based cleanup removes them. For example, from a one-off script using the studio-api Prisma client:

  ```ts
  // Delete cache entries unused for 30 days.
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await prisma.directorCacheEntry.deleteMany({
    where: { OR: [{ lastHitAt: { lt: cutoff } }, { lastHitAt: null, createdAt: { lt: cutoff } }] },
  });
  ```

- **Losing Redis loses queued jobs, not runs.** While Redis is unreachable, starting a run fails fast (within
  `QUEUE_ENQUEUE_TIMEOUT_MS`) and the run is marked `FAILED` (`QUEUE_UNAVAILABLE`) (section 5.1). Jobs already in Redis when it
  is flushed or lost are gone: their runs stay `QUEUED` until the reaper finds them older than `DIRECTOR_QUEUED_STALE_MS`
  (10 min) with no job and fails them with `QUEUE_LOST` (section 5.2). The user can cancel them sooner.
- **Backups.** None in M1. Local data lives in the `pgdata` Docker volume. Postgres backups with tested restores are
  **planned (M8)**.
- **Planned tables.** Render temp files are removed on success, failure and cancellation (M2). Segment files are kept until the
  export is validated (M2) or, for resumable renders, until the render completes (M7). Assets are soft-deleted and their
  objects removed from storage afterwards (M3). Provider job rows are kept as a cost record (M6).
