# Video Creation

This monorepo holds two products:

| Product | Status | What it does |
|---|---|---|
| **Universal AI Video Studio** | Milestone 1 (foundation) | Prompt + references → AI Director (Claude) → brief, script, storyboard, shot list → validated, frame-accurate timeline. Rendering, assets, voice, 3D and generative video arrive in later milestones ([ROADMAP](docs/ROADMAP.md)). |
| **Campaigns MVP** | Working | Personalized WhatsApp video campaigns: CSV → one rendered video per contact → WhatsApp template send. See [docs/CAMPAIGNS.md](docs/CAMPAIGNS.md). |

## Universal AI Video Studio

```
Next.js web (studio-web) ──server-side──▶ Fastify API (studio-api) ──▶ Postgres (Prisma)
                                              │
                                              └─ BullMQ ──▶ director worker ──▶ AI Director (@vc/ai-director)
                                                                                  ├─ mock provider (default, no credits)
                                                                                  └─ Claude API (claude-opus-5-5)
                                                       output: DirectorArtifacts + Timeline v1 (@vc/schema)
```

| Path | Package | Role |
|---|---|---|
| `packages/schema` | `@vc/schema` | Zod v4 schemas shared by every app: Universal Timeline v1, ReferenceProfile, director artifacts, template catalog, API DTOs, frame math, limits, migrations |
| `packages/ai-director` | `@vc/ai-director` | AI Director pipeline, provider adapters (heuristic mock, scripted mock, Anthropic), validation/repair, caching, token + cost tracking, timeline compiler |
| `apps/studio-api` | `@vc/studio-api` | Fastify API, Prisma/Postgres, BullMQ director worker, auth, quotas |
| `apps/studio-web` | `@vc/studio-web` | Next.js App Router dashboard: projects, prompt-to-storyboard flow, storyboard + Remotion animatic preview |
| `docs/` | | [PRD](docs/PRD.md) · [Architecture](docs/ARCHITECTURE.md) · [AI Director](docs/AI_DIRECTOR.md) · [Timeline schema](docs/TIMELINE_SCHEMA.md) · [Database](docs/DATABASE.md) · [Roadmap](docs/ROADMAP.md) · [Decisions](docs/DECISIONS.md) · [Development](docs/DEVELOPMENT.md) |

### Quick start

Requires Node 22+, pnpm 10 (`corepack enable`), and Docker (or a local Postgres 16 + Redis 7).

```bash
pnpm install
docker compose up -d                      # Postgres (+ video_studio DBs) and Redis
cp apps/studio-api/.env.example apps/studio-api/.env
cp apps/studio-web/.env.example apps/studio-web/.env.local
pnpm studio:db:migrate
pnpm studio:db:seed                       # dev user + API token from STUDIO_DEV_API_TOKEN
pnpm studio:dev:api                       # http://localhost:4100
pnpm studio:dev:worker                    # director jobs
pnpm studio:dev:web                       # http://localhost:3000
```

The AI Director runs on the built-in **mock provider by default**, so the whole flow works without spending Claude credits. To use Claude, set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` in `apps/studio-api/.env`. Every variable is documented in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

### Checks

```bash
pnpm typecheck
pnpm test        # AI calls are mocked; API tests use the video_studio_test database
pnpm build
```
