# Database

| | |
|---|---|
| Document status | Living document. Revised at each milestone close. |
| Last updated | 2026-10-09 |
| Current milestone | **M1 Foundation (in progress)**. See [ROADMAP.md](ROADMAP.md). |
| Source of truth | **`apps/studio-api/prisma/schema.prisma`** and the committed SQL in `apps/studio-api/prisma/migrations/` |
| Related | [ARCHITECTURE.md](ARCHITECTURE.md) · [TIMELINE_SCHEMA.md](TIMELINE_SCHEMA.md) · [AI_DIRECTOR.md](AI_DIRECTOR.md) · [DEVELOPMENT.md](DEVELOPMENT.md) · [M1 spec, section 3](milestones/M1_IMPLEMENTATION_SPEC.md#3-vcstudio-api-appsstudio-api--contract) |

> **The Prisma schema file `apps/studio-api/prisma/schema.prisma` is the source of truth.** This document explains it. If the
> two disagree, the schema file is right and this document must be updated. The generated SQL is in
> `apps/studio-api/prisma/migrations/20261009082453_init/migration.sql`.

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
| ORM | Prisma 7.10 with the `prisma-client` generator. The client is generated into `apps/studio-api/src/generated/prisma` (gitignored) and used with the driver adapter `@prisma/adapter-pg`: `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`. |
| Connection URL | `DATABASE_URL`. The app reads it in `src/config.ts`. The Prisma CLI reads it in `apps/studio-api/prisma.config.ts`, which falls back to `postgres://postgres:postgres@localhost:5432/video_studio` and does not load `.env` files. Tests use `TEST_DATABASE_URL` (default `.../video_studio_test`). |
| Naming | PascalCase models and camelCase fields in Prisma; snake_case in Postgres through `@@map` and `@map`. Tables: `users`, `api_tokens`, `projects`, `project_versions`, `director_runs`, `director_cache_entries`. Enum types: `project_status`, `run_status`. Example: `DirectorRun.requestedById` is the column `director_runs.requested_by_id`. |
| Primary keys | `String @id @default(cuid())` on every model except `DirectorCacheEntry`, whose key is the SHA-256 cache key |
| JSON | Prisma `Json` fields are `jsonb` in Postgres. Their contents are validated with Zod schemas from `@vc/schema` before they are written (section 4). |
| Money | `DirectorRun.estimatedCostUsd` is `Decimal(12,6)` so sums are exact. DTOs expose it as a number. |
| Only writer | `@vc/studio-api` (API process and director worker). studio-web never touches the database. |

## 2. Entity-relationship diagram

```mermaid
erDiagram
  User ||--o{ ApiToken : "authenticates with"
  User ||--o{ Project : "owns"
  User ||--o{ DirectorRun : "requested"
  Project ||--o{ ProjectVersion : "has versions"
  Project |o--o| ProjectVersion : "currentVersionId"
  Project ||--o{ DirectorRun : "has runs"
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
    String directorRunId FK, UK "nullable, on delete set null"
    DateTime createdAt
  }
  DirectorRun {
    String id PK
    String projectId FK "on delete cascade"
    String requestedById FK "on delete cascade"
    RunStatus status "default QUEUED"
    String provider
    String model
    String promptVersion
    Json progress
    Json usage "UsageReport, nullable"
    Int inputTokens "default 0"
    Int outputTokens "default 0"
    Int cacheReadTokens "default 0"
    Int cacheWriteTokens "default 0"
    Decimal estimatedCostUsd "Decimal(12,6), default 0"
    String errorCode "nullable"
    String errorMessage "nullable"
    DateTime createdAt
    DateTime startedAt "nullable"
    DateTime finishedAt "nullable"
  }
  DirectorCacheEntry {
    String key PK "sha256 cache key"
    String stage
    String model
    String provider
    Json output "validated stage output"
    Json usage "TokenUsage of the original call"
    Int hits "default 0"
    DateTime createdAt
    DateTime lastHitAt "nullable"
  }
```

`DirectorCacheEntry` has no relations. It is a deployment-wide cache, not owned by any user or project.

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

In M1 tokens are created only by the seed script from `STUDIO_DEV_API_TOKEN` (at least 32 characters; `.env.example` shows how
to generate a `vcs_`-prefixed random token). The auth hook accepts bearer values of 16 to 512 characters. Revoking a token
means setting `revokedAt` directly in the database. Token-management endpoints are **planned (M8)**.

### 3.3 `Project` (table `projects`)

One video project: the user's request plus its lifecycle status and a pointer to the current version.

| Field | Type | Notes |
|---|---|---|
| `id` | String, PK | Also the pagination cursor for `GET /v1/projects` |
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
| `directorRunId` | String, nullable, unique, FK to `DirectorRun.id` | The run that produced this version. `onDelete: SetNull`. Unique, so a run produces at most one version. Nullable so versions created without a run (planned M2 editor edits) fit the same table. |
| `createdAt` | DateTime | |

Indexes: `@@unique([projectId, version])`, which also serves "versions of a project" lookups and guards against two writers
assigning the same number; unique on `directorRunId`.

Rows are never updated after insert. `ProjectVersionSummaryDTO.sceneCount`, `durationInFrames` and `fps` are not columns; they
are read from the `timeline` JSON. For very long projects with many versions, listing versions therefore reads every
timeline document. Denormalizing those three values into columns is an option if it shows up in measurements.

### 3.5 `DirectorRun` (table `director_runs`)

One execution of the AI Director for a project. It is the source of truth for run state; the queue job only carries its id.

| Field | Type | Notes |
|---|---|---|
| `id` | String, PK | The BullMQ job payload is `{runId: id}` |
| `projectId` | String, FK to `Project.id` | `onDelete: Cascade` |
| `requestedById` | String, FK to `User.id` | Who started the run. `onDelete: Cascade`. M1 has no user-deletion endpoint. |
| `status` | `RunStatus` enum, default `QUEUED` | `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED` (section 5) |
| `provider` | String | Provider name configured when the run was created (for example `mock`) |
| `model` | String | Configured model (for example `mock-director-v1`, `claude-opus-5-5`). The model actually served for each call is in `usage.stages[].model`. |
| `promptVersion` | String | `PROMPT_VERSION` of `@vc/ai-director` (`m1.0`) |
| `progress` | Json | `{completedSteps, totalSteps, currentStage, message}` (section 4) |
| `usage` | Json, nullable | `UsageReport` (section 4) |
| `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` | Int, default 0 | Run totals, copied from `usage.totals` so usage and quota queries can sum columns |
| `estimatedCostUsd` | Decimal(12,6), default 0 | Estimated USD for the run, from the pricing table (unknown models count as 0) |
| `errorCode` | String, nullable | A `DirectorError` code (`VALIDATION_FAILED`, `PROVIDER_REFUSAL`, `PROVIDER_UNAVAILABLE`, `PROVIDER_CONFIG`, `PROVIDER_REQUEST`, `PROVIDER_TRUNCATED`, `CANCELLED`, `LIMIT_EXCEEDED`, `INTERNAL`), or one set by studio-api: `TIMEOUT` (run exceeded `DIRECTOR_RUN_TIMEOUT_MS`), `QUEUE_UNAVAILABLE` (the job could not be enqueued), `INTERNAL` (unexpected error, or the BullMQ job itself failed) |
| `errorMessage` | String, nullable | Sanitized message, safe to show to the user: credentials that look like Anthropic keys or bearer tokens are redacted, control characters removed, length capped at 1000. Unexpected errors get a generic message; details go to the server log. |
| `createdAt` | DateTime | When the run was queued |
| `startedAt`, `finishedAt` | DateTime, nullable | `startedAt` is set when the worker claims the run. `finishedAt` is set on reaching a terminal state, including by the cancel endpoint. |

Indexes:

- `@@index([projectId, createdAt])`: runs of a project, newest first (latest 20), and the active-run check.
- `@@index([requestedById, createdAt])`: per-user usage for today and this month, and the daily quota checks.

**Usage is written only on success.** The token columns, `estimatedCostUsd` and `usage` are filled in the success
transaction. A run that fails, times out or is cancelled keeps zeros and `usage = null`, even if it already spent tokens on
provider calls. `/v1/usage` and the daily USD quota therefore undercount live spend from unsuccessful runs. Every run, whatever
its status, still counts toward the daily run quota.

### 3.6 `DirectorCacheEntry` (table `director_cache_entries`)

Stage-level cache used by `PrismaDirectorCache` (`src/director/prisma-cache.ts`) when `DIRECTOR_CACHE=on` (the default). A hit
skips the provider call entirely.

| Field | Type | Notes |
|---|---|---|
| `key` | String, PK | `computeCacheKey(...)`: SHA-256 hex of canonical (sorted-key) JSON of `{stage, chunk, promptVersion, provider, model, schemaName, system, prompt}` |
| `stage` | String | Intended for inspection. The M1 `CacheEntry` interface of `@vc/ai-director` does not carry the stage, so `PrismaDirectorCache` stores `unknown` unless an entry provides one. |
| `model`, `provider` | String | For inspection and targeted cleanup |
| `output` | Json | The validated output of the stage. Only outputs that passed Zod and the semantic validator are cached. |
| `usage` | Json | `TokenUsage` of the call that produced the output. A row whose `usage` fails `TokenUsageSchema` is treated as a miss. |
| `hits` | Int, default 0 | Incremented on each hit |
| `createdAt` | DateTime | |
| `lastHitAt` | DateTime, nullable | Last hit time. Null if never hit. |

No indexes beyond the primary key. Writes are upserts by `key`. A hit is recorded in the run's usage as a `StageUsage` with `cached: true`, zero tokens and
zero cost; the stored `usage` keeps what the original call cost.

The prompt version is part of the hashed key, so bumping `PROMPT_VERSION` makes old entries unreachable without deleting them
(section 9). Changing an LLM-facing schema without bumping `PROMPT_VERSION` can serve stale outputs, because the key covers the
schema name but not the schema body ([ROADMAP known gaps](ROADMAP.md#known-gaps-carried-out-of-m1)).

## 4. JSON columns

Every JSON document is validated with a `@vc/schema` Zod schema before it is written. Readers should parse it again with the
same schema (for timelines, with `parseTimeline`) rather than trusting the database.

| Column | Contents | Schema in `@vc/schema` | Written | Versioning |
|---|---|---|---|---|
| `Project.request` | The user's request: title, prompt, genre, style notes, duration, aspect ratio, resolution, custom dimensions, fps, language, brand, voice-over and music intent, reference asset ids | `VideoRequestSchema` (also checked with `checkVideoRequestLimits`) | `POST /v1/projects` | No version field in M1 |
| `ProjectVersion.timeline` | The compiled timeline: render settings, `durationInFrames`, brand kit, assets, chapters, scenes, tracks, generator metadata | `TimelineSchema` v1 with all invariants. See [TIMELINE_SCHEMA.md](TIMELINE_SCHEMA.md). | Success transaction | `schemaVersion` inside the document, mirrored in the `schemaVersion` column, plus `TIMELINE_MIGRATIONS` |
| `ProjectVersion.artifacts` | `{brief, outline, script, storyboard, shotList, engineSelection, sceneSpecs}` | `DirectorArtifactsSchema` | Success transaction | No version field in M1 |
| `DirectorRun.progress` | `{completedSteps, totalSteps, currentStage: DirectorStage \| null, message: string \| null}` | The `progress` shape of `DirectorRunDTO` | Created as `{0, 0, null, "Queued"}`. Reset to `"Starting AI Director"` when the worker claims the run, then updated at most every 500 ms. On success it ends at `completedSteps = totalSteps`, stage `compile`, message `"Timeline ready"`. | — |
| `DirectorRun.usage` | `{stages: StageUsage[], totals}` | `UsageReportSchema` | On success | — |
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

The status after a run stops is decided in one place, `restoreProjectStatus` (`src/services/project-status.ts`): `READY` if
the project has a current version; otherwise `FAILED` when the run failed and `DRAFT` when it was cancelled. It does nothing
while another run of the project is still active, so a late finaliser cannot overwrite `DIRECTING` after a quick re-run.

- The web app starts a run right after creating a project, so `DRAFT` is usually brief. Through the API, or after cancelling a
  first run, a project can stay `DRAFT` indefinitely.
- A failed or cancelled re-run never loses work: the project returns to `READY` and keeps its current version.
- If the job cannot be enqueued, the run is marked `FAILED` (`QUEUE_UNAVAILABLE`), the project status is restored, and the API
  returns 503.
- `READY` does not mean rendered. Rendering is **planned (M2)**, with its own status on the planned `Render` table.

### 5.2 DirectorRun

```mermaid
stateDiagram-v2
  [*] --> QUEUED: POST director-runs (202)
  QUEUED --> RUNNING: worker claims the job
  QUEUED --> CANCELLED: POST cancel
  QUEUED --> FAILED: enqueue failed (QUEUE_UNAVAILABLE)
  RUNNING --> SUCCEEDED: version committed in one transaction
  RUNNING --> FAILED: DirectorError, TIMEOUT or INTERNAL
  RUNNING --> CANCELLED: POST cancel, worker aborts
  SUCCEEDED --> [*]
  FAILED --> [*]
  CANCELLED --> [*]

  note right of RUNNING
    Known M1 gap: if the worker dies,
    the run stays RUNNING until cancelled
  end note
```

Invariants:

1. A project is `DIRECTING` exactly while it has a `QUEUED` or `RUNNING` run.
2. A project has at most one `QUEUED` or `RUNNING` run (`POST director-runs` returns 409 `RUN_ACTIVE` otherwise).
3. Terminal run states (`SUCCEEDED`, `FAILED`, `CANCELLED`) are final. Every write that ends a run is a conditional update on
   the current status (section 6).
4. `startedAt` is set when a run becomes `RUNNING`; `finishedAt` when it reaches a terminal state. A run cancelled while
   `QUEUED` never gets a `startedAt`.
5. A `SUCCEEDED` run has exactly one `ProjectVersion` with its id in `directorRunId` (unique). Failed and cancelled runs have
   none.

## 6. Query patterns, indexes and concurrency

| Operation | Query shape | Index used |
|---|---|---|
| Authenticate a request | `ApiToken` by `tokenHash`, with its `User`; `lastUsedAt` updated at most once per minute | unique `tokenHash` |
| `GET /v1/projects` | `Project` where `ownerId`, order by `updatedAt` desc then `id` desc, cursor = id of the last item (unknown cursor: 400 `INVALID_CURSOR`) | `[ownerId, updatedAt]` |
| `GET /v1/projects/:id` and every project-scoped route | `Project` where `id` and `ownerId` | primary key |
| Run by id | `DirectorRun` where `id` and `project.ownerId` | primary key |
| Latest runs of a project, active-run check | `DirectorRun` where `projectId` (and `status` in `QUEUED`, `RUNNING`), order by `createdAt` desc then `id` desc | `[projectId, createdAt]` |
| Usage today and this month, daily quotas | Aggregate `DirectorRun` where `requestedById` and `createdAt` at or after the start of the current UTC day or UTC month: count of runs (all statuses) and sums of the token and cost columns | `[requestedById, createdAt]` |
| Versions of a project, one version | `ProjectVersion` where `projectId` (and `version`) | unique `[projectId, version]` |
| Cache lookup | `DirectorCacheEntry` by `key` | primary key |

Because `updatedAt` changes whenever a run starts or ends, a project can move between pages while someone is paging through the
project list.

How M1 keeps concurrent writers consistent:

- **One active run per project.** `startDirectorRun` (`src/services/director-runs.ts`) runs in a transaction that first takes a
  row lock on the project (`SELECT ... FOR UPDATE`), then checks for an active run, checks the quota, inserts the run and sets
  the project to `DIRECTING`. Two simultaneous requests for the same project are serialized, and the second gets 409.
- **Quotas are soft across projects.** The quota check happens under the project's lock, not a per-user lock, so simultaneous
  runs on different projects can each pass it. A single run can also go past the USD limit, since cost is known only at the end.
- **Claiming a run is atomic.** The worker moves a run from `QUEUED` to `RUNNING` with one conditional update
  (`updateMany where status = QUEUED`). If it matches no row (already claimed, cancelled or deleted), the job is skipped.
- **Ending a run is conditional.** Progress writes and the success update match only `status = RUNNING`. If a cancel landed
  first, the success transaction rolls back and the run is finalised as cancelled. Marking `FAILED` matches only `QUEUED` or
  `RUNNING`; cancelling matches only `QUEUED` or `RUNNING` (otherwise 409 `RUN_NOT_ACTIVE`).
- **Version numbers** are `max(version) + 1` inside the success transaction, backed by `@@unique([projectId, version])`.

## 7. Migration workflow

Prisma CLI commands read `DATABASE_URL` from the environment through `apps/studio-api/prisma.config.ts`. They do **not** load
`apps/studio-api/.env` (the app's `dev` and `db:seed` scripts do). Without `DATABASE_URL` the CLI falls back to the local
`video_studio` database, so the commands below only set it when they target a different database.

### 7.1 First-time setup

```bash
docker compose up -d                              # Postgres 16 + Redis 7
cp apps/studio-api/.env.example apps/studio-api/.env   # then set STUDIO_DEV_API_TOKEN
pnpm --filter @vc/studio-api db:generate          # prisma generate -> src/generated/prisma (gitignored)
pnpm studio:db:migrate                            # prisma migrate deploy (video_studio)
pnpm studio:db:seed                               # dev user + hashed STUDIO_DEV_API_TOKEN
```

`docker/postgres/init-databases.sql` only runs on an empty volume. If your `pgdata` volume existed before the studio, create the
databases once:

```bash
docker compose exec postgres psql -U postgres -c 'CREATE DATABASE video_studio' -c 'CREATE DATABASE video_studio_test'
```

Run `db:generate` after every install, checkout or schema change. CI runs it before `pnpm typecheck`.

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
- Commit `schema.prisma`, the new migration directory and `migration_lock.toml` together. The initial migration is
  `20261009082453_init`.
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

### 7.4 Test database

- `video_studio_test` is migrated automatically. The studio-api vitest global setup (`test/global-setup.ts`) runs
  `prisma migrate deploy` with `DATABASE_URL` set to `TEST_DATABASE_URL` (default
  `postgres://postgres:postgres@localhost:5432/video_studio_test`), and refuses to run if that URL does not name
  `video_studio_test`. Tables are truncated between tests, and `fileParallelism: false` keeps test files from sharing the
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
| `Project` with its versions and runs | Per project | `DELETE /v1/projects/:id` (refused with 409 while a run is active) cascades to its `ProjectVersion` and `DirectorRun` rows. | Delete with storage cleanup once assets and renders exist (M2, M3) |
| `ProjectVersion` | One per successful run. Each row holds a full timeline and all artifacts; size grows with scene count. | Kept until the project is deleted. No pruning. | Retention policy, for example keep the current version plus the last N, with the versions UI (M2) |
| `DirectorRun` | One per run | Kept until the project is deleted. Runs are the usage and quota history. | — |
| `ApiToken` | Rare | Revoked tokens stay in the table. Deleted only with their user. | Token management (M8) |
| `User` | Rare | No delete endpoint. Deleting a user in the database cascades to their tokens, projects (with versions and runs) and the runs they requested. | Account deletion (M8) |
| `DirectorCacheEntry` | One per distinct stage call, deployment-wide | Unbounded: no TTL, no eviction ([ROADMAP known gaps](ROADMAP.md#known-gaps-carried-out-of-m1), PRD Q5). `DIRECTOR_CACHE=off` stops new writes. | Scope (per owner or organization) and TTL decision, M8 at the latest |
| BullMQ job records (Redis) | Per job | `removeOnComplete: 1000`, `removeOnFail: 5000`. Postgres stays the source of truth. | — |
| `video_studio_test` | Per test | All six tables truncated between tests (`test/helpers.ts`). | — |

Things to know before deleting data:

- **Deleting a project removes its runs from usage and quota totals.** `/v1/usage` and the daily quotas are computed from
  `DirectorRun` rows, which cascade with the project. A user can therefore lower today's counted runs and spend by deleting
  projects. Together with the success-only usage recording (section 3.5), this makes M1 usage figures a lower bound. A usage
  ledger that records every provider call and survives project deletion is the planned fix (with billing, M8).
- **Cache entries outlive projects.** Deleting a project does not delete cache entries derived from its prompts. They hold model
  outputs (briefs, scripts, storyboards) that may contain content from the user's request. For a privacy deletion, also clear
  the cache.
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

- **Losing Redis loses queued jobs.** If Redis is down when a run starts, the enqueue fails and the run is marked `FAILED`
  (`QUEUE_UNAVAILABLE`). But jobs already in Redis when it is flushed or lost are gone: their runs stay `QUEUED`, and the projects
  stay blocked with 409 `RUN_ACTIVE` until the runs are cancelled. This has the same remedy as a run stuck in `RUNNING`
  (planned reaper, see the ROADMAP known gaps).
- **Backups.** None in M1. Local data lives in the `pgdata` Docker volume. Postgres backups with tested restores are
  **planned (M8)**.
- **Planned tables.** Render temp files are removed on success, failure and cancellation (M2). Segment files are kept until the
  export is validated (M2) or, for resumable renders, until the render completes (M7). Assets are soft-deleted and their
  objects removed from storage afterwards (M3). Provider job rows are kept as a cost record (M6).
