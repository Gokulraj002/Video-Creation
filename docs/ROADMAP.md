# Roadmap

| | |
|---|---|
| Last updated | 2026-10-09 |
| Current milestone | **M1 Foundation (in progress)** |
| Related | [PRD.md](PRD.md) (requirements by milestone) · [DECISIONS.md](DECISIONS.md) (ADRs) |

Status legend: **In progress**: being built now. **Planned**: scoped, not started; nothing described under a planned milestone
exists in the code. Scope for M2 to M8 is a plan and may change. Changes are recorded here and, when they reverse a decision,
in [DECISIONS.md](DECISIONS.md).

## Overview

| Milestone | Theme | Status | Depends on |
|---|---|---|---|
| M1 | Foundation: schemas, AI Director, studio API, studio web, docs | **In progress** | Existing repo |
| M2 | Remotion 2D engine, render pipeline, basic editor | Planned | M1 |
| M3 | Assets and reference analysis | Planned | M1 |
| M4 | Voice and music | Planned | M2, M3 |
| M5 | 3D engine | Planned | M2, M3 |
| M6 | Generative video and footage | Planned | M2, M3 |
| M7 | Long-form at scale, editor v2, campaigns merge | Planned | M2, M4, M6 |
| M8 | Production hardening | Planned | M7 (parts can start earlier) |

```mermaid
flowchart LR
  M1["M1 Foundation<br/>IN PROGRESS"]
  M2["M2 Remotion 2D engine<br/>render pipeline, basic editor"]
  M3["M3 Assets and<br/>reference analysis"]
  M4["M4 Voice and music"]
  M5["M5 3D engine"]
  M6["M6 Generative video<br/>and footage"]
  M7["M7 Long-form at scale<br/>editor v2, campaigns merge"]
  M8["M8 Production hardening"]

  M1 --> M2
  M1 --> M3
  M2 --> M4
  M3 --> M4
  M2 --> M5
  M3 --> M5
  M2 --> M6
  M3 --> M6
  M2 --> M7
  M4 --> M7
  M6 --> M7
  M7 --> M8
  M1 -. "OIDC, observability<br/>can start early" .-> M8

  classDef active fill:#fde68a,stroke:#b45309,color:#111827;
  classDef planned fill:#e5e7eb,stroke:#6b7280,color:#111827;
  class M1 active;
  class M2,M3,M4,M5,M6,M7,M8 planned;
```

Why the edges exist:

- **M2 → M4, M5, M6, M7:** each of these produces content that has to be rendered, so all need the M2 render pipeline.
- **M3 → M4:** voice and music files need storage, and voice-over alignment reuses the M3 transcription adapter.
- **M3 → M5:** GLB uploads need storage and upload validation.
- **M3 → M6:** footage, image and screen scenes need uploaded assets; generated clips need storage.
- **M4 → M7:** editor v2 edits audio tracks, and campaigns depends on voice-over and ducked music.
- **M6 → M7:** campaigns appends a shared base video, which in studio terms is a footage scene.

## Workflow

- Each milestone is developed on its own branch and merged when its exit criteria are verified. The verification commands for
  each milestone are listed below.
- Exit criteria are checked by running the package scripts (`pnpm --filter <pkg> typecheck`, `test`, `build`) plus the manual
  checks listed for the milestone. CI must run the same commands.
- At milestone close, this file, [PRD.md](PRD.md) and any affected docs are updated so they describe the code that shipped.

---

## M1: Foundation

**Status: In progress.** Contract: the M1 implementation spec. Only the items below are M1.

### Scope

Build the Universal AI Video Studio beside the existing campaigns MVP, without modifying `apps/api`, `apps/worker`,
`apps/web`, `packages/core`, `packages/video` or `db/migrations`. Deliver the planning half of the product: prompt in, validated
director artifacts and a versioned timeline out, visible in a web UI with an animatic preview.

### Deliverables

| Path | Package | Contents |
|---|---|---|
| `packages/schema` | `@vc/schema` | Isomorphic Zod v4 schemas and types: common primitives (ids, hex colours, frames, safe URIs), render settings and `resolveDimensions`, frame math (`secondsToFrames`, largest-remainder `allocateFrames`, `formatTimecode`), assets, camera tracks and `expandCameraPreset`, transitions, 2D layers, scene content for 6 engines, scenes, chapters, brand kit, tracks, **Timeline v1** with invariants, resource limits, migrations, `ReferenceProfile` v1, director artifacts (LLM-safe), template catalog (14 templates), API DTOs. |
| `packages/ai-director` | `@vc/ai-director` | `AIProvider` interface; `HeuristicMockProvider` (default), `ScriptedMockProvider` (tests), `AnthropicProvider` (structured outputs, refusal fallbacks, typed error mapping, prompt-mode retry); `toStructuredOutputSchema`; pricing and usage tracking; content-hash cache (`MemoryDirectorCache`); `planStructure`; `AIDirector.planProject` and `regenerateScene`; repair loop and semantic validators; deterministic compiler; versioned prompts (`PROMPT_VERSION = 'm1.0'`). |
| `apps/studio-api` | `@vc/studio-api` | Fastify 5 API on port 4100; Prisma 7 schema and initial migration (`User`, `ApiToken`, `Project`, `ProjectVersion`, `DirectorRun`, `DirectorCacheEntry`); bearer-token auth; owner-scoped routes for health, me, system config, projects, director runs, versions, usage; quotas, limits, rate limit; BullMQ worker and inline queue; Prisma-backed director cache; seed script. |
| `apps/studio-web` | `@vc/studio-web` | Next.js 16 App Router on port 3000: dashboard, new-project form, project page (progress, cancel, re-run; tabs Storyboard, Preview (Remotion Player animatic), Brief, Script, Shot list, Timeline JSON, Usage), settings page; server-only API client; run-polling route handler; loading, error and not-found states. |
| `docs/` | — | PRD, ARCHITECTURE, AI_DIRECTOR, TIMELINE_SCHEMA, DATABASE, ROADMAP, DECISIONS, DEVELOPMENT. |

Also part of M1: the repository moved from npm workspaces to a pnpm workspace
([ADR-001](DECISIONS.md#adr-001-pnpm-workspace-monorepo-migrated-from-npm-workspaces)).

### Explicitly not in M1

| Not in M1 | Where it lands |
|---|---|
| Rendering to MP4 or any export | M2 |
| Template render components (the preview is an animatic of branded cards) | M2 (2D), M5 (3D) |
| Editing scenes, text or colours; reordering; versions UI | M2 |
| HTTP endpoint or UI for regenerating one scene (the library function `regenerateScene` exists and is tested) | M2 |
| Uploads, storage, reference analysis (`ReferenceProfile` schema exists, nothing produces profiles) | M3 |
| Text-to-speech, music, audio mixing (voice-over text and a derived caption track exist in the timeline) | M4 |
| 3D rendering (3D scenes can be planned and appear as animatic cards) | M5 |
| Video-generation providers, and footage/image/screen engines (reported unavailable; the director coerces such choices to motion2d with a warning) | M6 |
| Login UI, teams, billing | M8 |

### Exit criteria and verification

To be ticked at M1 close. Nothing is ticked yet because M1 is in progress.

- [ ] `pnpm --filter @vc/schema typecheck` and `pnpm --filter @vc/schema test` pass. Tests cover `resolveDimensions` examples,
      `allocateFrames` (exact sums, minimums, tie-breaking, `RangeError`), every timeline invariant with a precise error path,
      `SafeUriSchema` rejections, limits, and migrations with an injected fake v0→v1 migration.
- [ ] `pnpm --filter @vc/ai-director typecheck` and `test` pass with no network access. Tests cover: LLM-facing schema fixtures
      (valid and invalid); `toStructuredOutputSchema` stripping unsupported keywords and closing objects; the full pipeline with
      `HeuristicMockProvider` for genres × {5 s, 30 s, 10 min, 25 min, 2 h} (valid timeline, exact frame sums, chunked
      chapters, scene counts in range); repair success and exhaustion (`VALIDATION_FAILED`); a second identical run making 0
      provider calls; cost maths; the engine-coercion warning; `regenerateScene` leaving other scenes and timing identical;
      cancellation; `LIMIT_EXCEEDED` before any provider call; `AnthropicProvider` request shape (model,
      `output_config.effort`/`format`, system `cache_control`, `betas` + `fallbacks`, no `thinking` or `temperature`) and
      response handling (text extraction, usage mapping, refusal, `max_tokens`, BadRequest → prompt-mode retry) against an
      injected fake client.
- [ ] `pnpm --filter @vc/studio-api typecheck` and `test` pass against the `video_studio_test` database (migrated with
      `prisma migrate deploy`). Tests cover: health; 401 without a token and with a bad token; project CRUD; 400 validation;
      422 limits; owner isolation (404); a director run end to end producing version 1 with a timeline that re-parses with
      `TimelineSchema` and usage; a second run producing version 2 with cache hits and 0 new tokens; 409 on a concurrent run;
      cancel; 429 quota; provider failure recorded as run `FAILED` with a code; system config containing no secrets.
- [ ] The initial Prisma migration SQL is committed under `apps/studio-api/prisma/migrations`.
- [ ] `pnpm --filter @vc/studio-web typecheck`, `test` (pure helpers: duration formatting and parsing, form → `VideoRequest`
      mapping) and `build` pass.
- [ ] Manual check with `AI_PROVIDER=mock` and `QUEUE_DRIVER=bullmq`: run the API, worker and web app; create a project; watch
      progress; open every tab; play the animatic; cancel a run; re-run and see cached calls in Usage.
- [ ] Optional manual check with `AI_PROVIDER=anthropic` and a real key: one short run, with usage and cost shown. This is not
      part of CI.
- [ ] The campaigns MVP still typechecks, and its existing tests pass, under the pnpm workspace.
- [ ] Docs describe the shipped code and label everything else as planned.

### Dependencies

None beyond the existing repo, Postgres 16 and Redis 7 (`docker-compose.yml`).

### Risks

- Live Claude behaviour (validity rate, refusals, latency, cost) is not covered by CI. Mitigations: repair loop, prompt-mode
  fallback, refusal fallbacks, and a manual live check.
- The animatic could be mistaken for final output. Mitigation: the UI labels it as a preview and labels mock mode.

---

## M2: Remotion 2D engine, render pipeline and basic editor

**Status: Planned.** Depends on M1.

### Scope

Remotion 2D engine and render pipeline: template components, frame-range segment rendering, FFmpeg assembly, render queue with
progress and cancel, export validation. Basic editor: scene list and reorder, text and colour edits, regenerate-scene endpoint
and UI, project versions UI.

### Planned deliverables

- Remotion components for all 11 motion2d templates, driven by timeline props, layers, cameras and transitions.
- Render jobs (queue abstraction from [ADR-014](DECISIONS.md#adr-014-queue-abstraction-bullmq-with-an-inline-driver-for-tests)),
  rendering frame-range segments with identical encoder settings, assembled with FFmpeg concat, audio muxed.
- Render progress, cancellation, per-segment retry, render timeouts, temp-file cleanup.
- Export validation with ffprobe (duration within 1 frame of `durationInFrames / fps`, fps, dimensions, codecs, streams).
- Render outputs written through a storage interface (local disk driver first; the S3-compatible driver arrives in M3).
- Editor: scene list, reorder (frames re-allocated by the compiler), text and colour edits validated against each template's
  props schema, regenerate one scene (`POST` endpoint wrapping `AIDirector.regenerateScene`), and a versions list and viewer.
  Every edit saves a new immutable version.

### Exit criteria and verification

- A 30 s 16:9 1080p motion2d timeline renders to a validated MP4.
- A 10 min timeline renders in segments with peak worker memory independent of length (measured and recorded).
- Killing one segment's render causes only that segment to retry. Cancelling mid-render stops the work and removes temp files.
- Each motion2d template has a still-frame render test at fixed frames.
- Reordering and editing produce new versions that re-parse with `TimelineSchema`. Regenerating a scene leaves the other scenes
  byte-identical.

---

## M3: Assets and reference analysis

**Status: Planned.** Depends on M1.

### Scope

S3/MinIO storage; uploads with size checks and MIME sniffing; ffprobe metadata; keyframe and scene sampling; palette;
transcription adapter; camera-movement classification; `ReferenceProfile` generation; Claude vision on sampled frames.

### Planned deliverables

- S3-compatible storage driver (S3, MinIO, R2). MinIO added to local development.
- Upload endpoints with configurable size limits, MIME sniffing from content, and `asset://` references in timelines.
- Analysis jobs: ffprobe metadata, scene detection, keyframe sampling (downscaled stills), audio extraction, transcription
  adapter (mock by default), palette extraction, typography/transition/camera-movement classification, pacing.
- `ReferenceProfile` v1 produced and validated, then passed to the director.
- Claude vision on sampled frames, metadata and transcript only. Raw video is never sent to the model.
- New-project form: reference uploads and a brand logo.

### Exit criteria and verification

- An upload with a mismatched extension or declared type is rejected. Oversize uploads are rejected before they are fully read.
- A sample reference video yields a `ReferenceProfile` that passes the schema, and a `reference-based` run uses its pacing.
- Tests assert that requests to the provider contain image blocks and text only, with no video payload.
- Temp files from analysis are removed on success, failure and cancellation.

---

## M4: Voice and music

**Status: Planned.** Depends on M2 and M3.

### Scope

TTS and music provider adapters, voice-over alignment, word-timed captions, ducking, loudness normalization.

### Planned deliverables

- TTS and music adapters behind provider interfaces (mock by default; real providers only when configured).
- Voice-over alignment producing word timestamps; caption cues re-timed from them, replacing M1's proportional cues.
- Music ducking under voice and loudness normalization in the render pipeline. The campaigns worker already uses sidechain
  ducking and -16 LUFS voice normalization, and that can be reused.
- A decided policy for reconciling voice-over length with scene durations (PRD open question Q7).

### Exit criteria and verification

- A rendered export with voice-over and music passes loudness checks against the chosen target, and word-timed captions line
  up with the audio within a tested tolerance.
- With no TTS provider configured, the system reports it as unavailable and still renders.

---

## M5: 3D engine

**Status: Planned.** Depends on M2 and M3.

### Scope

React Three Fiber, `@remotion/three` and Drei; GLB uploads; camera presets.

### Planned deliverables

- Components for `product-turntable`, `logo-reveal-3d` and `floating-shapes`, rendered deterministically from the frame number
  (no wall-clock or random state).
- 3D camera tracks from `expandCameraPreset` (orbit, dolly, crane, push-in) applied in render.
- GLB uploads (validated and size-limited) bound through `three.modelAssetId`.
- Environment and lighting presets as defined by the timeline schema.

### Exit criteria and verification

- Each 3D template renders headless in the worker, and a still-frame test at fixed frames passes.
- An uploaded GLB replaces the primitive in `product-turntable`.

---

## M6: Generative video and footage

**Status: Planned.** Depends on M2 and M3.

### Scope

Provider adapters (for example Runway, Kling, Pika; not connected until configured), async jobs, cost controls; footage, screen
and image engines.

### Planned deliverables

- A video-generation provider interface. Each adapter reports itself available only when credentials are configured and a
  health check passes. A mock provider is used for tests.
- Async generation jobs: a `generated` scene goes `pending` → `queued` → `ready` (with an asset) or `failed`. Polling or
  webhooks; timeouts; cancellation.
- Cost controls: a per-job estimate, per-user daily caps, and explicit confirmation before expensive jobs.
- Footage, image and screen engines: trim, playback rate, fit, Ken Burns/zoom/pan/parallax, zoom regions, cursor highlight.
- Engine availability computed from configuration and assets instead of static M1 values.

### Exit criteria and verification

- With no provider configured, `generated` is reported unavailable and the director coerces such choices to motion2d (already
  M1 behaviour, re-verified).
- With the mock video provider, a timeline containing generated scenes completes end to end, and failed jobs leave a scene
  that can be retried.
- A footage scene renders from an uploaded clip.

---

## M7: Long-form at scale, editor v2, campaigns merge

**Status: Planned.** Depends on M2, M4 and M6.

### Scope

Distributed chapter/segment rendering, resumable renders, validation beyond 20 minutes, editor v2 (tracks, transitions, audio),
and the campaigns MVP merged as a module.

### Planned deliverables

- Chapter and segment render jobs fanned out across workers. Completed segments are persisted so a render can resume after a
  crash without redoing them.
- End-to-end validation of long exports (25 min and 2 h test cases): duration, A/V sync at the end of the file, chapter
  boundaries.
- Editor v2: multi-track editing (overlay, audio, video), transition editing, audio levels and fades. If this needs gaps or
  overlaps on the scene track, it becomes timeline schema v2 with a migration
  ([ADR-011](DECISIONS.md#adr-011-integer-frames-and-a-versioned-timeline-with-migrations)).
- Campaigns as a studio module: a campaign binds CSV variables into a studio project or template, renders per contact through
  the studio pipeline, and sends via WhatsApp. One auth system; campaign data migrated; old campaigns apps retired after
  regression tests pass.

### Exit criteria and verification

- A 25-minute render completes after a worker is killed midway, without re-rendering segments that had already finished.
- A 2-hour export passes validation. *Target:* A/V drift of at most 1 frame at the end.
- The campaigns flows (CSV import, per-contact render, dry-run send, status webhooks) pass regression tests on the merged
  module.

---

## M8: Production hardening

**Status: Planned.** Depends on M7. OIDC and observability work can start earlier.

### Scope

OIDC auth, teams, billing and quotas, observability, sandboxed workers, backups, CDN.

### Planned deliverables

- OIDC login with sessions in studio-web, replacing the single server-side token. API tokens remain for programmatic access
  ([ADR-015](DECISIONS.md#adr-015-m1-auth-is-hashed-per-user-bearer-tokens-oidc-in-m8)).
- Organizations and teams with roles; project sharing.
- Billing, plans and per-plan quotas, replacing the deployment-wide env limits.
- Metrics, tracing, dashboards and alerting (queue depth, run and render failure rates, cost).
- Render and analysis workers in sandboxes (isolated containers, no outbound network by default, restricted filesystem).
- Postgres backups with tested restores; object-storage versioning; CDN for delivery.

### Exit criteria and verification

- Security review completed. A restore drill succeeds. A load test at the agreed target passes. Quotas are enforced per plan.

---

## Known gaps carried out of M1

These were found while writing M1 and are not part of any milestone's scope above. Each needs an owner.

| Gap | Impact | Suggested handling |
|---|---|---|
| `.github/workflows/ci.yml` still runs `npm ci`, `npm run typecheck`, `npm test`, `npm run build:web`, but `package-lock.json` has been removed and the root scripts changed in the pnpm migration | CI fails until it is updated to pnpm (`pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm build`) | Fix at M1 close |
| The root `README.md` documents the campaigns MVP with npm commands | Wrong setup instructions | Update alongside DEVELOPMENT.md |
| A worker crash can leave a director run `RUNNING`. Processing skips non-`QUEUED` runs, so a redelivered job does nothing. | The project stays blocked with 409 `RUN_ACTIVE` until the user cancels | Stale-run reaper (heartbeat or `startedAt` + timeout). M2 candidate |
| `DirectorCacheEntry` has no eviction or TTL, and the cache is shared across users | Unbounded growth; a cache hit reveals that someone submitted an identical request | PRD Q5. M8 at the latest |
| The cache key covers the prompt text and schema name, not the schema body | Changing an LLM-facing schema without bumping `PROMPT_VERSION` can serve stale cached outputs | Rule: bump `PROMPT_VERSION` on any prompt or LLM-facing schema change |
| studio-web acts as one configured API user | Must not be exposed publicly without an authenticating proxy | Documented. Fixed by OIDC in M8 |
| No live-provider evaluation runs automatically | Prompt or model regressions are invisible to CI | PRD Q15 |
