# Development

| | |
|---|---|
| Document status | Living document. Revised at each milestone close. |
| Last updated | 2026-10-09 |
| Current milestone | **M1 Foundation (in progress)**. See [ROADMAP.md](ROADMAP.md). |
| Source of truth | `apps/studio-api/src/config.ts` (API and worker settings), `apps/studio-web/src/lib/studio-api.ts` (web settings), the root `package.json` scripts |
| Related | [ARCHITECTURE.md](ARCHITECTURE.md) · [DATABASE.md](DATABASE.md) · [AI_DIRECTOR.md](AI_DIRECTOR.md) · [PRD.md](PRD.md) · [CAMPAIGNS.md](CAMPAIGNS.md) |

This guide covers running the **Universal AI Video Studio** (`@vc/studio-api`, its director worker and `@vc/studio-web`) on a
developer machine. The campaigns MVP has its own setup; section 12 lists its commands.

> If this document and `apps/studio-api/src/config.ts` disagree, the code is right and this document must be updated.

---

## 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22 or later | Root `package.json` has `engines.node >= 22`. CI uses Node 22. |
| pnpm | 10 | Pinned as `packageManager: pnpm@10.28.0`. Run `corepack enable` once and corepack provides the pinned version. |
| Docker with Compose | Any recent version | Runs Postgres 16 and Redis 7 from `docker-compose.yml`. Optional if you run them locally. |
| PostgreSQL | 16 | Through Docker, or a local server. The defaults expect user `postgres`, password `postgres` on `localhost:5432`. |
| Redis | 7 | Through Docker, or a local server on `localhost:6379`. Not needed with `QUEUE_DRIVER=inline` (section 5). |
| FFmpeg | Not needed yet | The studio renders nothing in M1. FFmpeg is needed from M2 (render pipeline). The campaigns worker already needs it. |
| `jq`, `openssl` | Optional | Used by the examples in this guide |
| Anthropic API key | Optional | Only for live Claude runs (section 4.2). The default mock provider needs no key and spends no credits. |

Ports used in local development:

| Port | Process |
|---|---|
| 3000 | studio-web (`next dev --port 3000`) |
| 4100 | studio-api (`STUDIO_API_PORT`) |
| 5432 | Postgres |
| 6379 | Redis |
| 4000, 5173 | Campaigns API and panel (section 12) |

## 2. First-time setup

Run every command from the repository root.

### 2.1 Install dependencies

```bash
corepack enable
pnpm install
```

`@vc/studio-api` has a `postinstall` script (`prisma generate`), so `pnpm install` also generates the Prisma client into
`apps/studio-api/src/generated/prisma` (gitignored). Generating needs no database: `apps/studio-api/prisma.config.ts` loads
`apps/studio-api/.env` when it exists and otherwise falls back to the local `video_studio` URL. Regenerate by hand after a
change to `prisma/schema.prisma`:

```bash
pnpm --filter @vc/studio-api db:generate
```

### 2.2 Start Postgres and Redis

With Docker:

```bash
docker compose up -d        # postgres:16-alpine and redis:7-alpine, both with health checks
docker compose ps           # wait until both are "healthy"
```

On the first start of an empty `pgdata` volume, Postgres creates three databases: `video_creation` (campaigns, from
`POSTGRES_DB`) and `video_studio` plus `video_studio_test` (from `docker/postgres/init-databases.sql`). The init script runs
only on an empty volume. If your volume existed before the studio, create the studio databases once:

```bash
docker compose exec postgres psql -U postgres -c 'CREATE DATABASE video_studio' -c 'CREATE DATABASE video_studio_test'
```

Without Docker, start Postgres 16 and Redis 7 yourself and create the databases with the same script:

```bash
psql -h localhost -U postgres -f docker/postgres/init-databases.sql
```

If your local server uses other credentials, set `DATABASE_URL` (section 3.2) and `TEST_DATABASE_URL` (section 3.4) to match.
Do not run a local Postgres and the Docker one at the same time: both bind port 5432.

### 2.3 Configure the API and the web app

```bash
cp apps/studio-api/.env.example apps/studio-api/.env
cp apps/studio-web/.env.example apps/studio-web/.env.local
```

Both files are gitignored. Next, create the development API token. It must be at least 32 characters long, and the API and the
web app must use the same value. Skipping this step makes `pnpm studio:db:seed` fail with
`STUDIO_DEV_API_TOKEN: required by the seed script (at least 32 characters)`, and every web page then shows the
"not configured" state (`CONFIG_MISSING_TOKEN`):

```bash
TOKEN=$(openssl rand -hex 32)      # 64 hex characters
sed -i.bak "s/^STUDIO_DEV_API_TOKEN=.*/STUDIO_DEV_API_TOKEN=$TOKEN/" apps/studio-api/.env && rm apps/studio-api/.env.bak
sed -i.bak "s/^STUDIO_API_TOKEN=.*/STUDIO_API_TOKEN=$TOKEN/" apps/studio-web/.env.local && rm apps/studio-web/.env.local.bak
```

You can also edit the two files by hand. `apps/studio-api/.env.example` shows another generator, which produces a `vcs_`-prefixed
token like the ones the API creates in tests:
`node -e "console.log('vcs_' + require('crypto').randomBytes(32).toString('base64url'))"`.

The remaining defaults in `.env.example` work with `docker-compose.yml` as they are: the mock AI provider, the BullMQ queue,
`video_studio` on `localhost:5432` and Redis on `localhost:6379`.

### 2.4 Create the schema and the development user

```bash
pnpm studio:db:migrate     # prisma migrate deploy against video_studio
pnpm studio:db:seed        # upserts dev@localhost and stores the sha256 hash of STUDIO_DEV_API_TOKEN
```

The seed prints the user and token ids, never the token. It is idempotent: re-running it with the same token keeps one token row,
and a new token value adds another row (older tokens stay valid). It never modifies an existing token row: a token that was
revoked (`revokedAt` set) stays revoked, and a token row that belongs to another user stays with that user. Both cases print a
`WARNING:` line on stderr; set a new `STUDIO_DEV_API_TOKEN` value to get a working token. See
[DATABASE.md](DATABASE.md#7-migration-workflow) for schema changes, resets and the test database.

Projects live in the database, not in git, so a fresh clone starts with an empty dashboard. To get sample data:

```bash
pnpm studio:db:seed:demo   # seeds the dev user (as above), then 4 demo projects with a succeeded run each
```

The demo seed creates its projects and runs the director through the same services as the API and the worker, so each project
gets a real, validated Timeline v1 version (storyboard, shot list, animatic preview). It always uses the heuristic mock provider,
whatever `AI_PROVIDER` says, so it never spends Claude credits; the runs still count toward the daily run quota. It skips any
demo title the dev user already has, so it is safe to re-run; delete a demo project in the UI to have it re-created.

`studio:db:migrate` runs the Prisma CLI. `apps/studio-api/prisma.config.ts` loads `apps/studio-api/.env` with
`process.loadEnvFile` (only when the file exists, and without overriding variables already set in the shell), so the CLI uses
the same `DATABASE_URL` as the API. Without either, it falls back to `postgres://postgres:postgres@localhost:5432/video_studio`.
The seed script loads `apps/studio-api/.env` too (`tsx --env-file-if-exists=.env`).

### 2.5 Start the processes

Use three terminals:

```bash
pnpm studio:dev:api        # Fastify API on http://localhost:4100 (tsx watch)
pnpm studio:dev:worker     # BullMQ director worker and stale-run reaper (tsx watch)
pnpm studio:dev:web        # Next.js dev server on http://127.0.0.1:3000
```

The API logs `studio-api ready` with the provider, model and queue driver. The worker logs `studio-worker ready` with its queue
(`studio-director`), concurrency, provider, model, cache setting, job lock duration and reaper interval. Check the API:

```bash
curl -s http://localhost:4100/health      # {"ok":true,"version":"0.1.0"}  liveness, no I/O
curl -s http://localhost:4100/ready       # {"ok":true,"checks":{"database":"ok","queue":"ok"}}  503 when a check fails
```

The web dev server and `next start` bind `127.0.0.1` only (`-H 127.0.0.1` in `apps/studio-web/package.json`). In M1 anyone
who can reach studio-web acts as the user whose token it holds, so it is not reachable from other machines by default
([PRD 7.3](PRD.md#73-security)).

### 2.6 Open the studio

Open <http://127.0.0.1:3000> (`http://localhost:3000` also works when `localhost` resolves to `127.0.0.1`). The dashboard
shows the project count (the API's `total`), today's runs and estimated cost, this month's tokens and cost, and the most
recently updated projects; **Projects** pages through all of them. **New project** creates a project and starts a director run
right away. The project page shows the run's progress bar with Cancel and Re-run (with a live provider, starting or re-running
asks for confirmation first), a version switcher when the project has more than one version, and the tabs Storyboard, Preview
(animatic), Brief, Script, Shot list, Timeline JSON, Usage and Request (the stored `VideoRequest`). Only the active tab is
rendered on the server; the URL carries `?tab=`, `?version=` and, on paginated tabs, `?page=` (Script 150 segments, Shot list
200 shots, Usage 100 stage calls per page). A missing project answers HTTP 404. **Settings** shows the AI provider, queue
driver, limits, engine availability and the template catalog as reported by the API, plus whether the web app has a token
configured.

With the mock provider a 30-second video finishes in about a second (one chapter, 8 steps, 7 mock calls).

### 2.7 Daily workflow

```bash
docker compose up -d
pnpm studio:db:migrate     # after pulling new migrations
pnpm studio:dev:api        # terminal 1
pnpm studio:dev:worker     # terminal 2
pnpm studio:dev:web        # terminal 3
```

After editing `apps/studio-api/.env`, restart **both** the API and the worker. They read the same file, and they must agree on
the AI provider: the API records the provider and model on each new run, and the worker actually runs it. Do not rely on watch
mode to pick up `.env` changes. After editing `apps/studio-web/.env.local`, restart the web dev server.

## 3. Environment variables

### 3.1 How configuration is loaded

- **studio-api and the worker** validate their environment with Zod at startup (`loadConfig` in
  `apps/studio-api/src/config.ts`). An invalid or missing required value stops the process with
  `Invalid studio-api configuration:` followed by one line per variable. Error messages name variables but never print their
  values.
- An empty value (`KEY=`) means unset, so the default applies. Values are trimmed.
- The `dev`, `dev:worker` and `db:seed` scripts load `apps/studio-api/.env` (`tsx --env-file-if-exists=.env`). Variables already
  set in the shell take precedence over the file, so `LOG_LEVEL=debug pnpm studio:dev:api` works for one-off overrides.
- The `start` and `start:worker` scripts do **not** load `.env`. They expect a real environment (production-style).
- Prisma CLI commands (`db:generate`, `db:migrate`, `db:migrate:dev`, `prisma ...`) go through
  `apps/studio-api/prisma.config.ts`, which loads `.env` from the current directory (`apps/studio-api` when run through the
  package scripts or `pnpm --filter @vc/studio-api exec`) with `process.loadEnvFile`. Variables already set in the shell win,
  so `DATABASE_URL=... pnpm --filter @vc/studio-api db:migrate` targets another database. Without any `DATABASE_URL` the CLI
  falls back to the local `video_studio` URL.
- **studio-web** reads `STUDIO_API_URL` and `STUDIO_API_TOKEN` on the server only (`apps/studio-web/src/lib/studio-api.ts`,
  imported with `server-only`). Next.js loads them from `apps/studio-web/.env.local` (or `.env`). Never prefix them with
  `NEXT_PUBLIC_`: that would ship the token to the browser.

### 3.2 studio-api and worker (`apps/studio-api/.env`)

Defaults below are the values `loadConfig` applies when a variable is unset. They were checked by calling `loadConfig` with only
`DATABASE_URL` set. "Secret" means: keep it out of version control, logs and screenshots.

Every `*_MS` variable below is an integer number of milliseconds capped at 2 147 483 647 (about 24.8 days, `MAX_TIMER_MS` in
`config.ts`): Node.js fires larger `setTimeout` delays immediately, so a larger value fails validation instead. The scaled run
timeout (section 6) is clamped to the same maximum.

**Runtime**

| Variable | Default | Required | Secret | Description |
|---|---|---|---|---|
| `NODE_ENV` | `development` | No | No | `development`, `test` or `production`. Validated; M1 code does not change behaviour on it. The test config sets `test`. |
| `STUDIO_API_HOST` | `0.0.0.0` | No | No | Interface the API listens on |
| `STUDIO_API_PORT` | `4100` | No | No | API port (0 to 65535). If you change it, change `STUDIO_API_URL` in the web app too. |
| `LOG_LEVEL` | `info` | No | No | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. API logs are pino JSON; authorization headers, cookies and API keys are redacted. The worker uses a JSON-lines logger that redacts secret-looking keys. |
| `CORS_ORIGINS` | `http://localhost:3000` | No | No | Comma-separated browser origins allowed by CORS. studio-web calls the API from its server, so this matters only for browser code that calls the API directly. |

**Database and queue**

| Variable | Default | Required | Secret | Description |
|---|---|---|---|---|
| `DATABASE_URL` | none | **Yes** | Yes (contains the password) | Postgres URL; must start with `postgres://` or `postgresql://`. `.env.example` sets `postgres://postgres:postgres@localhost:5432/video_studio`. Unlike the Prisma CLI, the app has no fallback. |
| `DATABASE_POOL_MAX` | `10` | No | No | Size of the `pg` pool of each process (integer, 1 to 1 000). The API and the worker have one pool each; the seed uses 2 connections. |
| `DATABASE_CONNECTION_TIMEOUT_MS` | `5000` | No | No | How long a query waits for a free pooled connection before it fails instead of hanging (100 or more). |
| `REDIS_URL` | `redis://localhost:6379` | No | Yes if it contains a password | `redis://` or `rediss://` URL. Used by the API (producer, readiness check) and the worker when `QUEUE_DRIVER=bullmq`. |
| `QUEUE_DRIVER` | `bullmq` | No | No | `bullmq`: the API enqueues to the Redis queue `studio-director` and the worker processes runs. `inline`: runs execute inside the API process, with no Redis and no worker (section 5). |
| `QUEUE_ENQUEUE_TIMEOUT_MS` | `3000` | No | No | Budget of one enqueue, queue job lookup (reaper) or Redis ping (`/ready`), 50 or more. An enqueue that cannot reach Redis in time fails: `POST .../director-runs` answers 503 `QUEUE_UNAVAILABLE` and the run is recorded `FAILED` without counting toward the daily run quota. |
| `DIRECTOR_JOB_LOCK_MS` | `300000` (5 min) | No | No | BullMQ job lock duration (30 000 or more). A worker that cannot renew its lock for this long (for example during a Redis outage) has its job counted as stalled; the run is then failed only if its heartbeat is stale too (section 5). BullMQ's own default is 30 s. Worker only. |

**AI provider**

| Variable | Default | Required | Secret | Description |
|---|---|---|---|---|
| `AI_PROVIDER` | `mock` | No | No | `mock`: deterministic heuristic director (model `mock-director-v1`), no network, no credits. `anthropic`: Claude through the Anthropic API. |
| `ANTHROPIC_API_KEY` | none | Only if `AI_PROVIDER=anthropic` | **Yes** | Startup fails without it when the provider is `anthropic`. Never logged and never returned by `/v1/system/config`. Ignored by the mock. |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | No | No | Model id (1 to 128 characters). Costs are estimated only for models in the pricing table (section 4.3). |
| `ANTHROPIC_EFFORT` | `medium` | No | No | `low`, `medium`, `high`, `xhigh` or `max`, sent as `output_config.effort`. Thinking cannot be turned off for this model; effort is the control. Higher effort means more (billed) thinking tokens and more latency. |
| `ANTHROPIC_MAX_OUTPUT_TOKENS` | `16000` | No | No | Per-request output cap, 256 to 16 000. Each stage also caps its own request; the smaller value wins. The director chunks long videos so outputs stay small. |
| `ANTHROPIC_FALLBACKS` | `default` | No | No | `default` turns on server-side refusal fallbacks (beta `server-side-fallback-2026-07-01`, `fallbacks: "default"`). `off` disables them; a refusal then fails the run with `PROVIDER_REFUSAL`. The model that actually served each call is recorded in `usage.stages[].model`. |
| `ANTHROPIC_STRUCTURED_OUTPUT` | `json_schema` | No | No | `json_schema`: structured outputs through `output_config.format` (recommended). If the API rejects a schema, the provider retries that call once in prompt mode. `prompt`: the JSON schema is embedded in the prompt. |

**AI Director**

| Variable | Default | Required | Secret | Description |
|---|---|---|---|---|
| `DIRECTOR_MAX_REPAIR_ATTEMPTS` | `2` | No | No | Extra attempts per stage call when the output fails Zod or semantic validation (integer, 0 or more). After the last attempt the run fails with `VALIDATION_FAILED`. |
| `DIRECTOR_RUN_TIMEOUT_MS` | `1800000` (30 min) | No | No | Minimum wall-clock budget for one run (integer, 1 or more). The effective timeout scales with the plan (section 6). Exceeded runs fail with `TIMEOUT`. |
| `DIRECTOR_STEP_TIMEOUT_MS` | `120000` (2 min) | No | No | Per-step budget used for that scaling (integer, 0 or more). `0` disables scaling. |
| `DIRECTOR_CACHE` | `on` | No | No | `on`: validated stage outputs are cached in Postgres (`director_cache_entries`), per user, so an identical re-run costs 0 tokens. The key covers the rendered prompt, a hash of the structured stage input and the provider settings ([AI_DIRECTOR.md section 12](AI_DIRECTOR.md#12-caching)). `off`: no cache reads or writes. |
| `DIRECTOR_PRICING_JSON` | unset | No | No | JSON object merged over the built-in pricing table, in USD per million tokens. Each entry needs exactly `inputPerMTok`, `outputPerMTok`, `cacheReadPerMTok` and `cacheWritePerMTok` (numbers, 0 or more). Example: `{"claude-opus-5-5":{"inputPerMTok":4,"outputPerMTok":20,"cacheReadPerMTok":0.2,"cacheWritePerMTok":5}}`. The run cost ceilings (section 4.4) use the same merged table. |
| `DIRECTOR_WORKER_CONCURRENCY` | `2` | No | No | Parallel director runs per worker process (integer above 0). Worker only. |
| `DIRECTOR_HEARTBEAT_STALE_MS` | `60000` (1 min) | No | No | A `RUNNING` run writes a heartbeat about every 2 s. The reaper fails a `RUNNING` run whose heartbeat is older than this with `WORKER_LOST` (5 000 or more; section 5). |
| `DIRECTOR_QUEUED_STALE_MS` | `600000` (10 min) | No | No | The reaper fails a `QUEUED` run older than this whose queue job is missing, failed or completed with `QUEUE_LOST` (10 000 or more). It never re-queues. |
| `DIRECTOR_REAPER_INTERVAL_MS` | `30000` | No | No | How often the stale-run reaper runs: in the worker, and in the API process with `QUEUE_DRIVER=inline`. `0` disables it; otherwise at least 1 000. |

**Resource limits** (all positive integers; [ADR-016](DECISIONS.md#adr-016-configurable-resource-limits-instead-of-hardcoded-duration-caps))

| Variable | Default | Required | Secret | Description |
|---|---|---|---|---|
| `LIMIT_MAX_DURATION_SECONDS` | `7200` | No | No | Longest video a request may ask for |
| `LIMIT_MAX_WIDTH` | `3840` | No | No | Maximum output width in pixels |
| `LIMIT_MAX_HEIGHT` | `3840` | No | No | Maximum output height in pixels |
| `LIMIT_MAX_FPS` | `60` | No | No | Maximum frame rate |
| `LIMIT_MAX_SCENES` | `2000` | No | No | Maximum scenes in a compiled timeline |
| `LIMIT_MAX_CHAPTERS` | `200` | No | No | Maximum chapters in a plan or timeline |
| `LIMIT_MAX_TRACKS` | `50` | No | No | Maximum tracks in a timeline |
| `LIMIT_MAX_ASSETS` | `500` | No | No | Maximum assets in a timeline, and reference assets in a request |
| `LIMIT_MAX_PROMPT_CHARS` | `20000` | No | No | Maximum prompt length (request prompt and generated-scene prompts) |

Limits are checked when a project is created (422 `LIMIT_EXCEEDED`), when a run starts planning, and after compilation. Lowering
a limit below an existing project's request makes that project's next run fail with `LIMIT_EXCEEDED`.

**Quotas, rate limiting and caching**

| Variable | Default | Required | Secret | Description |
|---|---|---|---|---|
| `LIMIT_DIRECTOR_RUNS_PER_DAY` | `50` | No | No | Director runs a user may start per UTC day (integer, 0 or more). Runs of every status count, including runs of deleted projects, except runs that failed before they started because the queue was unavailable or lost them (`QUEUE_UNAVAILABLE`, `QUEUE_LOST`). `0` blocks all runs. |
| `LIMIT_DIRECTOR_USD_PER_DAY` | `25` | No | No | Estimated spend per user per UTC day, in USD (number, 0 or more, decimals allowed). A start is refused when today's spend plus the unspent cost ceilings reserved by the user's active runs plus this run's cost ceiling would exceed it, and a running run is stopped once today's actual spend reaches it (section 4.4). `0` blocks all runs, mock runs included. |
| `LIMIT_ACTIVE_RUNS_PER_USER` | `2` | No | No | Queued plus running director runs per user, across all projects (integer above 0). Beyond it a start returns 429 `QUOTA_EXCEEDED`. |
| `RATE_LIMIT_PER_MINUTE` | `300` | No | No | Requests per minute per authenticated user (integer above 0); all of a user's tokens share the budget. Checked after authentication. Exceeding it returns 429 `RATE_LIMITED` with `retry-after`. `/health` and `/ready` are exempt. |
| `RATE_LIMIT_UNAUTH_PER_MINUTE` | `60` | No | No | Failed authentications (missing, unknown or revoked token) per minute per client IP (IPv6 grouped per /64). Checked before authentication: once an IP is over it, every `/v1` request from that IP gets 429 `RATE_LIMITED` without a token lookup until the window resets. Successful requests do not consume this budget. |
| `VERSION_CACHE_MAX_BYTES` | `67108864` (64 MiB) | No | No | Size budget (UTF-16 code units of JSON text) of the in-process LRU cache of serialized `ProjectVersionDTO`s. Versions are immutable, so each one is loaded and validated once per process. `0` disables the cache. API only. |

**Development seed**

| Variable | Default | Required | Secret | Description |
|---|---|---|---|---|
| `STUDIO_DEV_USER_EMAIL` | `dev@localhost` | No | No | Email of the user the seed script upserts (loose `x@y` check, up to 320 characters) |
| `STUDIO_DEV_API_TOKEN` | none | Only for `pnpm studio:db:seed` | **Yes** | Raw development bearer token, at least 32 characters (`openssl rand -hex 32` gives 64). Read only by the seed script, which stores its sha256 hash. If set, it must still be 32 characters or more, otherwise the API and worker refuse to start. |

### 3.3 studio-web (`apps/studio-web/.env.local`)

| Variable | Default | Required | Secret | Description |
|---|---|---|---|---|
| `STUDIO_API_URL` | `http://localhost:4100` | No | No | Base URL of studio-api; `http` or `https`, trailing slashes removed. Read on the server only. |
| `STUDIO_API_TOKEN` | none | **Yes** for every page except the health check | **Yes** | Bearer token the web server sends to the API; in development, the `STUDIO_DEV_API_TOKEN` value. Without it pages show a "not configured" state (`CONFIG_MISSING_TOKEN`). |

Fixed in code, not configurable: the web app's API request timeout (15 s), its port (3000) and its bind address
(`127.0.0.1`), both set in the `dev` and `start` scripts. The browser never talks to studio-api; it only calls same-origin
route handlers that proxy server-side, so the token never reaches it:

| Route | Used by | Behaviour |
|---|---|---|
| `GET /api/runs/:runId` | Run panel polling | A slim run (usage totals only), generic error messages. 400 invalid id, 404 not found, 503 when the web app is not configured or its token is rejected, 502 when the API is unreachable. |
| `GET /api/projects/:id/versions/:v/timeline` | Preview and Timeline JSON tabs (loaded lazily) | The version's timeline, validated against `TimelineSchema` on the server and again in the browser; gzipped above 16 KB when the browser accepts it. |
| `GET /api/projects/:id/versions/:v/storyboard?chapter=&offset=&limit=` | Storyboard chapters (expanded lazily) | One page of a chapter's storyboard cards, `limit` at most 200 (default 60). |

Polling (`src/lib/run-polling.ts`): every 1.5 s while a run is queued or running, every 5 s after 2 minutes, paused while the
tab is hidden. 400, 401, 403, 404 and 503 stop polling at once with Reload / Try again; other failures back off 3, 6, 12, 24
and 30 s and polling stops after 6 consecutive failures. When polling stops, the page re-syncs from the server. Parsed versions
are cached in the web server (3 entries, 5-minute TTL, keyed by a fingerprint of the token, dropped when the project is
deleted).

M1 studio-web acts as the single user whose token it holds. Do not expose it publicly without an authenticating proxy in front of
it ([PRD 7.3](PRD.md#73-security)).

### 3.4 Test-only variables

| Variable | Default | Description |
|---|---|---|
| `TEST_DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/video_studio_test` | Database used by the studio-api tests (`vitest.config.ts`, `test/global-setup.ts`, `test/helpers.ts`). The database name must end in `_test`, or the global setup refuses to run (`Refusing to run tests against non-test database`), because tests truncate every table. |

The test helpers build their own configuration (`QUEUE_DRIVER=inline`, `AI_PROVIDER=mock`, `LOG_LEVEL=silent`) and do not read
`apps/studio-api/.env`.

## 4. AI provider: mock or Claude

### 4.1 Without Claude credits (default)

`AI_PROVIDER=mock` is the default in both `config.ts` and `.env.example`. The heuristic mock provider (`mock`, model
`mock-director-v1`) runs the whole director pipeline offline: brief, outline, then script, storyboard, shot list, engine selection
and scene specs per chapter, and the deterministic compile into a Timeline v1. Its outputs pass the same validation as Claude's.
It reports synthetic token counts so the Usage tab has data, but `mock-director-v1` is priced at $0, so estimated cost stays $0
and the run's cost ceiling is $0. Mock runs still count toward `LIMIT_DIRECTOR_RUNS_PER_DAY` and `LIMIT_ACTIVE_RUNS_PER_USER`.
The mock writes English text whatever the request's `language`; only Claude follows the language tag.

`GET /v1/system/config` (and the Settings page) reports
`aiProvider: {"name":"mock","model":"mock-director-v1","mode":"mock","configured":true}`.

### 4.2 With Claude

In `apps/studio-api/.env`:

```bash
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...        # your key; never commit it
# Optional, defaults shown:
ANTHROPIC_MODEL=claude-opus-5-5
ANTHROPIC_EFFORT=medium
ANTHROPIC_MAX_OUTPUT_TOKENS=16000
ANTHROPIC_FALLBACKS=default
ANTHROPIC_STRUCTURED_OUTPUT=json_schema
```

Restart the API and the worker, then check that the API reports the live provider:

```bash
curl -s http://localhost:4100/v1/system/config -H "Authorization: Bearer $TOKEN" | jq .aiProvider
# {"name":"anthropic","model":"claude-opus-5-5","mode":"live","configured":true}
```

How the provider calls Claude (`packages/ai-director/src/providers/anthropic.ts`):

- Every call sends an explicit `output_config.effort` and, in `json_schema` mode, a structured-output schema. It never sends
  `thinking`, `temperature`, `top_p`, `top_k` or an assistant prefill.
- System prompts are stable and sent with `cache_control`, so Anthropic prompt caching applies. Cache reads and writes are tracked
  as separate token counts.
- The SDK uses a 10-minute timeout per request and retries rate limits, overload and 5xx errors twice. Neither is configurable by
  env.
- Failures map onto run error codes: `PROVIDER_CONFIG` (missing or invalid key, permissions), `PROVIDER_UNAVAILABLE` (rate limits,
  overload, connection problems), `PROVIDER_REQUEST` (rejected request), `PROVIDER_REFUSAL`, `PROVIDER_TRUNCATED` (output hit
  `max_tokens` on the last allowed attempt; earlier truncations are repaired) and `VALIDATION_FAILED` (repairs exhausted).
- Switching between `mock` and `anthropic`, or changing the model, effort, `ANTHROPIC_MAX_OUTPUT_TOKENS`, fallbacks or
  structured-output mode, never reuses cached outputs: the provider name, model, prompt version and the provider's
  configuration fingerprint are part of the cache key.
- If the API rejects a structured-output schema, the provider retries that call once in prompt mode and remembers the
  rejection for that model and schema for the rest of the process, so later calls go straight to prompt mode.

Suggested first live run: a 30-second video (one chapter: 7 LLM calls), effort `low` or `medium`, and a small daily budget such
as `LIMIT_DIRECTOR_USD_PER_DAY=5`. The budget must cover the run's cost ceiling, not only its expected cost: a one-chapter run
on `claude-opus-5-5` reserves $2.32, so a limit of $2 refuses it (section 4.4). [PRD section 7.4](PRD.md#74-cost-controls) has
illustrative cost arithmetic.

### 4.3 Seeing what a run cost

| Where | What it shows |
|---|---|
| Project page, **Usage** tab | Totals (calls, cached calls, input, output, cache read and write tokens, estimated cost) and a per-stage table (stage, chunk, attempts, cached, tokens, cost; 100 rows per page) for the selected version's run, plus the latest 20 runs of the project |
| Dashboard | Runs and estimated cost today (UTC), tokens this month |
| `GET /v1/usage` | `{today, month}`, each with `runs`, the four token counts and `estimatedCostUsd`, for the calling user |
| `GET /v1/director-runs/:runId` | The run's `usage` report (`stages[]` and `totals`) |

While a run is `RUNNING`, its token and cost columns are updated with every progress write (the tokens of every provider
request so far, refused and truncated attempts included, each priced at the model that served it). When the run ends, the full
per-stage `usage` report is written, also for runs that failed, timed out, were stopped by the spend limit, were shut down or
were cancelled while running. A run ended by a worker crash (`WORKER_LOST`, section 5) keeps the token and cost columns of its
last progress write, but has no per-stage report. Usage is attributed to the UTC day and month in which the run was
created. Deleting a project keeps its runs, so usage totals and quotas do not drop. Costs are estimates from the pricing table
in `packages/ai-director/src/pricing.ts` (USD per million tokens; for `claude-opus-5-5`: input 4.00, output 20.00, cache read
0.20, cache write 5.00). A model missing from the table, for example a fallback model, is counted as $0 with
`pricingKnown: false`, and the Usage tab flags it. Add it with `DIRECTOR_PRICING_JSON`.

### 4.4 Quotas

`POST /v1/projects/:id/director-runs` checks the calling user's quotas in one transaction, after taking a per-user advisory lock
(`pg_advisory_xact_lock`), so concurrent starts by the same user, on any of their projects, are serialized and cannot race the
checks. In order, it answers 429 `QUOTA_EXCEEDED` when:

1. the user already has `LIMIT_ACTIVE_RUNS_PER_USER` (default 2) runs `QUEUED` or `RUNNING`, on any project;
2. the user started `LIMIT_DIRECTOR_RUNS_PER_DAY` (default 50) runs today (UTC), not counting runs that never started
   (`QUEUE_UNAVAILABLE`, `QUEUE_LOST`);
3. today's committed spend has already reached `LIMIT_DIRECTOR_USD_PER_DAY` (default 25);
4. today's committed spend plus this run's **cost ceiling** would exceed `LIMIT_DIRECTOR_USD_PER_DAY`.

"Committed spend" is today's estimated spend plus, for each of the user's active runs created today, the part of its
reservation it has not spent yet (`max(0, reservedCostUsd − estimatedCostUsd)`). The run that starts stores its own ceiling in
`DirectorRun.reservedCostUsd`. The ceiling is computed before the run by `estimateRunCostCeilingUsd` (`@vc/ai-director`) from the
plan's chapter count, the configured model and the merged pricing table: every stage call is assumed to produce its full
`max_tokens` (capped by `ANTHROPIC_MAX_OUTPUT_TOKENS`) plus a generous input budget priced at the higher of the input and
cache-write rates. Repairs are not included.

```text
ceiling = Σ over LLM stages of  calls(stage) × (maxOutput(stage) × outputPrice + inputBudget(stage) × max(inputPrice, cacheWritePrice)) / 1 000 000
calls   = 1 for brief and outline, chapterCount for script, storyboard, shotList, engineSelection and sceneSpecs
maxOutput   = min(ANTHROPIC_MAX_OUTPUT_TOKENS, 8 000 | 12 000 | 16 000 | 16 000 | 16 000 | 12 000 | 16 000)   (brief … sceneSpecs)
inputBudget = 8 000 | 8 000 | 8 000 | 12 000 | 12 000 | 12 000 | 20 000                                      (brief … sceneSpecs)
```

On `claude-opus-5-5` with the defaults this is **$0.48 + $1.84 × chapterCount**:

| Request | Chapters | Cost ceiling | Starts with the default $25/day? |
|---|---|---|---|
| Any video up to 120 s | 1 | $2.32 | Yes |
| 10 min `explainer` | 4 | $7.84 | Yes |
| 25 min `explainer` | 9 | $17.04 | Yes, while at most $7.96 is already committed today |
| 1 h `long-form` | 13 | $24.40 | Only while at most $0.60 is already committed today |
| 2 h `long-form` | 25 | $46.48 | **No.** Refused before it starts; raise `LIMIT_DIRECTOR_USD_PER_DAY` to at least 46.48 |
| 2 h `social-short` | 84 | $155.04 | **No** |

With $25 per day, 13 chapters is the most a single `claude-opus-5-5` run can have. The longest durations that fit are about
62 minutes of `long-form`, 52 minutes of `presentation` or `corporate-training`, 36 minutes of `explainer` and 13 minutes of
`social-short` (computed with `planStructure` and `estimateRunCostCeilingUsd`). The mock provider and models without pricing
have a ceiling of $0; Sonnet 5.5 costs half of Opus 5.5 ($0.24 + $0.92 per chapter).

While the run is `RUNNING`, the worker checks the spend before every LLM stage: when today's spend of the user's other runs plus
this run's live spend reaches `LIMIT_DIRECTOR_USD_PER_DAY`, it aborts the run and records `FAILED` with code `QUOTA_EXCEEDED`
(partial usage kept). Compile makes no provider call, so a finished plan is never discarded. Repairs can make a run cost more
than its ceiling; the live check bounds that.

`details` of the 429 response:
`{runsToday, runsPerDayLimit, activeRuns, activeRunsLimit, estimatedCostTodayUsd, reservedCostUsd, runCostCeilingUsd, usdPerDayLimit}`,
and the message names the ceiling, the chapter count and the model. To reset during development, raise the limits and restart
the API and the worker, or wait for the next UTC day.

## 5. Queue drivers and the worker

| | `QUEUE_DRIVER=bullmq` (default) | `QUEUE_DRIVER=inline` |
|---|---|---|
| Where runs execute | A separate worker process (`pnpm studio:dev:worker`) | Inside the API process |
| Needs Redis | Yes (API and worker) | No |
| Use for | Normal development; matches production | Single-process development without Redis |
| `GET /v1/system/config` | `"queueDriver":"bullmq"` | `"queueDriver":"inline"` (the API also logs a warning at startup) |

With `bullmq`, the API adds a job named `direct` with payload `{runId}` to the queue `studio-director`. The job id is the run id,
each job has one attempt, and BullMQ keeps the last 1 000 completed and 5 000 failed job records. The `DirectorRun` row in Postgres
is the source of truth: the worker claims a run only if it is still `QUEUED`, so duplicate deliveries do nothing. Jobs wait in
Redis until a worker is available, so a run started while no worker is running stays `QUEUED` ("Queued") and starts as soon as the
worker does. Start more worker processes, or raise `DIRECTOR_WORKER_CONCURRENCY`, to run more projects in parallel (each user is
still limited to `LIMIT_ACTIVE_RUNS_PER_USER` active runs).

The enqueue fails fast instead of waiting for Redis: the producer connection has no offline queue, and every enqueue is bounded
by `QUEUE_ENQUEUE_TIMEOUT_MS` (3 s). When it fails, the run is recorded `FAILED` with `QUEUE_UNAVAILABLE` (it does not count
toward the daily run quota), the project goes back to the status it had before the start, and the API answers 503
`QUEUE_UNAVAILABLE`. This holds whether Redis went down before or after the API started.

**Heartbeat and reaper.** A `RUNNING` run writes `heartbeatAt` about every 2 s (the same write notices a cancellation), and its
token and cost columns are updated with each progress write. The stale-run reaper runs every `DIRECTOR_REAPER_INTERVAL_MS`
(30 s) in the worker, and in the API process with `QUEUE_DRIVER=inline`. Each pass:

- fails `RUNNING` runs whose heartbeat is older than `DIRECTOR_HEARTBEAT_STALE_MS` (1 min) with `WORKER_LOST` ("The director
  worker stopped responding while processing this run; start it again (completed stages are cached)"), keeps the usage written
  with progress, and restores the project status;
- fails `QUEUED` runs older than `DIRECTOR_QUEUED_STALE_MS` (10 min) whose queue job is missing, failed or completed with
  `QUEUE_LOST`. Runs whose job is still waiting or active are left alone, and so are runs whose job state cannot be read
  (Redis down); a later pass retries them.

Runs are never re-queued: a re-queue during a crash or restart loop could run, and bill, the same request repeatedly. Every
transition is a conditional update, so any number of workers and reapers can run side by side, and a late worker cannot revive
a reaped run.

**Worker crash.** If a worker process dies mid-run (crash, `kill -9`, closed terminal), its runs stop heart-beating. About one
minute later (`DIRECTOR_HEARTBEAT_STALE_MS` plus up to one reaper interval) any running worker or inline API marks them
`FAILED` with `WORKER_LOST`; this no longer needs the dead worker to come back. Independently, BullMQ counts the job as stalled
once its lock (`DIRECTOR_JOB_LOCK_MS`, 5 min) expires and fails it instead of re-running it (`maxStalledCount: 0`). The worker's
failed-job handler then marks the run `FAILED` with `INTERNAL` ("The director worker stopped unexpectedly while processing this
run") only if no process is still working on it: not this process, and no heartbeat fresher than `DIRECTOR_HEARTBEAT_STALE_MS`.
Re-run the project; completed stages come from the cache.

**Shutdown.** On SIGINT or SIGTERM the worker stops taking jobs, aborts its in-flight runs and records them `FAILED` with code
`SHUTDOWN` (partial usage kept, project status restored), then exits. A job delivered while shutting down is recorded `SHUTDOWN`
without starting. A second signal exits immediately. The API does the same for inline runs on shutdown and forces an exit after
90 s.

With `inline`, restarting the API (for example when `tsx watch` reloads after a file change) ends the runs of that process. A
clean shutdown (SIGINT or SIGTERM) records them `SHUTDOWN`. If the process is killed instead, a run that was `RUNNING` is reaped
as `WORKER_LOST` about a minute after the API is back, and a `QUEUED` run as `QUEUE_LOST` after 10 minutes (the inline queue only
knows the jobs of its own process). You can also cancel such a run right away from the project page or with
`POST /v1/director-runs/:runId/cancel`.

## 6. Timeouts

Each run gets a wall-clock budget, computed by `effectiveRunTimeoutMs` in `apps/studio-api/src/config.ts`:

```text
timeout = min(2 147 483 647, max(DIRECTOR_RUN_TIMEOUT_MS, steps × DIRECTOR_STEP_TIMEOUT_MS))
steps   = 2 + 5 × chapters + 1        (brief, outline, 5 stages per chapter, compile)
```

The chapter count depends on genre and duration. Effective timeouts with the defaults (30 min minimum, 2 min per step), from
`planStructure` in `@vc/ai-director`:

| Request | Chapters | Steps | Effective timeout |
|---|---|---|---|
| Any genre, up to 60 s | 1 | 8 | 30 min (the minimum) |
| 10 min `explainer` | 4 | 23 | 46 min |
| 10 min `cinematic-ad` | 9 | 48 | 96 min |
| 25 min `explainer` | 9 | 48 | 96 min |
| 2 h `long-form` | 25 | 128 | 256 min (about 4.3 h) |
| 2 h `cinematic-ad`, `promo` or `social-short` | 84 | 423 | 846 min (about 14.1 h) |

More example plans: [AI_DIRECTOR.md section 6.2](AI_DIRECTOR.md#62-example-plans-including-long-videos).

When the budget runs out, the worker aborts the in-flight provider call and marks the run `FAILED` with code `TIMEOUT` and the
message `Director run exceeded its timeout of <n> ms`. Usage up to that point is recorded, and cached chapters make a re-run
cheaper. With the mock provider, runs finish in seconds and never come near the budget.

Tuning:

- Live latency per call has not been measured yet ([ROADMAP known gaps](ROADMAP.md#known-gaps-carried-out-of-m1)). Two
  minutes per step is a starting budget for effort `medium`. Raise `DIRECTOR_STEP_TIMEOUT_MS` for `high`, `xhigh` or `max`
  effort, a slow network, or if live runs fail with `TIMEOUT`.
- Set `DIRECTOR_STEP_TIMEOUT_MS=0` to use `DIRECTOR_RUN_TIMEOUT_MS` as a fixed budget for every run.
- The timeout runs inside the worker. If the worker process dies, the timeout dies with it; the reaper then fails the run with
  `WORKER_LOST` once its heartbeat is stale (section 5).
- The timeout bounds wall-clock time, not spend. Spend is bounded by `LIMIT_DIRECTOR_USD_PER_DAY` (section 4.4). Chapters run
  sequentially, so a live multi-hour plan takes hours: at an assumed 30 s per call, a 2 h `long-form` plan (127 calls) needs
  more than an hour.

## 7. Testing

```bash
pnpm test                                   # every package with a test script
pnpm --filter @vc/schema test               # one package
pnpm --filter @vc/ai-director test
pnpm --filter @vc/studio-api test
pnpm --filter @vc/studio-web test
pnpm --filter @vc/ai-director test pricing  # files whose path matches "pricing"
pnpm --filter @vc/studio-api test projects
```

`pnpm test` runs `vitest run` in `@vc/schema`, `@vc/ai-director`, `@vc/studio-api`, `@vc/studio-web` and `@vc/core` (campaigns
helpers).

- **AI is mocked.** No test calls the network or spends credits. The director tests use the heuristic and scripted mock providers,
  and the API tests build the app with the mock provider and the inline queue. The live Anthropic provider is covered only by unit
  tests with a stubbed client.
- **studio-api tests need Postgres** and the `video_studio_test` database (or `TEST_DATABASE_URL`). The vitest global setup runs
  `prisma migrate deploy` against it, so no manual migration is needed. Tables are truncated between tests, and test files run one
  at a time. Redis is not needed. Do not run two studio-api test processes against the same test database at once.
- The other packages need no database.

**CI** (`.github/workflows/ci.yml`) runs on every push and pull request, on `ubuntu-latest` with Postgres 16 (database
`video_studio_test`) and Redis 7 service containers and `AI_PROVIDER=mock`:

```bash
pnpm install --frozen-lockfile
pnpm --filter @vc/studio-api db:generate
pnpm typecheck
pnpm test
pnpm build
```

Running the same sequence locally reproduces CI.

## 8. Typecheck and build

```bash
pnpm typecheck     # tsc in every package, campaigns apps included (needs the generated Prisma client)
pnpm build         # next build (studio-web) and vite build (campaigns panel, apps/web)
```

studio-api and the packages have no build step: they run from TypeScript source through `tsx`, and packages are consumed as
source. To run production-style locally, provide the environment yourself, since `start` does not load `.env`:

```bash
set -a; . apps/studio-api/.env; set +a      # export the API variables into this shell
pnpm --filter @vc/studio-api start          # API without watch mode
pnpm --filter @vc/studio-api start:worker   # worker without watch mode
pnpm --filter @vc/studio-web build && pnpm --filter @vc/studio-web start
```

Sourcing the file with the shell strips unquoted double quotes, so wrap JSON values such as `DIRECTOR_PRICING_JSON` in single
quotes in `.env`. Node's env-file loader, used by the `dev` scripts, accepts the quoted form too.

**Remotion license.** studio-web uses the Remotion Player (`@remotion/player` 4.0.534) for the animatic. Remotion is free for
individuals and for companies with up to 3 employees; larger companies need a Remotion company license. The `<Player>` is
rendered **without** the `acknowledgeRemotionLicense` prop on purpose: setting it is the owner's licensing decision, so the Player
may log Remotion's license notice in the browser console until that decision is made. The same terms apply to the campaigns
worker and to the M2 renderer.

## 9. API quick reference

Every `/v1/*` route requires `Authorization: Bearer <token>`. Errors use one envelope:
`{"error": {"code": "...", "message": "...", "details": ...}}`.

| Method | Path | Success | Common errors |
|---|---|---|---|
| GET | `/health` | 200 `{ok: true, version}`: liveness, no I/O (public, not rate limited) | — |
| GET | `/ready` | 200 `{ok, checks: {database, queue}}`, each `ok`, `error` or `skipped` (queue is `skipped` with `inline`); 503 when a check fails. Public, not rate limited, results reused for 1 s, no error details. | 503 |
| GET | `/v1/me` | 200 `{id, email, name}` | 401 `UNAUTHORIZED` |
| GET | `/v1/system/config` | 200 provider, queue driver, limits, engines, templates, prompt version (no secrets) | 401 |
| GET | `/v1/usage` | 200 `{today, month}` | 401 |
| GET | `/v1/projects?limit=&cursor=` | 200 `{items, nextCursor, total}`, newest update first, `limit` 1 to 100 (default 20). `nextCursor` is an opaque string (base64url of the last row's `updatedAt` and `id`); `total` counts all of the user's projects. | 400 `INVALID_CURSOR` |
| POST | `/v1/projects` | 201 project detail | 400 `VALIDATION_ERROR`, 422 `LIMIT_EXCEEDED` |
| GET | `/v1/projects/:id` | 200 project detail with `request` and `latestRun` | 404 `NOT_FOUND` |
| DELETE | `/v1/projects/:id` | 204 | 409 `RUN_ACTIVE` |
| GET | `/v1/projects/:id/versions` | 200 the latest 100 version summaries, newest first (not paginated) | 404 |
| GET | `/v1/projects/:id/versions/:version` | 200 version with `timeline` and `artifacts`, with a strong `ETag` and `Cache-Control: private, max-age=31536000, immutable`; 304 for a matching `If-None-Match` | 404 |
| POST | `/v1/projects/:id/director-runs` | 202 run (`queued`) | 409 `RUN_ACTIVE`, 429 `QUOTA_EXCEEDED`, 503 `QUEUE_UNAVAILABLE` |
| GET | `/v1/projects/:id/director-runs` | 200 latest 20 runs | 404 |
| GET | `/v1/director-runs/:runId` | 200 run | 404 |
| POST | `/v1/director-runs/:runId/cancel` | 200 run (`cancelled`) | 409 `RUN_NOT_ACTIVE` |

Any `/v1` route can also return 429 `RATE_LIMITED` (per user after authentication, or per IP after too many failed
authentications; section 3.2) and 500 `DATA_INTEGRITY` when a stored row fails validation on read (generic message; the details
go to the server log). The original contract is in
[M1 spec section 3](milestones/M1_IMPLEMENTATION_SPEC.md#3-vcstudio-api-appsstudio-api--contract); its
[amendments](milestones/M1_IMPLEMENTATION_SPEC.md#amendments-after-review-2026-10-09) list where the API now differs.

The examples use `curl` and `jq`:

```bash
export API=http://localhost:4100
export TOKEN=$(sed -n 's/^STUDIO_DEV_API_TOKEN=//p' apps/studio-api/.env)

# Health (public) and the current user
curl -s "$API/health"
curl -s "$API/v1/me" -H "Authorization: Bearer $TOKEN"

# Create a project (fields of VideoRequest; fps defaults to 30, language to "en")
PROJECT_ID=$(curl -s -X POST "$API/v1/projects" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "title": "Launch teaser",
    "prompt": "A 30 second promo for a solar-powered backpack that charges your phone on the go.",
    "genre": "promo",
    "styleNotes": "Bold, energetic, outdoorsy",
    "durationSeconds": 30,
    "aspectRatio": "16:9",
    "resolution": "1080p",
    "brand": { "name": "SunPack", "colors": ["#FF7A00", "#1B1B1B"] },
    "voiceOver": { "enabled": true, "style": "upbeat", "gender": "female" },
    "music": { "enabled": true, "mood": "energetic" }
  }' | jq -r .id)
echo "$PROJECT_ID"

# Start a director run (202; the body is optional)
RUN_ID=$(curl -s -X POST "$API/v1/projects/$PROJECT_ID/director-runs" \
  -H "Authorization: Bearer $TOKEN" | jq -r .id)

# Poll until the run is finished
while :; do
  STATUS=$(curl -s "$API/v1/director-runs/$RUN_ID" -H "Authorization: Bearer $TOKEN" | jq -r .status)
  echo "$STATUS"
  case "$STATUS" in succeeded|failed|cancelled) break ;; esac
  sleep 2
done
curl -s "$API/v1/director-runs/$RUN_ID" -H "Authorization: Bearer $TOKEN" \
  | jq '{status, versionNumber, progress, error, totals: .usage.totals}'

# Readiness (public): database and Redis
curl -s "$API/ready"

# Versions: list, then fetch one (timeline + artifacts); the version JSON is immutable (ETag, 304 on If-None-Match)
curl -s "$API/v1/projects/$PROJECT_ID/versions" -H "Authorization: Bearer $TOKEN"
curl -s -D - -o /dev/null "$API/v1/projects/$PROJECT_ID/versions/1" -H "Authorization: Bearer $TOKEN" | grep -i -E '^(etag|cache-control):'
curl -s "$API/v1/projects/$PROJECT_ID/versions/1" -H "Authorization: Bearer $TOKEN" \
  | jq '{version, sceneCount, durationInFrames, fps, artifacts: (.artifacts | keys)}'
curl -s "$API/v1/projects/$PROJECT_ID/versions/1" -H "Authorization: Bearer $TOKEN" | jq .timeline > timeline.json

# Usage, cancel, delete
curl -s "$API/v1/usage" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "$API/v1/director-runs/$RUN_ID/cancel" -H "Authorization: Bearer $TOKEN"   # 409 once finished
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "$API/v1/projects/$PROJECT_ID" -H "Authorization: Bearer $TOKEN"
```

With the mock provider, the finished run of this example looks like this (ids and token counts vary):

```json
{
  "status": "succeeded",
  "versionNumber": 1,
  "progress": { "completedSteps": 8, "totalSteps": 8, "currentStage": "compile", "message": "Timeline ready" },
  "error": null,
  "totals": { "inputTokens": 27195, "outputTokens": 3704, "cacheReadTokens": 0, "cacheWriteTokens": 0,
              "estimatedCostUsd": 0, "calls": 7, "cachedCalls": 0 }
}
```

Version 1 then has 9 scenes, `durationInFrames` 900 at 30 fps, and the artifacts `brief`, `outline`, `script`, `storyboard`,
`shotList`, `engineSelection` and `sceneSpecs`. Re-running the same project is served from the stage cache: every stage has
`cached: true`, `totals.calls` (provider requests made) is 0, `totals.cachedCalls` is 7, and the run uses 0 tokens.

## 10. Database tasks

[DATABASE.md section 7](DATABASE.md#7-migration-workflow) covers creating migrations, applying them, the test database and
resetting local data. The commands used most:

```bash
pnpm studio:db:migrate                                                          # apply pending migrations (video_studio)
pnpm --filter @vc/studio-api exec prisma migrate status                         # what is applied
pnpm --filter @vc/studio-api exec prisma migrate dev --name <change>            # new migration after editing schema.prisma
pnpm --filter @vc/studio-api exec prisma migrate reset && pnpm studio:db:seed   # wipe local data, re-seed
psql postgres://postgres:postgres@localhost:5432/video_studio -c 'SELECT id, status, error_code FROM director_runs ORDER BY created_at DESC LIMIT 5'
```

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| studio-api or the worker fails with an import error for `src/generated/prisma`, or `pnpm typecheck` reports it missing | The Prisma client was not generated (an install that skipped lifecycle scripts, or a schema change since the last install) | `pnpm --filter @vc/studio-api db:generate` |
| `Invalid studio-api configuration:` followed by variable names | A variable is missing or invalid. `DATABASE_URL is required` usually means `.env` was not loaded: no `apps/studio-api/.env`, or a `start` script, which does not load it. | Fix the named variables (section 3.2). The message never prints values. |
| `ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic` | Live provider selected without a key | Set the key, or go back to `AI_PROVIDER=mock` |
| An error that database `video_studio` (or `video_studio_test`) does not exist, from the API, the seed, the tests or `prisma migrate` | The `pgdata` volume predates `docker/postgres/init-databases.sql`, or a local Postgres without the studio databases | Create the databases (section 2.2), then `pnpm studio:db:migrate` |
| studio-api tests fail to start: `Refusing to run tests against non-test database` | `TEST_DATABASE_URL` names a database that does not end in `_test` | Point it at `video_studio_test` |
| Connection refused on 5432 or 6379 | Postgres or Redis is not running, or another server holds the port | `docker compose up -d` and `docker compose ps`; stop a conflicting local server |
| Starting a run returns 503 `QUEUE_UNAVAILABLE` | `QUEUE_DRIVER=bullmq` and Redis did not answer within `QUEUE_ENQUEUE_TIMEOUT_MS` (3 s), whether it went down before or after the API started. The API fails the run (`QUEUE_UNAVAILABLE`, not counted toward the daily run quota), and the project goes back to the status it had before the start. `GET /ready` reports `"queue":"error"`. | Start Redis, then re-run. Or use `QUEUE_DRIVER=inline` for Redis-free development. |
| Run stays `queued` ("Queued") | `QUEUE_DRIVER=bullmq` and no worker is running | `pnpm studio:dev:worker`. The job waits in Redis and starts when the worker does. If the job itself was lost (Redis flushed), the reaper fails the run with `QUEUE_LOST` 10 minutes after it was created (`DIRECTOR_QUEUED_STALE_MS`), once a worker runs. |
| Run stays `running` and the project is blocked with 409 `RUN_ACTIVE` | The worker (or, with `inline`, the API) stopped mid-run without a clean shutdown | Start the worker (or the API with `inline`) again: the reaper fails the run with `WORKER_LOST` about a minute after its last heartbeat (section 5). Or cancel it right away (project page or `POST /v1/director-runs/:runId/cancel`), then re-run. |
| Run fails with `WORKER_LOST`, `QUEUE_LOST` or `SHUTDOWN` | The worker died mid-run, the queue lost the job, or the worker was stopped while the run was in flight (section 5) | Re-run. Completed stages come from the cache. |
| `GET /v1/projects/:id/versions` (or the project page) answers 500 `INTERNAL`, and the API log says a column such as `project_versions.scene_count` does not exist | The database is behind the code: a migration was not applied | `pnpm studio:db:migrate`, then restart the API and the worker |
| 500 `DATA_INTEGRITY` | A stored row (project request, version timeline or artifacts) fails validation on read. The response is generic; the API log names the entity, id and issues. | Inspect the row named in the log. Usually it was edited by hand or written by incompatible code. |
| 401 `UNAUTHORIZED` from the API, or the web app says its credentials were rejected | Missing header, a token that was never seeded, a token seeded into a different database than the API uses, or a revoked token (re-seeding never re-activates a revoked token; the seed prints a `WARNING:`) | Make `STUDIO_API_TOKEN` (web) equal `STUDIO_DEV_API_TOKEN` (API), run `pnpm studio:db:seed` again (with a new token value if it warned), and restart the web dev server. Test with `curl -s -o /dev/null -w '%{http_code}\n' "$API/v1/me" -H "Authorization: Bearer $TOKEN"`. |
| `pnpm studio:db:seed` fails with `STUDIO_DEV_API_TOKEN: required by the seed script` | No token in `apps/studio-api/.env` | Generate one (section 2.3) and put the same value in `apps/studio-web/.env.local` |
| The dashboard shows "No projects yet" after a fresh clone | Projects are rows in your local database; nothing is stored in git | Create one with **New project**, or run `pnpm studio:db:seed:demo` for 4 sample projects |
| The Next.js dev badge shows "1 Issue": *attributes of the server rendered HTML didn't match* on `<html>` or `<body>` | A browser extension (Grammarly, ColorZilla, password managers, …) added attributes before React hydrated. `<html>` and `<body>` already ignore this; a mismatch reported deeper in the page is a real bug. | Check in a private window with extensions off. Dev-only: production builds don't show the badge. |
| Web pages say the API is not configured | `STUDIO_API_TOKEN` is empty, or `STUDIO_API_URL` is not an http(s) URL | Fix `apps/studio-web/.env.local` and restart `pnpm studio:dev:web`. The Settings page shows whether a token is configured. |
| Web pages say the API is unreachable | studio-api is not running, or `STUDIO_API_URL` points at the wrong port | Start `pnpm studio:dev:api`; check `curl -s http://localhost:4100/health` and `curl -s http://localhost:4100/ready` |
| The web app cannot be opened from another machine | studio-web binds `127.0.0.1` (section 2.5) | Intended. Put an authenticating proxy in front of it rather than binding it publicly. |
| 429 `QUOTA_EXCEEDED` when starting a run | Too many active runs (`LIMIT_ACTIVE_RUNS_PER_USER`), today's (UTC) runs reached `LIMIT_DIRECTOR_RUNS_PER_DAY`, or today's committed spend plus this run's cost ceiling would exceed `LIMIT_DIRECTOR_USD_PER_DAY` (section 4.4). Runs of deleted projects still count. | Wait for or cancel an active run; raise the limits in `apps/studio-api/.env` and restart the API and the worker; or wait for the next UTC day. `details` shows the counts, the reservation and the ceiling. A long video on a large model may need a higher USD limit (for example 50 for a 2 h `long-form` video on `claude-opus-5-5`). |
| Run fails with `QUOTA_EXCEEDED` | The running run was stopped because today's actual spend reached `LIMIT_DIRECTOR_USD_PER_DAY` | Raise the limit or wait for the next UTC day, then re-run; completed stages come from the cache |
| 429 `RATE_LIMITED` | More than `RATE_LIMIT_PER_MINUTE` requests per minute by one user, or more than `RATE_LIMIT_UNAUTH_PER_MINUTE` failed authentications per minute from one IP (then every `/v1` request from that IP is refused for the rest of the window) | Slow the client down, fix the token, or raise the limit. `retry-after` gives the seconds to wait. |
| 409 `RUN_ACTIVE` when starting a run or deleting a project | A run of that project is still `QUEUED` or `RUNNING` | Wait for it, or cancel it first |
| Run fails with `PROVIDER_CONFIG` | Invalid Anthropic key or missing permissions | Check `ANTHROPIC_API_KEY`; restart the API and the worker |
| Run fails with `PROVIDER_UNAVAILABLE` | Rate limit, overload or network problem after the SDK's retries | Re-run later. Completed stages come from the cache. |
| Run fails with `TIMEOUT` | The run exceeded its effective timeout (section 6) | Raise `DIRECTOR_STEP_TIMEOUT_MS` or `DIRECTOR_RUN_TIMEOUT_MS`, or lower the effort; re-run |
| Run fails with `VALIDATION_FAILED` | Model output kept failing validation after `DIRECTOR_MAX_REPAIR_ATTEMPTS` repairs | Re-run; raise the repair attempts; check `ANTHROPIC_STRUCTURED_OUTPUT=json_schema` |
| Changing `AI_PROVIDER` has no effect, or runs show one provider but behave like another | Only one of the API and the worker was restarted | Restart both (section 2.7) |

## 12. Campaigns MVP

The campaigns MVP (personalized WhatsApp videos) is a separate product in the same repository. It uses the **root** `.env`
(loaded by `packages/core/src/config.ts`), the `video_creation` database with raw SQL migrations in `db/migrations/`, and
`ADMIN_API_KEY` for auth. It shares no tables or env files with the studio. The campaigns worker needs FFmpeg. Full guide:
[CAMPAIGNS.md](CAMPAIGNS.md).

```bash
cp .env.example .env            # root .env: DATABASE_URL=.../video_creation, ADMIN_API_KEY, WhatsApp, S3, ElevenLabs
pnpm campaigns:db:migrate       # applies db/migrations/*.sql (tracked in schema_migrations)
pnpm campaigns:dev:api          # Express API on http://localhost:4000
pnpm campaigns:dev:worker       # Remotion + FFmpeg render worker and WhatsApp sender
pnpm campaigns:dev:web          # Vite panel on http://localhost:5173 (log in with ADMIN_API_KEY)
pnpm campaigns:studio           # optional: Remotion Studio for the campaign templates
```

Without `WHATSAPP_TOKEN`, sends run in dry-run mode.
