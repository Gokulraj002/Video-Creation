# Architecture decision records

| | |
|---|---|
| Last updated | 2026-10-09 |
| Related | [PRD.md](PRD.md) · [ROADMAP.md](ROADMAP.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [AI_DIRECTOR.md](AI_DIRECTOR.md) · [TIMELINE_SCHEMA.md](TIMELINE_SCHEMA.md) · [DATABASE.md](DATABASE.md) |

Each record states a decision that shapes the codebase: the context, the decision, what it costs, and what else was
considered. A record is not edited after it is accepted, except for its status and links. When a decision changes, a new record
supersedes the old one, and the old one's status becomes "Superseded by ADR-NNN".

Statuses: **Proposed**, **Accepted**, **Superseded by ADR-NNN**, **Deprecated**.

All records below were accepted at the start of Milestone 1. Several of them describe M1 code that is still being written.
Where a consequence depends on a measurement that has not been taken yet, the record says so.

## Index

| ADR | Decision | Status | Date |
|---|---|---|---|
| [ADR-001](#adr-001-pnpm-workspace-monorepo-migrated-from-npm-workspaces) | pnpm workspace monorepo (migrated from npm workspaces) | Accepted | 2026-10-09 |
| [ADR-002](#adr-002-build-the-studio-beside-the-campaigns-mvp-merge-in-m7) | Build the studio beside the campaigns MVP, merge in M7 | Accepted | 2026-10-09 |
| [ADR-003](#adr-003-fastify-for-the-studio-api-campaigns-keeps-express) | Fastify for the studio API (campaigns keeps Express) | Accepted | 2026-10-09 |
| [ADR-004](#adr-004-prisma-7-for-the-studio-campaigns-keeps-raw-sql-migrations) | Prisma 7 for the studio (campaigns keeps raw SQL migrations) | Accepted | 2026-10-09 |
| [ADR-005](#adr-005-zod-v4-as-the-single-source-of-truth-json-schema-derived-for-llm-outputs) | Zod v4 as the single source of truth, JSON Schema derived for LLM outputs | Accepted | 2026-10-09 |
| [ADR-006](#adr-006-claude-structured-outputs-instead-of-forced-tool-use) | Claude structured outputs instead of forced tool use | Accepted | 2026-10-09 |
| [ADR-007](#adr-007-default-model-claude-opus-5-5-at-effort-medium-with-server-side-refusal-fallbacks) | Default model claude-opus-5-5 at effort medium with server-side refusal fallbacks | Accepted | 2026-10-09 |
| [ADR-008](#adr-008-deterministic-compilation-the-llm-plans-in-seconds-code-allocates-frames) | Deterministic compilation: the LLM plans in seconds, code allocates frames | Accepted | 2026-10-09 |
| [ADR-009](#adr-009-fixed-template-catalog-with-per-template-zod-props-never-llm-generated-code) | Fixed template catalog with per-template Zod props, never LLM-generated code | Accepted | 2026-10-09 |
| [ADR-010](#adr-010-chapter-chunked-generation-for-long-videos) | Chapter-chunked generation for long videos | Accepted | 2026-10-09 |
| [ADR-011](#adr-011-integer-frames-and-a-versioned-timeline-with-migrations) | Integer frames and a versioned timeline with migrations | Accepted | 2026-10-09 |
| [ADR-012](#adr-012-mock-first-ai-providers) | Mock-first AI providers | Accepted | 2026-10-09 |
| [ADR-013](#adr-013-content-hash-stage-cache-and-repairs-as-fresh-single-turn-requests) | Content-hash stage cache and repairs as fresh single-turn requests | Accepted | 2026-10-09 |
| [ADR-014](#adr-014-queue-abstraction-bullmq-with-an-inline-driver-for-tests) | Queue abstraction: BullMQ with an inline driver for tests | Accepted | 2026-10-09 |
| [ADR-015](#adr-015-m1-auth-is-hashed-per-user-bearer-tokens-oidc-in-m8) | M1 auth is hashed per-user bearer tokens, OIDC in M8 | Accepted | 2026-10-09 |
| [ADR-016](#adr-016-configurable-resource-limits-instead-of-hardcoded-duration-caps) | Configurable resource limits instead of hardcoded duration caps | Accepted | 2026-10-09 |
| [ADR-017](#adr-017-nextjs-accesses-the-api-server-side-only) | Next.js accesses the API server-side only | Accepted | 2026-10-09 |

---

## ADR-001: pnpm workspace monorepo (migrated from npm workspaces)

**Status:** Accepted · **Date:** 2026-10-09 · **Applies to:** repository root, every package manifest

### Context

- Before M1 the repository was an npm workspace (`apps/*`, `packages/*`, a `package-lock.json`) holding one product, the
  campaigns MVP. Internal dependencies were declared as `"@vc/core": "*"`.
- M1 adds four packages whose dependencies differ in major version from campaigns: Zod 4 in the studio against Zod 3 in
  campaigns, Next.js 16 next to Vite, Prisma 7 next to raw `pg`. With npm's hoisted `node_modules`, a package can import a
  dependency it never declared and silently get whichever major version was hoisted.
- A `"*"` range for an internal package can resolve from the public registry if the workspace package is missing or renamed.
  Nothing reserves the `@vc` scope on the public registry for this project.
- Several dependencies run install scripts (Prisma, esbuild, sharp, msgpackr-extract). npm runs every dependency's install
  scripts by default.

### Decision

- Use a pnpm 10 workspace. `pnpm-workspace.yaml` lists `packages/*` and `apps/*`. The root `package.json` pins
  `"packageManager": "pnpm@10.28.0"` (used by corepack). `pnpm-lock.yaml` is committed and `package-lock.json` is deleted.
- Internal dependencies use the `workspace:*` protocol, so they can only resolve to the local package.
- Each package declares the tools its own scripts run (`typescript`, `@types/node`, `tsx`, `vitest`).
- Install scripts run only for allowlisted packages: `pnpm.onlyBuiltDependencies` is `@prisma/engines`, `esbuild`,
  `msgpackr-extract`, `prisma`, `sharp`.
- Root scripts fan out with `pnpm -r --if-present typecheck|test|build`. Product-specific scripts are prefixed `studio:` and
  `campaigns:`.
- Workspace packages are consumed as TypeScript source (`"exports": {".": "./src/index.ts"}`). There is no package build step
  and no task runner.

### Consequences

- Contributors need pnpm 10 (`corepack enable`). npm commands no longer work in this repository.
- An undeclared import fails at resolution time instead of picking up a hoisted version. Zod 3 and Zod 4 coexist safely.
- A new dependency that needs an install script (a native addon or a binary download) must be added to
  `onlyBuiltDependencies`. Otherwise pnpm skips its build and only prints a warning during install.
- CI uses `pnpm/action-setup` and `pnpm install --frozen-lockfile`, so a lockfile out of sync with the manifests fails CI.
- The campaigns manifests changed (internal dependencies moved to `workspace:*`, per-package dev tooling, a `test` script in
  `@vc/core`). No campaigns source code changed.
- Without Turborepo or Nx there is no task caching: `pnpm -r` runs every package's scripts each time. That is acceptable while
  packages have no build step.

### Alternatives considered

| Alternative | Why not |
|---|---|
| Stay on npm workspaces | Hoisting hides undeclared dependencies across Zod 3/4 and Prisma/`pg`; no allowlist for install scripts. |
| Yarn 4 (Berry) | Plug'n'Play needs compatibility work with Next.js, Remotion and Prisma. With the node-modules linker it gives no clear gain over pnpm here. |
| Bun workspaces | The runtime target is Node 22. Bun as the package manager with Node at runtime adds a second toolchain for little gain. |
| Turborepo or Nx on top of the workspace | Packages have no build step, so task caching saves little in M1. Either can be added later without changing the workspace layout. |

---

## ADR-002: Build the studio beside the campaigns MVP, merge in M7

**Status:** Accepted · **Date:** 2026-10-09 · **Applies to:** repository layout, databases, ports

### Context

- The campaigns MVP works: an Express 5 API (`apps/api`), BullMQ render and send workers (`apps/worker`), a React + Vite panel
  (`apps/web`), shared config, database, queue, storage and WhatsApp code (`packages/core`), Remotion compositions
  (`packages/video`), plain SQL migrations (`db/migrations`), and one shared `ADMIN_API_KEY`. See [CAMPAIGNS.md](CAMPAIGNS.md).
- The studio needs a different data model (projects, immutable versions, director runs, timeline JSON), per-user auth, and
  different libraries (Zod 4, Fastify, Prisma, Next.js).
- Campaigns can only be rebuilt on the studio pipeline after the studio can render (M2), speak (M4) and play footage (M6).

### Decision

- Build the studio as new packages beside campaigns: `packages/schema`, `packages/ai-director`, `apps/studio-api`,
  `apps/studio-web`.
- M1 changes no campaigns source code, database schema or migration.
- Keep runtime resources separate:

  | Resource | Campaigns | Studio |
  |---|---|---|
  | Database | `video_creation` | `video_studio`, `video_studio_test` |
  | Ports | API 4000, panel 5173 | API 4100, web 3000 |
  | Env files | root `.env` | `apps/studio-api/.env`, `apps/studio-web/.env.local` |
  | Redis | campaigns render and send queues | `studio-director` queue on the same Redis |

- No imports between the two products before M7. Techniques may be ported (for example concatenating identically encoded
  segments, sidechain ducking, loudness normalization), but code is not imported across products.
- In M7, campaigns becomes a studio module. The old apps are retired only after regression tests pass on the module.

### Consequences

- Campaigns keeps working, with no regression risk from M1 work.
- Until M7 the repository holds two HTTP frameworks (Express, Fastify), two Zod majors, two migration systems, two auth schemes
  and two web stacks (Vite, Next.js). Contributors have to know which product a directory belongs to.
- Some work is duplicated. Campaigns already has an S3 storage driver and a Remotion plus FFmpeg render worker; the studio
  builds its own in M2 and M3.
- `docker/postgres/init-databases.sql` creates the studio databases only on the first start of an empty Postgres volume. A
  developer with an existing campaigns volume has to create `video_studio` and `video_studio_test` by hand, or recreate the
  volume.
- The M7 merge is substantial work: data migration, a single auth system, and PRD open question Q13 (Prisma or raw SQL for
  campaigns tables; whether to port the Express routes).

### Alternatives considered

| Alternative | Why not |
|---|---|
| Extend campaigns in place | Its single admin key, raw SQL, Zod 3 and an Express app shaped around CSV campaigns do not fit the studio. Changes would put a working product at risk. |
| A separate repository | Loses shared tooling, CI and the shared Remotion version, and turns the M7 merge into a cross-repository migration. |
| Port campaigns onto the studio first | Blocked on M2, M4 and M6. It would delay the studio with no user benefit for campaigns. |

---

## ADR-003: Fastify for the studio API (campaigns keeps Express)

**Status:** Accepted · **Date:** 2026-10-09 · **Applies to:** `apps/studio-api`

### Context

- studio-api is a JSON API with bearer auth, per-token rate limiting, a CORS allowlist, a 1 MB body limit, structured logs with
  secrets redacted, one error shape (`{error: {code, message, details?}}`), and tests that call routes without opening a port.
- Campaigns uses Express 5.

### Decision

- Fastify 5 (`fastify` ^5.12) with `@fastify/cors`, `@fastify/rate-limit` (keyed per API token) and `fastify-plugin` for the
  auth and error plugins.
- `buildApp(deps: {config, prisma, queue, directorFactory?, logger?})` builds the app, and `src/server.ts` only listens. Tests
  build the app with the inline queue and a mock provider and call it with `app.inject()`.
- Request bodies and env are validated with Zod v4 ([ADR-005](#adr-005-zod-v4-as-the-single-source-of-truth-json-schema-derived-for-llm-outputs)),
  not with Fastify's built-in JSON Schema validation. A `ZodError` becomes 400 `VALIDATION_ERROR` with the issues; an unknown
  error becomes 500 `INTERNAL` without a stack trace.
- Logging uses Fastify's built-in pino logger, with `redact` for the authorization header and API keys.
- Campaigns keeps Express. Whether its routes are ported is decided in M7 (PRD Q13).

### Consequences

- Two HTTP frameworks in the repository until M7.
- Fastify's Ajv validation and fast-json-stringify serialization are unused, and no OpenAPI document is generated in M1. The
  HTTP contract is the set of Zod DTO schemas in `packages/schema/src/api.ts`.
- The auth plugin has to decorate requests outside its own encapsulation context, which is what `fastify-plugin` is for.
  Contributors new to Fastify need to understand its encapsulation model.

### Alternatives considered

| Alternative | Why not |
|---|---|
| Express 5, as in campaigns | Would have worked. Logging, rate limiting and in-process request injection come from separate packages (pino-http, express-rate-limit, supertest). Fastify ships pino and `inject`, and its plugins cover the rest. |
| NestJS | A decorator and dependency-injection framework is more structure than about a dozen routes need. |
| Hono | Its main advantage, portability to edge runtimes, is not needed. The studio runs on Node only. |
| Next.js route handlers as the API | Couples the API to the web deployment. The worker and future clients need the API on its own. |

---

## ADR-004: Prisma 7 for the studio (campaigns keeps raw SQL migrations)

**Status:** Accepted · **Date:** 2026-10-09 · **Applies to:** `apps/studio-api`

### Context

- studio-api stores users, hashed API tokens, projects, immutable project versions (timeline and artifacts as JSON), director
  runs with usage and cost, and director cache entries. It needs relations, cascades, a unique `(projectId, version)`
  constraint, and one transaction that creates a version, marks the run succeeded and sets the project's current version.
- Campaigns uses hand-written SQL files applied by `packages/core/src/migrate.ts` (tracked in a `schema_migrations` table) and
  raw `pg` queries.
- Older Prisma setups ran queries through a native Rust query-engine binary that had to match the deployment platform.

### Decision

- Prisma 7.10 for studio-api only. The `prisma-client` generator writes the client to `apps/studio-api/src/generated/prisma`
  (gitignored). Queries run through the `@prisma/adapter-pg` driver adapter on node-postgres:
  `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`.
- `apps/studio-api/prisma.config.ts` holds the schema path, the migrations path and the datasource URL from `DATABASE_URL`.
  `schema.prisma` contains no URL.
- Migrations use `prisma migrate dev` in development and `prisma migrate deploy` in tests, CI and deployments. Migration SQL is
  committed under `apps/studio-api/prisma/migrations` (the first is `20261009082227_init`).
- Models are PascalCase and fields camelCase, mapped to snake_case tables and columns with `@@map` and `@map`.
- JSON columns (`request`, `timeline`, `artifacts`, `progress`, `usage`, cache `output`) are validated with Zod when written and
  read. Estimated cost is `Decimal(12, 6)`.
- Campaigns keeps its raw SQL migrations and `pg` queries.

### Consequences

- No native query-engine binary to download or match to the platform. The database driver is plain `pg`.
- The client must be generated before typechecking or running studio-api (`pnpm --filter @vc/studio-api db:generate`). CI does
  this explicitly. The README quick start does not yet (listed in [ROADMAP.md](ROADMAP.md#known-gaps-carried-out-of-m1)).
- The Prisma CLI packages still run install scripts, so `prisma` and `@prisma/engines` are in `pnpm.onlyBuiltDependencies`.
- Prisma types JSON columns as generic JSON. Type safety for timelines and artifacts comes from Zod, not from Prisma.
- Two migration systems in one repository, on separate databases, until M7.
- Prisma 7 is recent, so there are fewer published examples and answers than for earlier major versions.

### Alternatives considered

| Alternative | Why not |
|---|---|
| Raw SQL and `pg`, as in campaigns | Consistent with campaigns, but no generated types and hand-written row mapping for six related models. |
| Drizzle ORM | A close alternative (TypeScript schema, SQL-like queries, migration kit). Prisma was chosen for its migration workflow and generated client. Revisit only if Prisma 7 causes real problems. |
| Kysely | A typed query builder only. Migrations and schema types would come from separate tools. |
| Prisma with the native query engine | A per-platform binary to ship. The Rust-free client with a driver adapter is the current Prisma 7 path. |

---

## ADR-005: Zod v4 as the single source of truth, JSON Schema derived for LLM outputs

**Status:** Accepted · **Date:** 2026-10-09 · **Applies to:** `packages/schema`, every consumer

### Context

- The same shapes cross four boundaries: the web form (`VideoRequest`), the HTTP API (DTOs), the LLM (stage outputs) and
  storage (timeline JSON in Postgres). Each boundary needs runtime validation, and the TypeScript types must match it.
- Claude structured outputs accept a restricted JSON Schema ([ADR-006](#adr-006-claude-structured-outputs-instead-of-forced-tool-use)):
  `additionalProperties: false` is required on every object, and numeric bounds, string lengths, array sizes, recursion,
  `oneOf` and non-false `additionalProperties` are not supported.
- The timeline has cross-field invariants (contiguous scenes, one id namespace, compatible asset kinds) that plain JSON Schema
  cannot express.

### Decision

- Every contract lives in `@vc/schema` as a Zod v4 schema (`import { z } from 'zod'`, ^4.6), exported as `XxxSchema` with
  `export type Xxx = z.infer<typeof XxxSchema>`. The package is isomorphic and is consumed as TypeScript source by the director,
  the API and the web app.
- Timeline invariants are implemented with `superRefine` and report a precise `path` for each issue.
- LLM-facing schemas follow extra rules: closed objects, every property required (`.nullable()` instead of `.optional()`), no
  records or maps, no recursion, no defaults. Length and size constraints are allowed in Zod.
- The JSON Schema sent to the model is derived, never hand-written. `toStructuredOutputSchema(schema)` calls
  `z.toJSONSchema(schema, {io: 'output'})`, then recursively removes `$schema` and unsupported keywords, converts `oneOf` to
  `anyOf`, forces `additionalProperties: false` on objects, and keeps `format` only for `date-time`, `time`, `date`,
  `duration`, `email`, `hostname`, `uri`, `ipv4`, `ipv6` and `uuid`.
- Every model output is validated again with the original Zod schema, stripped constraints included, and then by a
  stage-specific semantic validator.
- studio-web validates every API response with the DTO schemas.

### Consequences

- One edit changes validation, types and the model's output schema together.
- Constraints stripped from the wire schema (for example a `logline` of at most 300 characters, or 1 to 6 bullets) are not
  enforced during generation. Violations are caught by Zod and cost a repair call
  ([ADR-013](#adr-013-content-hash-stage-cache-and-repairs-as-fresh-single-turn-requests)).
- LLM-facing schemas look different from internal ones (nullable fields where internal schemas use optional ones), so a few
  mapping steps are needed.
- Template props stored in the timeline are `Record<string, JsonValue>` with size and depth bounds. Per-template props schemas
  are checked by the director, not by `TimelineSchema` ([ADR-009](#adr-009-fixed-template-catalog-with-per-template-zod-props-never-llm-generated-code)).
- Campaigns stays on Zod 3. No schema is shared between the products before M7.
- The derived wire schema depends on Zod's JSON Schema converter, so tests assert the converted output of the LLM-facing
  schemas.

### Alternatives considered

| Alternative | Why not |
|---|---|
| JSON Schema as the source, with generated types | The timeline's cross-field invariants do not fit, and generated types are harder to read. |
| TypeBox | JSON-Schema-native and a good fit for Fastify, but weaker at cross-field refinements. The web app would need a second library or Ajv in the browser. |
| Hand-written types plus separate validators | Types and validation drift apart. |
| Hand-written JSON Schema per stage | Two definitions per stage to keep in sync. |

---

## ADR-006: Claude structured outputs instead of forced tool use

**Status:** Accepted · **Date:** 2026-10-09 · **Applies to:** `packages/ai-director` (`AnthropicProvider`)

### Context

- Every director stage must return JSON that matches a schema.
- A common technique is to define one tool whose `input_schema` is the output schema and force it with `tool_choice`. On
  `claude-opus-5-5`, forced tool choice (`{type: "any"}` or `{type: "tool", name}`) returns HTTP 400.
- Assistant prefill (starting the reply with `{`) also returns 400 on this model.
- Structured outputs constrain the response itself to a JSON Schema, through `output_config.format`.

### Decision

- `AnthropicProvider` sends `output_config: { effort, format: { type: 'json_schema', schema } }`, with the schema from
  `toStructuredOutputSchema` ([ADR-005](#adr-005-zod-v4-as-the-single-source-of-truth-json-schema-derived-for-llm-outputs)).
  No tools are defined.
- Requests go through `client.beta.messages.create`, which the refusal fallbacks need
  ([ADR-007](#adr-007-default-model-claude-opus-5-5-at-effort-medium-with-server-side-refusal-fallbacks)). The stage system
  prompt is a cached text block, followed by one user message.
- Response handling checks `stop_reason` before reading content. `refusal` raises `ProviderRefusalError` (not retryable,
  carrying `stop_details.category`), and `max_tokens` raises `ProviderTruncatedError`. Otherwise the `text` blocks are
  concatenated, optional code fences are stripped, and the text is parsed with `JSON.parse`. The output stays `unknown` until
  the director validates it.
- Prompt-mode fallback. If a `BadRequestError` in `json_schema` mode mentions the schema, `output_config` or `format`, the
  adapter retries once in prompt mode: the same JSON Schema is embedded in the prompt and `format` is omitted.
  `ANTHROPIC_STRUCTURED_OUTPUT=prompt` uses prompt mode for every call.
- Other errors are mapped from the SDK's typed error classes: authentication and permission errors to `PROVIDER_CONFIG`; rate
  limit, server, connection and timeout errors to `PROVIDER_UNAVAILABLE` (retryable); any other 400 to `PROVIDER_REQUEST`.

### Consequences

- In `json_schema` mode the response is constrained to the schema's structure. Most failures left for the repair loop are
  semantic (scene counts, duration sums) or stripped constraints (lengths, ranges).
- Prompt mode has no generation-time constraint and should be expected to need more repairs. It exists so that a schema the
  endpoint rejects, for example a scene-specs union over a growing template catalog, degrades instead of failing the run.
- Deciding to fall back relies on the wording of the 400 message, which the API does not guarantee. If the wording changes,
  the adapter reports `PROVIDER_REQUEST` instead of retrying. It fails visibly, not silently.
- Tests check the exact request shape and every response path against an injected fake client
  ([ADR-012](#adr-012-mock-first-ai-providers)).

### Alternatives considered

| Alternative | Why not |
|---|---|
| Forced tool use (`tool_choice` `any` or `tool`) | Returns 400 on `claude-opus-5-5`. |
| `tool_choice: auto` with a strict tool and an instruction to call it | The model may answer in text instead of calling the tool, and a tool round trip is more machinery than a JSON response needs. |
| Prompt-only JSON | No generation-time constraint. Kept as the fallback. |
| Assistant prefill with `{` | Returns 400 on this model. |
| The SDK's structured-output parsing helper | Considered. A hand-built request keeps the exact wire schema under test, reuses the same derived schema in prompt mode, and sends validation failures to the director's repair loop instead of raising inside the SDK. |

---

## ADR-007: Default model claude-opus-5-5 at effort medium with server-side refusal fallbacks

**Status:** Accepted · **Date:** 2026-10-09 · **Applies to:** `packages/ai-director` (`AnthropicProvider`), `apps/studio-api` config

### Context

- Plan quality determines everything downstream. A 25-minute plan is about 47 LLM calls and a 2-hour plan about 127
  ([ADR-010](#adr-010-chapter-chunked-generation-for-long-videos)), so the price per call matters.
- `claude-opus-5-5` is the current Opus model. Its price is $4 per million input tokens and $20 per million output tokens,
  with cache reads at $0.20 and 5-minute cache writes at $5.00. That is less per token than `claude-opus-5` ($5 / $25).
- On this model, thinking cannot be disabled: adaptive thinking is always on, and thinking tokens are billed as output.
  `temperature`, `top_p`, `top_k` and `budget_tokens` return 400. The default effort is `medium`, one level below Claude Opus
  5's default of `high`.
- Safety classifiers can decline a request with `stop_reason: "refusal"` (HTTP 200), and benign requests are sometimes
  declined. Without a fallback, a refused stage fails the whole run.
- The server-side `fallbacks` parameter re-runs a declined request on another model within the same API call.
  `fallbacks: "default"` picks the fallback model by refusal category, so no model list has to be maintained. It needs the beta
  header `server-side-fallback-2026-07-01`, triggers on policy declines only (not on rate limits, overloads or server errors),
  and is not available on the Batches API, Amazon Bedrock, Google Vertex AI or Microsoft Foundry.

### Decision

- Defaults, all overridable by env when `AI_PROVIDER=anthropic`: `ANTHROPIC_MODEL=claude-opus-5-5`,
  `ANTHROPIC_EFFORT=medium`, `ANTHROPIC_MAX_OUTPUT_TOKENS=16000`, `ANTHROPIC_FALLBACKS=default`,
  `ANTHROPIC_STRUCTURED_OUTPUT=json_schema`. The adapter timeout is 600 000 ms and SDK `maxRetries` is 2.
- Effort is always sent explicitly in `output_config.effort`, so behaviour does not shift if the model's default changes or
  `ANTHROPIC_MODEL` changes.
- The adapter sends no `thinking` parameter, no sampling parameters and no prefill.
- With fallbacks on, every request includes `betas: ['server-side-fallback-2026-07-01']` and `fallbacks: 'default'`.
  `ANTHROPIC_FALLBACKS=off` omits both.
- Requests are non-streaming. Chapter chunking keeps each output well below `max_tokens`.
- Usage and cost are recorded against the model that served the response (`response.model`), using a pricing table that
  `DIRECTOR_PRICING_JSON` can override.
- `AI_PROVIDER=mock` stays the default ([ADR-012](#adr-012-mock-first-ai-providers)). This record applies only when the
  Anthropic provider is selected.

### Consequences

- Illustrative cost, not a measurement: a call with 6 000 input and 4 000 output tokens costs about $0.024 + $0.080 = $0.104.
  Thinking tokens count as output but are not shown, so output token counts are higher than the size of the JSON suggests.
- There is no sampling control. Two live runs of the same uncached request produce different plans. Reproducibility comes
  from the stage cache ([ADR-013](#adr-013-content-hash-stage-cache-and-repairs-as-fresh-single-turn-requests)) and the
  deterministic compiler ([ADR-008](#adr-008-deterministic-compilation-the-llm-plans-in-seconds-code-allocates-frames)), not
  from the model.
- When a fallback serves a stage, the served model differs from `ANTHROPIC_MODEL`. If that model is not in the pricing table,
  the stage records cost 0 with `pricingKnown: false`, and the daily USD quota under-counts. The Usage tab shows the served
  model per stage.
- Effort `medium` is a starting point, not a measured optimum (PRD Q10).
- The request shape targets the first-party Claude API and the rules of the Opus 5.5 family. Other models set through
  `ANTHROPIC_MODEL` may need other settings. For example, Claude Haiku 5.5 has no server-side refusal fallback, so it needs
  `ANTHROPIC_FALLBACKS=off`. Bedrock, Vertex AI and Foundry would need a different client and the SDK's client-side fallback
  middleware. They are not supported in M1.
- A 16 000-token cap on non-streaming requests stays within the SDK's HTTP timeout behaviour. Larger outputs would need
  streaming.
- The Message Batches API (asynchronous, lower cost) is not used, partly because it does not accept `fallbacks` (PRD Q10).

### Alternatives considered

| Alternative | Why not |
|---|---|
| `claude-sonnet-5-5` ($2 / $10) as the default | Half the price. Not chosen before plan quality has been measured (PRD Q10). It is one env var away. |
| `claude-haiku-5-5` for cheap stages | Per-stage routing is PRD Q10. A single model also keeps a single prompt-cache namespace. |
| `claude-fable-5-1` ($10 / $50) | The most capable model, at 2.5 times the price, for a planning task with no evidence that it needs it. |
| Effort `high` | More cost and latency for an unmeasured gain. Available through `ANTHROPIC_EFFORT`. |
| Fallbacks off | A false-positive refusal would fail the whole run. Available through `ANTHROPIC_FALLBACKS=off`. |
| The array form of `fallbacks` naming specific models | A model list to maintain. `"default"` routes by refusal category. |

---

## ADR-008: Deterministic compilation: the LLM plans in seconds, code allocates frames

**Status:** Accepted · **Date:** 2026-10-09 · **Applies to:** `packages/ai-director` (compiler), `packages/schema` (frame math)

### Context

- A valid timeline needs integer frames that sum exactly to `durationInFrames`, contiguous scenes, chapters that are exact
  spans of their scenes, camera keyframes inside each scene, transitions bounded by their neighbours, and caption cues that do
  not overlap.
- Language models are unreliable at this arithmetic, and the amount of it grows with video length (about 600 scenes in a
  2-hour `long-form` plan). Asking the model for frames would also tie its output to the fps.
- Example: a storyboard of 3.2 s, 4.1 s and 2.9 s for a 10 s video at 30 fps sums to 10.2 s, which is within the ±10 %
  tolerance of a chapter script. Rounding each scene on its own gives 96 + 123 + 87 = 306 frames for a 300-frame video.

### Decision

- The LLM plans in seconds: chapter targets, segment durations, storyboard `durationSeconds`, shot durations. The compiler
  treats storyboard durations as weights, not as positions.
- The compiler (`packages/ai-director/src/compiler.ts`) is pure code with no LLM call:
  - `resolveDimensions` for width and height; `totalFrames = max(1, secondsToFrames(duration, fps))`.
  - `allocateFrames(storyboardDurations, totalFrames, minFrames)` with
    `minFrames = max(1, min(fps, floor(totalFrames / sceneCount)))`. It uses largest-remainder apportionment, and ties go to the
    lower index. For the example above, the exact quotas are 94.12, 120.59 and 85.29. The floors sum to 299, so the remaining
    frame goes to the largest remainder, giving 94 + 121 + 85 = 300.
  - Chapters are the spans of their scenes. Scene content comes from the scene specs. Cameras come from
    `expandCameraPreset`, using the spec's preset or a preset mapped from the first shot's camera movement.
  - `transitionIn` lasts `min(round(0.5 × fps), floor(min(adjacent scene frames) / 2))`, with `cut` = 0 and none on the first
    scene. Narration comes from the storyboard voice-over. When voice-over is enabled, one caption track is built with cues of
    at most 7 words, timed in proportion to word count, contiguous and non-overlapping. The brand kit is mapped from the
    request colours and the brief palette.
  - `metadata.generator = {name: 'vc-ai-director', version: '0.1.0', promptVersion}`.
  - Finally `TimelineSchema.parse` and `checkTimelineLimits`. A limit violation raises `LIMIT_EXCEEDED`.

### Consequences

- The same artifacts and request always compile to the same timeline. The compiler can be tested without any provider, frame
  sums are exact by construction, and the genre × duration test matrix checks them.
- Scene lengths are normalized. A storyboard that sums to 10.2 s for a 10 s video is scaled to fit, so the storyboard's
  planned seconds and the timeline's actual seconds can differ slightly. The UI shows timeline timecodes.
- Short videos with many scenes run into the minimum-frames rule. `planStructure` already caps the scene count at
  `floor(duration)` (at least 1 s per scene).
- `regenerateScene` keeps the scene's frame count, so no other scene moves. Reordering and editing in M2 reuse the compiler.
- A change to the compiler changes the output for identical artifacts. `metadata.generator.version` records which compiler
  produced a timeline.

### Alternatives considered

| Alternative | Why not |
|---|---|
| The LLM writes the timeline JSON | Large outputs, arithmetic errors, invariant violations, and a repair cost that grows with video length. |
| The LLM outputs frames | The same arithmetic problem, and the output depends on the fps. |
| Round each scene independently | The sum drifts (306 instead of 300 above) and needs a fix-up step anyway. |
| Floor every scene and give the remainder to the last one | Deterministic, but one scene absorbs up to n − 1 extra frames. |

---

## ADR-009: Fixed template catalog with per-template Zod props, never LLM-generated code

**Status:** Accepted · **Date:** 2026-10-09 · **Applies to:** `packages/schema/src/templates`, `packages/ai-director`

### Context

- The most flexible option would be for the model to write Remotion or React code for each scene. That code would run in the
  render worker, which has Chromium, FFmpeg, the filesystem and network access. Its output would be non-deterministic and hard
  to validate, review or edit.
- The product has to produce editable, consistent, on-brand output across many genres.
- User prompts and reference data are untrusted and may contain prompt-injection attempts.

### Decision

- A fixed, reviewed template catalog in `@vc/schema`:
  - `motion2d` (11): `title-card`, `kinetic-text`, `bullet-list`, `quote`, `stat-counter`, `step-instruction`,
    `split-feature`, `cta-end-card`, `cartoon-scene`, `property-showcase`, `lower-third`.
  - `three` (3): `product-turntable`, `logo-reveal-3d`, `floating-shapes`.
- Each `TemplateDefinition` has an id, an engine, a name, a description (what it looks like and when to use it), genres, an
  LLM-safe Zod `propsSchema`, `minDurationSeconds`, and a deterministic `buildProps(ctx)` that always returns valid props. The
  heuristic mock and the engine-fallback coercion both use `buildProps`.
- The model only picks a template id and fills in its props. The scene-specs output schema is a discriminated union on
  `template` over the catalog. The prompt describes only the templates selected for that chapter.
- The director checks catalog membership and validates props. `TemplateIdSchema` in the timeline accepts any valid id, so a
  stored timeline still parses if a template is later renamed or removed.
- No stage asks the model for code, and nothing ever executes model output.

### Consequences

- The visual range is the catalog. A new look needs a pull request with a props schema, `buildProps`, and from M2 a render
  component with still-frame tests.
- The worst a prompt injection can do is produce wrong text or a wrong template choice within schema bounds. It cannot run
  code.
- In M1 the templates have no render components; the preview is an animatic. M2 renders the 2D templates and M5 the 3D ones.
- Some props anticipate later work. `split-feature.imageAssetId` needs uploads (M3). `split-feature.imagePrompt` needs an
  image-generation adapter, which is not scheduled (PRD ENG-7).
- An incompatible change to a template's props schema needs a new template id or a timeline migration, because old versions
  must keep rendering.
- Each new template grows the scene-specs union schema (see [ADR-006](#adr-006-claude-structured-outputs-instead-of-forced-tool-use)
  on schema size).

### Alternatives considered

| Alternative | Why not |
|---|---|
| LLM-generated Remotion or React code, sandboxed | Runs untrusted code in the render path, is non-deterministic and cannot be reviewed at scale. Any edit means regenerating code. |
| A free-form layer language written by the LLM (text and shape layers) | More expressive, but layout quality and brand consistency would depend on the model. `Layer2D` exists in timeline v1, but it is not part of any LLM-facing schema in M1. |
| Generated video for every scene | Expensive, slow, hard to edit and hard to keep on brand. It arrives in M6 as one engine among several. |

---

## ADR-010: Chapter-chunked generation for long videos

**Status:** Accepted · **Date:** 2026-10-09 · **Applies to:** `packages/ai-director` (planning, pipeline)

### Context

- Requests range from 5 s to 2 h and beyond, bounded only by configurable limits
  ([ADR-016](#adr-016-configurable-resource-limits-instead-of-hardcoded-duration-caps)). A 2-hour `long-form` plan has about
  600 scenes. One response cannot hold the storyboard, shots and props for 600 scenes within a 16 000-token output cap, and a
  single failure would throw everything away.
- Each stage's output has to stay small enough to be valid, repairable and cacheable on its own.

### Decision

- `planStructure` fixes the structure before any LLM call:
  - Target scene length by genre, from 2.5 s (`social-short`) to 12 s (`long-form`). `reference-based` uses the reference's
    average shot length, clamped to 1.5 to 20 s.
  - `expectedScenes = clamp(round(duration / target), 1, maxScenes)`, with an allowed range of ±25 %, at least 1 and at most
    `floor(duration)`.
  - `chapterCount` is 1 when the duration is at most 120 s, and otherwise
    `min(maxChapters, max(ceil(duration / 300), ceil(expectedScenes / 24)))`.
  - Chapter targets split the duration evenly. Per-chapter scene ranges are proportional.
- Two global stages run once: `brief` and `outline`. The outline must have exactly `chapterCount` chapters with durations within
  ±2 % of the total, which the director then normalizes to the plan exactly.
- Then for each chapter, in order: `script`, `storyboard`, `shotList`, `engineSelection`, `sceneSpecs`. Each chapter's prompts
  include the previous chapter's title and summary for continuity.
- `totalSteps = 2 + 5 × chapters + 1` (the final step is the deterministic compile). Progress is reported per step, and
  cancellation is checked before every provider call and every chapter.
- Scene ids are remapped to `c{n}-s{m}` so they are unique across the whole video.

Worked examples (LLM calls exclude repairs):

| Request | Target scene | Expected scenes | Chapters | LLM calls | Steps |
|---|---|---|---|---|---|
| 60 s `promo` | 3.5 s | 17 | 1 | 7 | 8 |
| 10 min `explainer` | 7 s | 86 | 4 | 22 | 23 |
| 20 min `sop-training` | 9 s | 133 | 6 | 32 | 33 |
| 25 min `explainer` | 7 s | 214 | 9 | 47 | 48 |
| 2 h `long-form` | 12 s | 600 | 25 | 127 | 128 |

### Consequences

- The output of each call is bounded (about 24 scenes and at most 300 s per chapter), whatever the total length.
- The number of calls grows linearly with duration, and because chapters run in sequence, so does latency. Live latency has
  not been measured. A 127-call run may well exceed the default `DIRECTOR_RUN_TIMEOUT_MS` of 30 minutes.
- If a run fails midway, a rerun reuses every cached stage before the failure, because those prompts are identical
  ([ADR-013](#adr-013-content-hash-stage-cache-and-repairs-as-fresh-single-turn-requests)). Only the failed chapter and the
  ones after it are paid for again.
- Continuity is limited to the brief, the outline and the previous chapter's summary. Recurring characters and terminology
  across distant chapters depend on the brief and outline. Repetition between distant chapters is possible and not yet
  measured.
- The constants 120 s, 300 s and 24 scenes are tuning choices, not measured optima.
- Mock-provider tests cover 5 s, 30 s, 10 min, 25 min and 2 h.

### Alternatives considered

| Alternative | Why not |
|---|---|
| One call per stage for the whole video | Output too large for long videos; one failure loses everything; a repair resends everything. |
| Chapters in parallel | Faster, but a chapter could no longer see the previous chapter's summary. May be revisited once latency has been measured. |
| Pass every previous chapter's full output | The prompt grows with every chapter, so total input tokens grow quadratically. |

---

## ADR-011: Integer frames and a versioned timeline with migrations

**Status:** Accepted · **Date:** 2026-10-09 · **Applies to:** `packages/schema` (timeline, frames, migrations), stored `ProjectVersion` rows

### Context

- The timeline is the only interchange format between the director, the preview (Remotion Player), the editor (M2) and the
  renderers (M2, M5, M6). Remotion works in frames.
- Times stored as floating-point seconds accumulate rounding error. Segment rendering (M2) and distributed rendering (M7) need
  exact frame boundaries.
- Timelines are stored in every `ProjectVersion` and must stay readable as the schema evolves.

### Decision

- Every position and duration is an integer number of frames at `settings.fps` (`FrameSchema`: integer ≥ 0;
  `DurationFramesSchema`: integer ≥ 1). Layer and camera keyframe frames are relative to the scene start.
- `fps` is an integer from 1 to 240.
- The document carries `schemaVersion: 1`, and `CURRENT_TIMELINE_VERSION = 1`.
- `TIMELINE_MIGRATIONS: Record<number, (doc) => doc>` maps version N to N + 1 and is empty in v1. `migrateTimeline` reads
  `schemaVersion` (missing is an error), applies migrations in order and rejects versions newer than the current one.
  `parseTimeline` migrates, then parses.
- Invariants are enforced at parse time: contiguous scenes and chapters covering `[0, durationInFrames]`, one global id
  namespace, asset references with compatible kinds, non-overlapping items within each track, bounded transitions, strictly
  increasing camera keyframes, fades that fit, and an asset id for every `ready` generated scene.
- Each `ProjectVersion` row records the `schemaVersion` of the timeline it stores.

### Consequences

- Frame sums are exact and checkable, and renderers never see gaps or overlaps on the scene sequence.
- Changing the fps is not a rescale. It means compiling again from the artifacts.
- Fractional broadcast rates (23.976, 29.97, 59.94 fps) cannot be represented in v1. Supporting them would need a rational fps
  in a v2 schema.
- v1 does not allow gaps or overlaps between scenes. If editor v2 (M7) needs them, that is timeline v2 with a migration.
- Migrations are forward-only pure functions on JSON. There are no down-migrations, and a deployment rejects (rather than
  misreads) timelines written by a newer version.
- Template ids are not checked against the catalog by the timeline schema
  ([ADR-009](#adr-009-fixed-template-catalog-with-per-template-zod-props-never-llm-generated-code)).

### Alternatives considered

| Alternative | Why not |
|---|---|
| Floating-point seconds | Rounding drift; renderers convert to frames anyway. |
| Integer milliseconds | Not frame-aligned at 30 or 60 fps (33.33 ms per frame), so rounding still happens at render time. |
| Rational time (value over rate, as in OpenTimelineIO) | Handles broadcast rates, but every consumer has to do rational arithmetic. Not needed with integer fps in M1; reconsider for v2. |
| OpenTimelineIO as the storage format | No natural place for engine-specific content and template props. It could become an export format later; that is not scheduled. |
| No version field, with lenient parsing | Old documents would be silently misread after a schema change. |

---

## ADR-012: Mock-first AI providers

**Status:** Accepted · **Date:** 2026-10-09 · **Applies to:** `packages/ai-director` (providers), `apps/studio-api` config, CI

### Context

- Development, CI and demos must run without an API key and without spending credits. Tests must not touch the network.
- The pipeline has many failure paths (invalid outputs, refusals, truncation, slow calls, cancellation) that cannot be
  triggered reliably with a live model.

### Decision

- `AI_PROVIDER=mock` is the default.
- `HeuristicMockProvider` (name `mock`, model `mock-director-v1`, mode `mock`) builds the output of every stage from the stage
  input. It is deterministic (seeded by a hash of the input) and genre-aware, and it always returns schema-valid and
  semantically valid output for the plan it is given. Template props come from `buildProps`. Usage is estimated as characters
  divided by 4, and the price of `mock-director-v1` is 0.
- `ScriptedMockProvider(handler(req, callIndex))` is for tests. It injects invalid outputs, refusals and delays, and records
  every call.
- `AnthropicProvider` is tested against an injected fake client typed by the `AnthropicLikeClient` structural interface.
- CI sets `AI_PROVIDER=mock` and has no Anthropic key.
- `GET /v1/system/config` reports the provider's name, model and mode, and the UI shows mock mode explicitly.

### Consequences

- The whole flow works offline and in CI at zero cost, and tests are deterministic.
- The mock's creative quality is not representative. A passing mock run says nothing about live validity, and prompt or model
  regressions are invisible to CI (PRD Q15).
- The mock has to be updated with every new stage, LLM-facing schema or template. It is a second implementation of "a valid
  plan".
- Mock token counts are estimates and their cost is 0. They show what the UI looks like, not what a live run costs.
- The fake Anthropic client checks requests against our understanding of the API, not against the API itself. The manual live
  check in the M1 exit criteria covers that gap.

### Alternatives considered

| Alternative | Why not |
|---|---|
| Record and replay real API responses | Creating fixtures needs live calls and credits, and every prompt or schema change makes them stale. |
| Live calls in CI with a budget | Costs money on every push, is flaky and nondeterministic, and needs secrets in CI. |
| A local open-weights model | Heavy to run in CI, nondeterministic, and still not representative of Claude. |

---

## ADR-013: Content-hash stage cache and repairs as fresh single-turn requests

**Status:** Accepted · **Date:** 2026-10-09 · **Applies to:** `packages/ai-director` (cache, repair loop), `apps/studio-api` (Prisma cache)

### Context

- Live stage calls cost money and time, and reruns (after a failure, after a cancel, or from the Re-run button) often repeat
  identical stages.
- Model outputs sometimes fail Zod or semantic validation and have to be repaired.
- Sampling parameters are not available on the default model, so outputs cannot be made reproducible with temperature 0.

### Decision

Stage cache:

- The key is the SHA-256 hex digest of canonical (sorted-key) JSON of
  `{stage, chunk, promptVersion, provider, model, schemaName, system, prompt}`.
- Only outputs that passed both Zod and semantic validation are stored.
- A hit makes no provider call and records a `StageUsage` with `cached: true`, zero tokens and zero cost.
- `DirectorCache` is an interface. The library provides `MemoryDirectorCache` (LRU, 500 entries). studio-api uses a
  Prisma-backed cache (`DirectorCacheEntry`: key, stage, provider, model, output, usage, hits, lastHitAt) when
  `DIRECTOR_CACHE=on`.
- Separately, the stable stage system prompt is sent with `cache_control: {type: 'ephemeral'}` so that Anthropic prompt
  caching can apply. Volatile data goes only in the user message.

Repairs:

- When an output fails validation, the director sends a fresh single-turn request: the original prompt, plus
  `<validation_errors>` (at most 30 issues), plus `<previous_output>` (truncated to 20 000 characters).
- There are at most `DIRECTOR_MAX_REPAIR_ATTEMPTS` (default 2) extra attempts, after which the run fails with
  `VALIDATION_FAILED` and the issues. `StageUsage.attempts` records the number of attempts.
- Refusals and configuration errors are not repaired.

### Consequences

- An identical rerun costs nothing and makes no provider calls (tested). A rerun after a mid-run failure reuses every stage
  before the failure.
- An identical request returns the identical plan. Getting a fresh take needs a cache bypass, which does not exist yet
  (PRD Q6).
- The cache is per deployment, not per user. A hit reveals that someone else submitted the same request, and the database
  table has no TTL or eviction (PRD Q5).
- The key includes the prompt text but not the schema body. The rule is to bump `PROMPT_VERSION` whenever a prompt, an
  LLM-facing schema or a template props schema changes.
- Anthropic prompt caching applies only when the cached prefix is longer than the model's minimum cacheable length, so a short
  stage system prompt will not be cached. `cacheReadTokens` in the Usage tab shows whether it is.
- A repaired stage pays for its input at least twice, because every repair resends the whole prompt plus the previous output.
- Single-turn repairs keep the provider interface stateless: one request in, one result out. Mocks, cache keys and retries
  deal with a single request shape, and the adapter never has to replay assistant content, thinking blocks included, from an
  earlier turn.

### Alternatives considered

| Alternative | Why not |
|---|---|
| No stage cache | Every rerun pays the full price again. |
| Anthropic prompt caching only | Discounts repeated input, but output tokens (thinking included) and latency are paid in full. |
| Cache whole runs keyed on the request | No partial reuse after a mid-run failure. |
| A multi-turn repair conversation | The history grows per stage, the adapter must keep and replay the full assistant content, and it is harder to cache and to mock. |
| Retry the same prompt without feedback | Gives the model nothing to fix, and without sampling control convergence is luck. |
| Rely on structured outputs alone | They guarantee structure, not semantics (duration sums, scene counts) or the constraints stripped from the wire schema. |

---

## ADR-014: Queue abstraction: BullMQ with an inline driver for tests

**Status:** Accepted · **Date:** 2026-10-09 · **Applies to:** `apps/studio-api` (`src/queue`, `src/director/process-run.ts`, `src/worker.ts`)

### Context

- A director run takes from seconds (mock) to tens of minutes (live, long videos). `POST /v1/projects/:id/director-runs` must
  return 202 straight away.
- In production the work belongs in a separate worker process. Tests need deterministic, in-process execution without Redis.
- Campaigns already runs BullMQ on Redis.

### Decision

- A queue interface (`src/queue/types.ts`) with two drivers, `bullmq.ts` and `inline.ts`, selected by
  `QUEUE_DRIVER=bullmq|inline`.
- BullMQ driver: queue `studio-director`, `attempts: 1`, `removeOnComplete: 1000`, `removeOnFail: 5000`. The worker
  (`src/worker.ts`) is a separate process with concurrency `DIRECTOR_WORKER_CONCURRENCY` (default 2) and shuts down gracefully
  on SIGTERM and SIGINT.
- Inline driver: processes jobs asynchronously inside the API process and exposes `onIdle()` so tests can wait for them.
- The job payload is only `{runId}`. Both drivers call the same `src/director/process-run.ts`. The `DirectorRun` row in
  Postgres is the source of truth: processing skips any run that is not `QUEUED`, and cancelling sets the row to `CANCELLED`,
  which the worker notices when it persists progress and turns into an abort signal.
- No job-level retries. Retries happen inside the run (SDK retries, the director's repair loop). A rerun is an explicit user
  action, and the stage cache makes it cheap.

### Consequences

- A duplicate delivery does nothing.
- API tests cover run processing without Redis. BullMQ-specific behaviour (connection loss, stalled jobs) is not covered by
  them.
- The inline driver runs work inside the API process, with no isolation, and loses work on restart. It is for development and
  tests only.
- A crashed worker leaves its run `RUNNING`. A stalled-job redelivery is skipped because the run is no longer `QUEUED`. A
  stale-run reaper is planned for M2 ([ROADMAP.md](ROADMAP.md#known-gaps-carried-out-of-m1)).
- In M1 a cancel is noticed on the worker's next progress update, so a long provider call already in flight may finish before
  the run stops.
- The M2 render queue reuses the same interface.

### Alternatives considered

| Alternative | Why not |
|---|---|
| pg-boss or another Postgres-backed queue | One service fewer, but Redis is already required by campaigns and the team already runs BullMQ there. |
| No queue (run in the request process) | Long runs tie up the API process and are lost on restart. |
| A managed cloud queue (for example SQS) | Adds a cloud dependency to local development and CI. |
| A workflow engine (for example Temporal) | Durable steps and resumption, but a large operational addition for M1. May be reconsidered when M7 distributed rendering is designed. |

---

## ADR-015: M1 auth is hashed per-user bearer tokens, OIDC in M8

**Status:** Accepted · **Date:** 2026-10-09 · **Applies to:** `apps/studio-api` (auth plugin, `User`, `ApiToken`, seed script)

### Context

- Every `/v1/*` route needs an authenticated user, to scope data by owner, enforce daily quotas per user and rate-limit per
  token. M1 has no login UI.
- Campaigns uses one shared `ADMIN_API_KEY`: no per-user scoping, and no way to revoke one person's access without changing
  the key for everyone.
- OIDC needs an identity-provider decision and session handling in the web app, which is more than M1 needs.

### Decision

- Models `User` (id, email, name) and `ApiToken` (userId, label, `tokenHash` unique, createdAt, lastUsedAt, revokedAt).
- Clients send `Authorization: Bearer <token>`. The server hashes the token with SHA-256 and looks it up by `tokenHash`. A
  missing, unknown or revoked token gets 401 `UNAUTHORIZED`.
- Plaintext tokens are never stored. The seed script upserts the dev user (`STUDIO_DEV_USER_EMAIL`) with the hash of
  `STUDIO_DEV_API_TOKEN` (at least 32 characters) and prints nothing secret.
- Every project and run query is scoped by `ownerId`. A foreign or missing id returns 404 `NOT_FOUND`.
- The rate limit is per token, and pino redacts the authorization header.
- SHA-256 instead of bcrypt or argon2: API tokens are long random secrets, not human-chosen passwords. At that entropy a fast
  hash is enough against offline guessing, and it allows a direct indexed lookup. Slow hashes exist to protect low-entropy
  passwords. The 32-character minimum checks length, not randomness, so tokens must come from a cryptographic random
  generator (for example `openssl rand -hex 32`).
- OIDC is planned for M8. API tokens stay for programmatic access after that.

### Consequences

- Per-user isolation and quotas exist from the first release. M8 changes how users sign in, not how data is scoped.
- M1 has no endpoints to create users or to issue or revoke tokens. The seed script covers the dev user; anything else needs
  direct database work ([ROADMAP.md](ROADMAP.md#known-gaps-carried-out-of-m1)).
- studio-web uses one configured token ([ADR-017](#adr-017-nextjs-accesses-the-api-server-side-only)), so one web deployment
  serves one user.
- Bearer tokens are only safe over TLS anywhere other than localhost.
- A leaked database contains no usable tokens.

### Alternatives considered

| Alternative | Why not |
|---|---|
| One shared admin key, as in campaigns | No per-user data scoping, quotas or revocation. |
| Username and password with sessions | Password storage, reset flows and email delivery are work that OIDC replaces in M8 anyway. |
| OIDC in M1 | Needs an identity provider to be chosen and run before the core product exists. |
| Signed JWTs | Revocation needs a deny list anyway, and a lookup by hash is simple at this scale. |

---

## ADR-016: Configurable resource limits instead of hardcoded duration caps

**Status:** Accepted · **Date:** 2026-10-09 · **Applies to:** `packages/schema` (`limits.ts`, `VideoRequestSchema`), `packages/ai-director`, `apps/studio-api`

### Context

- Requests range from 5 s to 2 h and more. What a deployment can afford depends on its budget, workers and provider rate
  limits, not on the product.
- A hardcoded maximum in the request schema would either block legitimate long videos or be too loose to protect anyone.
  Putting limits in the stored timeline schema would also make old data invalid when a deployment lowers a limit.

### Decision

- `VideoRequestSchema.durationSeconds` is a finite number greater than 0 with no maximum.
- `ResourceLimitsSchema` with these defaults (`DEFAULT_RESOURCE_LIMITS`):

  | Limit | Default | Env var in studio-api |
  |---|---|---|
  | `maxDurationSeconds` | 7200 | `LIMIT_MAX_DURATION_SECONDS` |
  | `maxWidth` / `maxHeight` | 3840 / 3840 | `LIMIT_MAX_WIDTH` / `LIMIT_MAX_HEIGHT` |
  | `maxFps` | 60 | `LIMIT_MAX_FPS` |
  | `maxScenes` | 2000 | `LIMIT_MAX_SCENES` |
  | `maxChapters` | 200 | `LIMIT_MAX_CHAPTERS` |
  | `maxPromptChars` | 20000 | `LIMIT_MAX_PROMPT_CHARS` |
  | `maxTracks` | 50 | none in M1 (default used) |
  | `maxAssets` | 500 | none in M1 (default used) |

- Limits are enforced at three points: on `POST /v1/projects` (`checkVideoRequestLimits`, 422 `LIMIT_EXCEEDED`), in the
  director before the first provider call (`LIMIT_EXCEEDED`), and after compilation (`checkTimelineLimits`).
- `GET /v1/system/config` returns the active limits, and the new-project form shows them.
- Cost controls are separate from resource limits: `LIMIT_DIRECTOR_RUNS_PER_DAY` (default 50) and `LIMIT_DIRECTOR_USD_PER_DAY`
  (default 25) per user return 429 `QUOTA_EXCEEDED`, and `RATE_LIMIT_PER_MINUTE` (default 300) applies per token.

### Consequences

- Raising the duration limit is a configuration change, not a code change. Requests longer than 2 hours need
  `LIMIT_MAX_DURATION_SECONDS` above 7200, and probably a higher `DIRECTOR_RUN_TIMEOUT_MS`
  ([ADR-010](#adr-010-chapter-chunked-generation-for-long-videos)).
- Structural bounds in the schemas still cap what any limit can allow: a prompt of at most 20 000 characters, even dimensions
  from 16 to 8192, and fps from 1 to 240. Raising `LIMIT_MAX_PROMPT_CHARS` above 20 000 has no effect, because the schema
  rejects longer prompts first.
- Lowering a limit does not invalidate stored timelines. A new director run on an existing project whose request exceeds the
  lowered limit fails with `LIMIT_EXCEEDED`.
- Limits apply per deployment, not per user or plan, until M8.
- The daily USD quota is based on estimated cost, which can under-count when pricing is unknown for a served model
  ([ADR-007](#adr-007-default-model-claude-opus-5-5-at-effort-medium-with-server-side-refusal-fallbacks)).

### Alternatives considered

| Alternative | Why not |
|---|---|
| A hardcoded maximum in the schema (for example 10 minutes) | Blocks the long-form use case. Every change is a code change and may invalidate stored data. |
| No limits | A single request could trigger hundreds of LLM calls, with no protection for a shared deployment. |
| Per-plan limits now | Needs organizations and billing (M8). |

---

## ADR-017: Next.js accesses the API server-side only

**Status:** Accepted · **Date:** 2026-10-09 · **Applies to:** `apps/studio-web`

### Context

- studio-web needs an API token. Anything in browser JavaScript or storage can be read by injected scripts and browser
  extensions, and `NEXT_PUBLIC_` variables are inlined into the client bundle.
- The campaigns panel has the user enter `ADMIN_API_KEY` in the browser.
- The Next.js App Router has Server Components, Server Actions and route handlers, which run on the server.

### Decision

- `src/lib/studio-api.ts` is server-only. It reads `STUDIO_API_URL` and `STUDIO_API_TOKEN` (never `NEXT_PUBLIC_` variables),
  validates every response with the `@vc/schema` DTO schemas, and throws typed errors.
- Pages fetch data in Server Components. Mutations (create a project, start a run, cancel, re-run) are Server Actions.
- Client-side run polling goes through the route handler `src/app/api/runs/[runId]/route.ts`, which calls the API on the
  server.
- Every page sets `export const dynamic = 'force-dynamic'`, so nothing calls the API at build time and `next build` (run by
  `pnpm build` in CI) does not need a running API.

### Consequences

- The token never reaches the browser, and the browser never talks to studio-api directly. In M1 the web app does not need
  CORS; `CORS_ORIGINS` remains configurable for other browser clients.
- Every request from studio-web acts as the one configured user, so anyone who can reach studio-web acts as that user. An M1
  studio-web deployment must not be exposed publicly without an authenticating proxy in front of it (PRD 7.3). OIDC in M8
  replaces the env token with per-user sessions.
- Polling takes an extra hop (browser, then Next.js server, then API).
- The studio-web server must be able to reach studio-api over the network.
- Server Actions are reachable over HTTP, so each one validates its own input. The new-project action validates with
  `VideoRequestSchema`.

### Alternatives considered

| Alternative | Why not |
|---|---|
| The browser calls the API with the token kept in browser storage (the campaigns panel pattern) | The token is readable by any script running on the page. |
| A `NEXT_PUBLIC_` token | Shipped in the JavaScript bundle to every visitor. |
| Per-user login in studio-web now | That is OIDC, planned for M8. |
| A static export with client-side fetching | The same exposure problem, and no server to hold the token. |
