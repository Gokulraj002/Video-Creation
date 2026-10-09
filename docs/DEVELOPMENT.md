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
`apps/studio-api/src/generated/prisma` (gitignored). Generating needs no database: `apps/studio-api/prisma.config.ts` falls back
to the local `video_studio` URL. Regenerate by hand after a change to `prisma/schema.prisma`:

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
web app must use the same value:

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
and a new token value adds another row (older tokens stay valid). See [DATABASE.md](DATABASE.md#7-migration-workflow) for
schema changes, resets and the test database.

`studio:db:migrate` runs the Prisma CLI, which reads `DATABASE_URL` from the shell, not from `apps/studio-api/.env`. Without it,
the CLI uses `postgres://postgres:postgres@localhost:5432/video_studio`. The seed script does load `apps/studio-api/.env`.

### 2.5 Start the processes

Use three terminals:

```bash
pnpm studio:dev:api        # Fastify API on http://localhost:4100 (tsx watch)
pnpm studio:dev:worker     # BullMQ director worker (tsx watch)
pnpm studio:dev:web        # Next.js dev server on http://localhost:3000
```

The API logs `studio-api ready` with the provider, model and queue driver. The worker logs `studio-worker ready` with its queue
(`studio-director`), concurrency, provider, model and cache setting. Check the API:

```bash
curl -s http://localhost:4100/health      # {"ok":true,"version":"0.1.0"}
```

### 2.6 Open the studio

Open <http://localhost:3000>. The dashboard lists projects and shows today's runs and estimated cost. **New project** creates a
project and starts a director run right away. The project page shows the run's progress bar, then the tabs Storyboard, Preview
(animatic), Brief, Script, Shot list, Timeline JSON and Usage. **Settings** shows the AI provider, queue driver, limits, engine
availability and the template catalog as reported by the API, plus whether the web app has a token configured.

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
- Prisma CLI commands (`db:generate`, `db:migrate`, `db:migrate:dev`, `prisma ...`) do **not** load `.env`. They read
  `DATABASE_URL` from the shell through `apps/studio-api/prisma.config.ts`, which falls back to the local `video_studio` URL.
- **studio-web** reads `STUDIO_API_URL` and `STUDIO_API_TOKEN` on the server only (`apps/studio-web/src/lib/studio-api.ts`,
  imported with `server-only`). Next.js loads them from `apps/studio-web/.env.local` (or `.env`). Never prefix them with
  `NEXT_PUBLIC_`: that would ship the token to the browser.

### 3.2 studio-api and worker (`apps/studio-api/.env`)

Defaults below are the values `loadConfig` applies when a variable is unset. They were checked by calling `loadConfig` with only
`DATABASE_URL` set. "Secret" means: keep it out of version control, logs and screenshots.

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
| `REDIS_URL` | `redis://localhost:6379` | No | Yes if it contains a password | `redis://` or `rediss://` URL. Used by the API (producer) and the worker when `QUEUE_DRIVER=bullmq`. |
| `QUEUE_DRIVER` | `bullmq` | No | No | `bullmq`: the API enqueues to the Redis queue `studio-director` and the worker processes runs. `inline`: runs execute inside the API process, with no Redis and no worker (section 5). |

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
| `DIRECTOR_RUN_TIMEOUT_MS` | `1800000` (30 min) | No | No | Minimum wall-clock budget for one run (integer above 0). The effective timeout scales with the plan (section 6). Exceeded runs fail with `TIMEOUT`. |
| `DIRECTOR_STEP_TIMEOUT_MS` | `120000` (2 min) | No | No | Per-step budget used for that scaling (integer, 0 or more). `0` disables scaling. |
| `DIRECTOR_CACHE` | `on` | No | No | `on`: validated stage outputs are cached in Postgres (`director_cache_entries`), per user, so an identical re-run costs 0 tokens. `off`: no cache reads or writes. |
| `DIRECTOR_PRICING_JSON` | unset | No | No | JSON object merged over the built-in pricing table, in USD per million tokens. Each entry needs exactly `inputPerMTok`, `outputPerMTok`, `cacheReadPerMTok` and `cacheWritePerMTok` (numbers, 0 or more). Example: `{"claude-opus-5-5":{"inputPerMTok":4,"outputPerMTok":20,"cacheReadPerMTok":0.2,"cacheWritePerMTok":5}}`. |
| `DIRECTOR_WORKER_CONCURRENCY` | `2` | No | No | Parallel director runs per worker process (integer above 0). Worker only. |

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

**Quotas and rate limiting**

| Variable | Default | Required | Secret | Description |
|---|---|---|---|---|
| `LIMIT_DIRECTOR_RUNS_PER_DAY` | `50` | No | No | Director runs a user may start per UTC day (integer, 0 or more). Runs of every status count, including runs of deleted projects. `0` blocks all runs. |
| `LIMIT_DIRECTOR_USD_PER_DAY` | `25` | No | No | Estimated spend per user per UTC day, in USD (number, 0 or more, decimals allowed). `0` blocks all runs. |
| `RATE_LIMIT_PER_MINUTE` | `300` | No | No | Requests per minute per bearer token, or per IP without a token (integer above 0). `/health` is exempt. Exceeding it returns 429 `RATE_LIMITED`. |

**Development seed**

| Variable | Default | Required | Secret | Description |
|---|---|---|---|---|
| `STUDIO_DEV_USER_EMAIL` | `dev@localhost` | No | No | Email of the user the seed script upserts (loose `x@y` check, up to 320 characters) |
| `STUDIO_DEV_API_TOKEN` | none | Only for `pnpm studio:db:seed` | **Yes** | Raw development bearer token, at least 32 characters. Read only by the seed script, which stores its sha256 hash. If set, it must still be 32 characters or more, otherwise the API and worker refuse to start. |

### 3.3 studio-web (`apps/studio-web/.env.local`)

| Variable | Default | Required | Secret | Description |
|---|---|---|---|---|
| `STUDIO_API_URL` | `http://localhost:4100` | No | No | Base URL of studio-api; `http` or `https`, trailing slashes removed. Read on the server only. |
| `STUDIO_API_TOKEN` | none | **Yes** for every page except the health check | **Yes** | Bearer token the web server sends to the API; in development, the `STUDIO_DEV_API_TOKEN` value. Without it pages show a "not configured" state (`CONFIG_MISSING_TOKEN`). |

Fixed in code, not configurable: the web app's API request timeout (15 s) and its port (3000, set in the `dev` and `start`
scripts). Browsers poll run status through the same-origin route `/api/runs/:runId` (every 1.5 s, backing off to 10 s on errors),
so the token never reaches the browser.

M1 studio-web acts as the single user whose token it holds. Do not expose it publicly without an authenticating proxy in front of
it ([PRD 7.3](PRD.md#73-security)).

### 3.4 Test-only variables

| Variable | Default | Description |
|---|---|---|
| `TEST_DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/video_studio_test` | Database used by the studio-api tests (`vitest.config.ts`, `test/global-setup.ts`, `test/helpers.ts`). The database name must end in `_test`, or the test setup refuses to run, because tests truncate every table. |

The test helpers build their own configuration (`QUEUE_DRIVER=inline`, `AI_PROVIDER=mock`, `LOG_LEVEL=silent`) and do not read
`apps/studio-api/.env`.

## 4. AI provider: mock or Claude

### 4.1 Without Claude credits (default)

`AI_PROVIDER=mock` is the default in both `config.ts` and `.env.example`. The heuristic mock provider (`mock`, model
`mock-director-v1`) runs the whole director pipeline offline: brief, outline, then script, storyboard, shot list, engine selection
and scene specs per chapter, and the deterministic compile into a Timeline v1. Its outputs pass the same validation as Claude's.
It reports synthetic token counts so the Usage tab has data, but `mock-director-v1` is priced at $0, so estimated cost stays $0.
Mock runs still count toward `LIMIT_DIRECTOR_RUNS_PER_DAY`.

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
  `max_tokens`) and `VALIDATION_FAILED` (repairs exhausted).
- Switching between `mock` and `anthropic` never reuses cached outputs: the provider, model and prompt version are part of the
  cache key.

Suggested first live run: a 30-second video (one chapter: 7 LLM calls), effort `low` or `medium`, and a small daily budget such
as `LIMIT_DIRECTOR_USD_PER_DAY=2`. [PRD section 7.4](PRD.md#74-cost-controls) has illustrative cost arithmetic.

### 4.3 Seeing what a run cost

| Where | What it shows |
|---|---|
| Project page, **Usage** tab | Totals (calls, cached calls, input, output, cache read and write tokens, estimated cost) and a per-stage table (stage, chunk, attempts, cached, tokens, cost) for the selected version's run, plus the latest 20 runs of the project |
| Dashboard | Runs and estimated cost today (UTC), tokens this month |
| `GET /v1/usage` | `{today, month}`, each with `runs`, the four token counts and `estimatedCostUsd`, for the calling user |
| `GET /v1/director-runs/:runId` | The run's `usage` report (`stages[]` and `totals`) |

Usage is recorded when a run finishes, including the partial usage of runs that failed, timed out or were cancelled while running.
Deleting a project keeps its runs, so usage totals and quotas do not drop. Costs are estimates from the pricing table in
`packages/ai-director/src/pricing.ts` (USD per million tokens; for `claude-opus-5-5`: input 4.00, output 20.00, cache read 0.20,
cache write 5.00). A model missing from the table, for example a fallback model, is counted as $0 with `pricingKnown: false`, and
the Usage tab flags it. Add it with `DIRECTOR_PRICING_JSON`.

### 4.4 Quotas

`POST /v1/projects/:id/director-runs` checks the calling user's runs and estimated spend since the start of the current UTC day.
When either `LIMIT_DIRECTOR_RUNS_PER_DAY` or `LIMIT_DIRECTOR_USD_PER_DAY` is reached it returns 429 `QUOTA_EXCEEDED` with
`details: {runsToday, runsPerDayLimit, estimatedCostTodayUsd, usdPerDayLimit}`. The check happens only when a run starts, so one
long run can go past the USD limit, and simultaneous starts on different projects can each pass it. To reset during development,
raise the limits and restart the API, or wait for the next UTC day.

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
worker does. Start more worker processes, or raise `DIRECTOR_WORKER_CONCURRENCY`, to run more projects in parallel.

On SIGINT or SIGTERM the worker stops taking jobs and waits for active runs to finish. A second signal exits immediately.

With `inline`, restarting the API (for example when `tsx watch` reloads after a file change) can interrupt a run in progress and
leave it `RUNNING`. Cancel it from the project page or with `POST /v1/director-runs/:runId/cancel`.

## 6. Timeouts

Each run gets a wall-clock budget, computed by `effectiveRunTimeoutMs` in `apps/studio-api/src/config.ts`:

```text
timeout = max(DIRECTOR_RUN_TIMEOUT_MS, steps × DIRECTOR_STEP_TIMEOUT_MS)
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

When the budget runs out, the worker aborts the in-flight provider call and marks the run `FAILED` with code `TIMEOUT` and the
message `Director run exceeded its timeout of <n> ms`. Usage up to that point is recorded, and cached chapters make a re-run
cheaper. With the mock provider, runs finish in seconds and never come near the budget.

Tuning:

- Live latency per call has not been measured yet ([ROADMAP known gaps](ROADMAP.md#known-gaps-carried-out-of-m1)). Two
  minutes per step is a starting budget for effort `medium`. Raise `DIRECTOR_STEP_TIMEOUT_MS` for `high`, `xhigh` or `max`
  effort, a slow network, or if live runs fail with `TIMEOUT`.
- Set `DIRECTOR_STEP_TIMEOUT_MS=0` to use `DIRECTOR_RUN_TIMEOUT_MS` as a fixed budget for every run.
- The timeout runs inside the worker. If the worker process dies, nothing times the run out: it stays `RUNNING` until you cancel
  it (section 11).

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

## 9. API quick reference

Every `/v1/*` route requires `Authorization: Bearer <token>`. Errors use one envelope:
`{"error": {"code": "...", "message": "...", "details": ...}}`.

| Method | Path | Success | Common errors |
|---|---|---|---|
| GET | `/health` | 200 `{ok, version}` (public, not rate limited) | — |
| GET | `/v1/me` | 200 `{id, email, name}` | 401 `UNAUTHORIZED` |
| GET | `/v1/system/config` | 200 provider, queue driver, limits, engines, templates, prompt version (no secrets) | 401 |
| GET | `/v1/usage` | 200 `{today, month}` | 401 |
| GET | `/v1/projects?limit=&cursor=` | 200 `{items, nextCursor}`, newest update first, `limit` 1 to 100 (default 20) | 400 `INVALID_CURSOR` |
| POST | `/v1/projects` | 201 project detail | 400 `VALIDATION_ERROR`, 422 `LIMIT_EXCEEDED` |
| GET | `/v1/projects/:id` | 200 project detail with `request` and `latestRun` | 404 `NOT_FOUND` |
| DELETE | `/v1/projects/:id` | 204 | 409 `RUN_ACTIVE` |
| GET | `/v1/projects/:id/versions` | 200 version summaries, newest first | 404 |
| GET | `/v1/projects/:id/versions/:version` | 200 version with `timeline` and `artifacts` | 404 |
| POST | `/v1/projects/:id/director-runs` | 202 run (`queued`) | 409 `RUN_ACTIVE`, 429 `QUOTA_EXCEEDED`, 503 `QUEUE_UNAVAILABLE` |
| GET | `/v1/projects/:id/director-runs` | 200 latest 20 runs | 404 |
| GET | `/v1/director-runs/:runId` | 200 run | 404 |
| POST | `/v1/director-runs/:runId/cancel` | 200 run (`cancelled`) | 409 `RUN_NOT_ACTIVE` |

Any route can also return 429 `RATE_LIMITED`. The full contract is in
[M1 spec section 3](milestones/M1_IMPLEMENTATION_SPEC.md#3-vcstudio-api-appsstudio-api--contract).

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

# Versions: list, then fetch one (timeline + artifacts)
curl -s "$API/v1/projects/$PROJECT_ID/versions" -H "Authorization: Bearer $TOKEN"
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
  "totals": { "inputTokens": 25686, "outputTokens": 3675, "cacheReadTokens": 0, "cacheWriteTokens": 0,
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
| Starting a run returns 503 `QUEUE_UNAVAILABLE` | `QUEUE_DRIVER=bullmq` and Redis became unreachable after the API had connected. The API fails the run (`QUEUE_UNAVAILABLE`), and the project goes back to `READY` if it has a version, otherwise `FAILED`. | Start Redis, then re-run. Or use `QUEUE_DRIVER=inline` for Redis-free development. |
| Starting a run hangs; the web app reports a timeout after 15 s | Redis was not reachable when the API started. The enqueue waits for Redis instead of failing: the run is already `QUEUED` and the project `DIRECTING`. | Start Redis; the pending request then completes and the run proceeds. If the API was restarted in the meantime, the run has no job: cancel it, then re-run. |
| Run stays `queued` ("Queued") | `QUEUE_DRIVER=bullmq` and no worker is running | `pnpm studio:dev:worker`. The job waits in Redis and starts when the worker does. |
| Run stays `running` and the project is blocked with 409 `RUN_ACTIVE` | The worker (or, with `inline`, the API) stopped mid-run. There is no stale-run reaper in M1. | Cancel the run (project page or `POST /v1/director-runs/:runId/cancel`), then re-run |
| 401 `UNAUTHORIZED` from the API, or the web app says its credentials were rejected | Missing header, a token that was never seeded, a token seeded into a different database than the API uses, or a revoked token | Make `STUDIO_API_TOKEN` (web) equal `STUDIO_DEV_API_TOKEN` (API), run `pnpm studio:db:seed` again, and restart the web dev server. Test with `curl -s -o /dev/null -w '%{http_code}\n' "$API/v1/me" -H "Authorization: Bearer $TOKEN"`. |
| Web pages say the API is not configured | `STUDIO_API_TOKEN` is empty, or `STUDIO_API_URL` is not an http(s) URL | Fix `apps/studio-web/.env.local` and restart `pnpm studio:dev:web`. The Settings page shows whether a token is configured. |
| Web pages say the API is unreachable | studio-api is not running, or `STUDIO_API_URL` points at the wrong port | Start `pnpm studio:dev:api`; check `curl -s http://localhost:4100/health` |
| 429 `QUOTA_EXCEEDED` when starting a run | Today's (UTC) runs or estimated spend reached `LIMIT_DIRECTOR_RUNS_PER_DAY` or `LIMIT_DIRECTOR_USD_PER_DAY`. Runs of deleted projects still count. | Raise the limits in `apps/studio-api/.env` and restart the API, or wait for the next UTC day. `details` shows the counts. |
| 429 `RATE_LIMITED` | More than `RATE_LIMIT_PER_MINUTE` requests per minute with one token | Slow the client down or raise the limit |
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
