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
| `packages/ai-director` | `@vc/ai-director` | AI Director pipeline, provider adapters (heuristic mock, scripted mock, Anthropic), validation/repair, caching, token + cost tracking, run cost ceilings, timeline compiler |
| `apps/studio-api` | `@vc/studio-api` | Fastify API, Prisma/Postgres, BullMQ director worker and stale-run reaper, auth, rate limits, quotas |
| `apps/studio-web` | `@vc/studio-web` | Next.js App Router dashboard: projects, prompt-to-storyboard flow, storyboard + Remotion animatic preview |
| `docs/` | | [PRD](docs/PRD.md) · [Architecture](docs/ARCHITECTURE.md) · [AI Director](docs/AI_DIRECTOR.md) · [Timeline schema](docs/TIMELINE_SCHEMA.md) · [Database](docs/DATABASE.md) · [Roadmap](docs/ROADMAP.md) · [Decisions](docs/DECISIONS.md) · [Development](docs/DEVELOPMENT.md) |

### Quick start

Requires Node 22+, pnpm 10 (`corepack enable`), Docker (or a local Postgres 16 + Redis 7) and `openssl`.

```bash
pnpm install                              # also generates the Prisma client (postinstall)
docker compose up -d                      # Postgres (+ video_studio DBs) and Redis
cp apps/studio-api/.env.example apps/studio-api/.env
cp apps/studio-web/.env.example apps/studio-web/.env.local

# Development API token: the API seed and the web app must use the SAME value (at least 32 characters)
TOKEN=$(openssl rand -hex 32)
sed -i.bak "s/^STUDIO_DEV_API_TOKEN=.*/STUDIO_DEV_API_TOKEN=$TOKEN/" apps/studio-api/.env && rm apps/studio-api/.env.bak
sed -i.bak "s/^STUDIO_API_TOKEN=.*/STUDIO_API_TOKEN=$TOKEN/" apps/studio-web/.env.local && rm apps/studio-web/.env.local.bak

pnpm studio:db:migrate                    # prisma migrate deploy (reads DATABASE_URL from apps/studio-api/.env)
pnpm studio:db:seed                       # dev user + the sha256 hash of STUDIO_DEV_API_TOKEN
pnpm studio:db:seed:demo                  # optional: 4 sample projects with storyboards + previews (mock, no credits)
pnpm studio:dev:api                       # http://localhost:4100  (GET /health, GET /ready)
pnpm studio:dev:worker                    # director jobs + stale-run reaper
pnpm studio:dev:web                       # http://127.0.0.1:3000
```

Projects live in your local Postgres database, not in git, so a fresh clone starts with an empty dashboard.
`pnpm studio:db:seed:demo` adds four sample projects (a Kerala travel reel, a real-estate promo, a SaaS explainer and a
3-minute SOP training video) by running the real director pipeline on the mock provider. It is safe to re-run: existing
titles are skipped. Milestone 1 previews each plan as an in-browser animatic; MP4 rendering arrives in Milestone 2.

Without the token step the seed fails (`STUDIO_DEV_API_TOKEN: required by the seed script`) and every web page shows
"not configured". You can also edit the two files by hand: `STUDIO_DEV_API_TOKEN` in `apps/studio-api/.env` and the same
value as `STUDIO_API_TOKEN` in `apps/studio-web/.env.local`. The web dev server binds `127.0.0.1` only (`next dev -H 127.0.0.1`),
because in M1 anyone who can reach studio-web acts as the token's user. Keep it behind an authenticating proxy if you change that.

The AI Director runs on the built-in **mock provider by default**, so the whole flow works without spending Claude credits. To use Claude, set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` in `apps/studio-api/.env`, and check the daily spend cap first: with the default `LIMIT_DIRECTOR_USD_PER_DAY=25`, a run whose cost ceiling exceeds $25 is refused before it starts (on `claude-opus-5-5`, about one hour of `long-form` video; a 2 h video needs a higher limit). Every variable is documented in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

### Checks

```bash
pnpm typecheck
pnpm test        # AI calls are mocked; API tests use the video_studio_test database
pnpm build
```
