# Universal AI Video Studio: Product Requirements (PRD)

| | |
|---|---|
| Document status | Living document. Revised at each milestone close. |
| Last updated | 2026-10-09 |
| Current milestone | **M1 Foundation (in progress)**. See [ROADMAP.md](ROADMAP.md). |
| Related | [ROADMAP.md](ROADMAP.md) · [DECISIONS.md](DECISIONS.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [AI_DIRECTOR.md](AI_DIRECTOR.md) · [TIMELINE_SCHEMA.md](TIMELINE_SCHEMA.md) · [DATABASE.md](DATABASE.md) · [DEVELOPMENT.md](DEVELOPMENT.md) |

Every requirement in this document has a target milestone. **Only items marked M1 are in scope for the code being built now.**
Items marked M2 to M8 are planned and do not exist yet. Where M1 ships only part of a capability (for example a schema with
nothing producing data for it yet), the requirement says so.

---

## 1. Summary

The Universal AI Video Studio is a web app that turns a written request (and, from M3, uploaded reference material) into a
structured, editable, renderable video project. One request contract covers many kinds of video: ads, training, cartoons, motion
graphics, 3D product shots, real-estate promos, explainers, social shorts and long-form. Duration ranges from a few seconds to
20+ minutes. No maximum is hardcoded; deployments set resource limits instead.

An **AI Director** (Anthropic Claude, model `claude-opus-5-5` by default) plans the video in stages: creative brief, outline, script,
storyboard, shot list, engine selection, scene specs. Every stage's output is JSON that is validated before anything uses it. A
deterministic compiler then turns the plan into a **versioned timeline** made of integer frames. The timeline is the single
interchange format for the preview, the editor and the renderers. The LLM never writes code. It fills the props of a fixed,
reviewed template catalog.

The repository also contains a separate, working product: the **WhatsApp personalized-video campaigns MVP** (`apps/api`,
`apps/worker`, `apps/web`, `packages/core`, `packages/video`). It is unchanged by M1 and is planned to merge into the studio as a
module in M7 ([ADR-002](DECISIONS.md#adr-002-build-the-studio-beside-the-campaigns-mvp-merge-in-m7)).

## 2. Problem

Teams that need video across several formats face these problems today:

1. **Each format needs its own tool and skill set.** Motion graphics, 3D product renders, screen-recorded SOPs, cartoon sketches
   and talking-point explainers each use different software and different specialists. Small teams cannot staff all of them.
2. **Generative video tools are clip generators, not productions.** They produce seconds of footage per prompt and give little
   control over structure (chapters, scene order, timing), brand consistency, or edits after generation. A 20-minute training
   module cannot be produced by stitching prompts by hand.
3. **Templates are rigid.** Template-based editors are fast for a single genre but do not plan the content. Someone still has to
   write the script, break it into scenes and decide pacing.
4. **AI output is hard to trust and hard to edit.** When a model produces an opaque final video, a wrong scene means regenerating
   everything. Costs are often invisible until the bill arrives.
5. **Long videos are operationally hard.** Rendering 20+ minutes in one process is slow and memory-heavy, and when it fails it
   fails as a whole.

The studio addresses these with one pipeline: plan with an LLM, validate everything, compile deterministically, render with
specialised engines, and keep every intermediate artifact visible and editable.

## 3. Target users and personas

| # | Persona | Typical videos | What they need most | First milestone that serves them meaningfully |
|---|---|---|---|---|
| P1 | Brand / marketing lead at a small or mid-size company | Cinematic ads, promos, social shorts | Fast on-brand drafts in several aspect ratios, visible cost | M1 plans and previews; M2 exports |
| P2 | L&D or operations manager | SOP and corporate training, 5 to 30+ min | Step-by-step structure, long durations, consistency across chapters, captions, cheap edits when a procedure changes | M1 plans long videos; M2 exports; M4 adds voice and word-timed captions |
| P3 | Real-estate marketer or agent | Property promos | Listing details turned into a promo; their own photos and footage | M1 (text-only `property-showcase`); M3 uploads; M6 image and footage engines |
| P4 | Educator or presenter | Explainers, presentations, long-form lessons | Clear structure, readable text scenes, chaptering | M1 plans; M2 exports |
| P5 | Social creator or agency editor | Reels and Shorts, comedy and cartoon, "make it like this reference" | Pacing, hooks, reference-driven style | M1 plans; M3 reference analysis |
| P6 | Product marketer (hardware, e-commerce) | 3D product animations with camera moves | Turntables, logo reveals, their own GLB models | M1 plans 3D scenes (animatic preview only); M5 renders them |
| P7 | Operator / developer self-hosting the studio | All | Env-based configuration, mock mode, honest capability reporting, cost limits, logs | M1 |
| P8 | Campaign operator (existing WhatsApp MVP) | Personalized per-contact videos | Keep current flows working | Today (campaigns app); merged into the studio in M7 |

## 4. Goals and non-goals

### 4.1 Product goals

- **G1. One request contract for every genre and duration.** The `VideoRequest` schema covers all genres, aspect ratios,
  resolutions, fps, language, brand, voice and music intent, and references. Duration has no schema maximum.
- **G2. Planning that is structured and inspectable.** Every director artifact (brief, outline, script, storyboard, shot list,
  engine selection, scene specs) is validated, stored and shown to the user.
- **G3. A deterministic, versioned timeline as the only interchange format** between the director, preview, editor and renderers.
- **G4. Multi-engine production with honest availability.** Engines (2D motion, 3D, footage, image, screen, generated video) are
  enabled only when they actually work in the deployment. Unavailable engines are reported with a reason and never presented as
  connected.
- **G5. Transparent, controllable cost.** Tokens and estimated USD are tracked for every stage and every run. Daily quotas and
  resource limits are configurable.
- **G6. Safe by construction.** No LLM-generated code is executed. Secrets stay server-side. Every data access is scoped to the
  owner.
- **G7. Works end to end without paid services.** A deterministic mock provider is the default, so development, CI and demos
  need no API key and spend no credits.

### 4.2 M1 goals (what "done" means now)

- The four M1 packages exist and pass their own typecheck and tests: `@vc/schema`, `@vc/ai-director`, `@vc/studio-api`,
  `@vc/studio-web`. `@vc/studio-web` also builds.
- A user can create a project in the web UI, watch a director run progress, and inspect the storyboard, brief, script, shot list,
  timeline JSON and per-stage usage. They can also play an **animatic** (branded cards per scene, not final rendering) in the
  Remotion Player.
- Planning works for every genre at durations from 5 s to 2 h with the mock provider. It works with Claude when
  `AI_PROVIDER=anthropic` and a key are configured.
- These docs describe what ships and mark everything else as planned.

### 4.3 Non-goals

- **Executing LLM-generated code** of any kind (React, Remotion, shaders, scripts). LLM output is data only
  ([ADR-009](DECISIONS.md#adr-009-fixed-template-catalog-with-per-template-zod-props-never-llm-generated-code)).
- **Sending raw video to Claude.** From M3, Claude receives sampled frames, metadata and transcripts only.
- **Hardcoded duration caps.** Limits are configuration ([ADR-016](DECISIONS.md#adr-016-configurable-resource-limits-instead-of-hardcoded-duration-caps)).
- **Claiming integrations that are not configured.** No provider is shown as connected unless its credentials are configured.
- **Feature parity with a professional NLE** (Premiere, Resolve). The editor targets structured edits: scenes, text, colours,
  regeneration (M2), then tracks, transitions and audio (M7).
- **Training or hosting our own foundation models** within M1 to M8. The provider interface leaves room for local-model adapters
  later, but none is scheduled.
- **Real-time multi-user co-editing, native mobile apps, and direct publishing to social platforms** (other than WhatsApp through
  the campaigns module). None of these is on the roadmap.
- **A stock-media marketplace.** `AssetRef.source` allows `'stock'`, but no stock provider is planned.

## 5. Supported video types

Genres are the values of `VideoGenreSchema`. Target scene length drives scene count in planning (`planStructure`). The template
column is illustrative. The authoritative genre tags live in `packages/schema/src/templates/`.

| Genre id | Typical use | Target scene length | Likely M1 templates (illustrative) | Engines that matter |
|---|---|---|---|---|
| `cinematic-ad` | Brand ad, launch teaser | 3 s | `title-card`, `kinetic-text`, `split-feature`, `cta-end-card` | motion2d (M2), three (M5), generated (M6) |
| `promo` | Offer or event promo | 3.5 s | `title-card`, `stat-counter`, `split-feature`, `cta-end-card` | motion2d |
| `sop-training` | Standard operating procedure | 9 s | `step-instruction`, `bullet-list`, `lower-third` | motion2d, screen (M6) |
| `corporate-training` | Policy and compliance modules | 10 s | `title-card`, `bullet-list`, `quote`, `step-instruction` | motion2d |
| `comedy` | Sketches, gags | 4 s | `cartoon-scene`, `kinetic-text` | motion2d |
| `cartoon` | Character-driven short | 4 s | `cartoon-scene` | motion2d |
| `motion-graphics` | Professional 2D motion design | 4 s | `kinetic-text`, `stat-counter`, `title-card` | motion2d, three (`floating-shapes`) |
| `product-3d` | Product turntable, camera moves | 5 s | `product-turntable`, `logo-reveal-3d`, `cta-end-card` | three (M5) |
| `real-estate` | Property promo | 5 s | `property-showcase`, `split-feature`, `cta-end-card` | motion2d; image and footage (M6) |
| `explainer` | Concept explainer | 7 s | `title-card`, `bullet-list`, `split-feature` | motion2d |
| `presentation` | Slide-style talk | 10 s | `title-card`, `bullet-list`, `quote` | motion2d |
| `social-short` | Reels, Shorts, TikTok | 2.5 s | `kinetic-text`, `title-card`, `cta-end-card` | motion2d |
| `long-form` | 20+ minute videos | 12 s | `title-card`, `bullet-list`, `split-feature`, `lower-third` | motion2d, others as available |
| `reference-based` | "Inspired by this example" | 5 s, or the reference's average shot length clamped to 1.5 to 20 s | chosen to match the reference | depends on the reference; analysis arrives in M3 |

In M1, `reference-based` can be selected, but no reference analysis exists yet. These requests are planned from the prompt and
style notes only, with the 5 s default pacing.

## 6. Functional requirements

IDs are stable and may be cited in issues and pull requests. "Milestone" is the milestone in which the requirement is planned
to be met. M1 rows describe what M1 delivers; everything else is planned.

### 6.1 Project dashboard (DASH)

| ID | Requirement | Milestone |
|---|---|---|
| DASH-1 | List the user's projects, most recently updated first, with cursor pagination. Show title, status (`draft`, `directing`, `ready`, `failed`), genre, duration, aspect ratio and current version. | M1 |
| DASH-2 | Stat cards: number of projects (the API's `total` over all pages), director runs today with today's estimated cost, tokens and estimated cost this month. | M1 |
| DASH-3 | Empty state that leads to creating the first project. | M1 |
| DASH-4 | Delete a project. Refused with 409 while a director run is queued or running. | M1 (API) |
| DASH-5 | Render/export status and thumbnails per project. | M2 |
| DASH-6 | Team and shared projects. | M8 |
| DASH-7 | Search, filters, folders. | Not scheduled |

### 6.2 Video creation interface (CREATE)

| ID | Requirement | Milestone |
|---|---|---|
| CREATE-1 | Form fields: title (1 to 200 chars), prompt (up to the lower of `LIMIT_MAX_PROMPT_CHARS` and the schema's 20 000), genre (14 values), style notes (up to 2 000). Title and prompt are trimmed and must contain a visible character. An invalid submit focuses the first invalid field and shows one summary alert. | M1 |
| CREATE-2 | Duration entered as a value plus unit (s, min, h), with one decimal separator (`.` or `,`); ambiguous thousands forms such as `1,000` and absurdly large numbers are rejected. No hardcoded maximum. The form shows the configured limit from `GET /v1/system/config`, and the API rejects requests above it with 422 `LIMIT_EXCEEDED`. | M1 |
| CREATE-3 | Aspect ratio (9:16, 16:9, 1:1, 4:5, custom W×H with even dimensions from 16 to 8192), resolution (480p to 2160p or custom), fps (schema 1 to 240, default 30, capped by `LIMIT_MAX_FPS` whose default is 60), language (BCP-47, default `en`). A custom resolution with a preset aspect ratio must match that ratio within ±1 px per side; a custom aspect ratio uses the custom W×H and ignores the resolution preset. | M1 |
| CREATE-4 | Brand name and up to 5 colour inputs in the M1 form. The API contract additionally accepts up to 8 colours, heading and body fonts, and a logo asset id. | M1 |
| CREATE-5 | Voice-over (toggle, style, gender) and music (toggle, mood). In M1 these set intent only: voice-over text is scripted and a caption track is derived from it. No audio is generated until M4. | M1 (intent) / M4 (audio) |
| CREATE-6 | On submit: validate with `VideoRequestSchema` in a Server Action, create the project, start a director run, redirect to the project page. | M1 |
| CREATE-7 | Upload reference files (video, image, document, audio, script) and attach up to 20 to a request (`referenceAssetIds`). The field already exists in the M1 contract, but M1 has no upload path. | M3 |
| CREATE-8 | Brand logo upload. | M3 |

### 6.3 Reference analysis engine (REF)

| ID | Requirement | Milestone |
|---|---|---|
| REF-1 | `ReferenceProfile` v1 schema: technical metadata, scenes with keyframe asset ids, shot type, camera movement and dominant colours, palette (up to 16), typography, transitions, pacing, transcript, audio traits, style summary, mood tags, warnings. | M1 (schema only; nothing produces profiles yet) |
| REF-2 | The director accepts reference profiles, wraps them as untrusted data in prompts, and uses `pacing.averageShotSeconds` for `reference-based` pacing. | M1 (library level) |
| REF-3 | Metadata extraction with ffprobe (duration, dimensions, fps, codecs, audio presence, size). | M3 |
| REF-4 | Scene/shot boundary detection and keyframe sampling. | M3 |
| REF-5 | Audio extraction and transcription through a provider adapter (mock by default). | M3 |
| REF-6 | Palette extraction; classification of typography, transitions and camera movement; pacing (average shot length, cuts per minute). | M3 |
| REF-7 | Claude vision on sampled, downscaled frames plus metadata and transcript. **Claude never receives the raw video file.** | M3 |
| REF-8 | Analysis runs as a queued, cancellable job with size limits and temp-file cleanup. | M3 |

### 6.4 AI Director pipeline (DIR)

| ID | Requirement | Milestone |
|---|---|---|
| DIR-1 | Pipeline: check limits, then brief, outline, and per chapter script, storyboard, shot list, engine selection, scene specs, then a deterministic compile (no LLM). Total steps = 2 + 5 × chapters + 1. | M1 |
| DIR-2 | Scene count adapts to duration and genre: expected = round(duration / target scene seconds), range ±25 %, at least 1 s per scene, at most `LIMIT_MAX_SCENES`. | M1 |
| DIR-3 | Long videos are generated chapter by chapter. Videos over 120 s get `max(ceil(duration / 300), ceil(expectedScenes / 24))` chapters, capped by `LIMIT_MAX_CHAPTERS`. Each chapter receives the previous chapter's title and summary for continuity. | M1 |
| DIR-4 | Every LLM output is checked with Zod and then a stage-specific semantic validator. Failures are re-requested as fresh single-turn prompts with the validation errors, up to `DIRECTOR_MAX_REPAIR_ATTEMPTS` (default 2), and then fail with `VALIDATION_FAILED`. | M1 |
| DIR-5 | Templates are selected from the fixed catalog; props are validated against the template's schema. | M1 |
| DIR-6 | Engine selection per scene. A choice of an unavailable engine is coerced deterministically to `motion2d` with a genre-appropriate template (to `three` when `motion2d` is disabled), and a warning is recorded. | M1 |
| DIR-7 | Brand consistency: a brand kit built from the request colours and the brief palette; the brief carries brand-consistency notes that later stages receive. | M1 |
| DIR-8 | Token usage and estimated cost per stage and chunk, with run totals and cached-call counts. Refused and truncated attempts are counted, and server-side fallback hops are priced per model. A deterministic cost ceiling per run is available before the run starts. | M1 |
| DIR-9 | Stage cache keyed by a content hash of the rendered prompt, the structured stage input and the provider configuration, scoped per user. Only validated outputs are cached. A rerun with identical inputs makes no provider calls. | M1 |
| DIR-10 | Run progress (completed and total steps, current stage, message) is persisted and shown. Runs can be cancelled while queued or running. | M1 |
| DIR-11 | Regenerate one scene with optional instructions, keeping its id and duration and leaving every other scene unchanged. A regeneration always makes fresh provider calls (no cache). | M1 (library: `regenerateScene`); M2 (API endpoint and UI) |
| DIR-12 | Prompt-injection hardening: the user prompt, style notes, reference data and earlier stage outputs are wrapped in tags and the system prompt declares them untrusted data, never instructions. `<user_instructions>` (scene regeneration only) is the one directive tag, limited to creative direction. Model-written text never appears in the `<task>` line. | M1 |
| DIR-13 | Never asks the model for code and never executes model output. | M1 |
| DIR-14 | Provider is selected by env: `mock` (default) or `anthropic`. Model, effort, max output tokens, refusal fallbacks and structured-output mode are configurable. | M1 |
| DIR-15 | Vision input (sampled reference frames) for reference-based planning. | M3 |
| DIR-16 | Voice-over-aware timing: align scene timing with synthesized voice-over. The policy is an open question (section 11). | M4 |

### 6.5 Universal timeline (TL)

| ID | Requirement | Milestone |
|---|---|---|
| TL-1 | Timeline v1: render settings, integer-frame positions and durations, brand kit, assets, chapters, scenes (with engine-specific content, camera, transition, narration), tracks (audio, caption, overlay, video), generator metadata. | M1 |
| TL-2 | Invariants enforced at parse time: contiguous scenes and chapters, one global id namespace, asset references with compatible kinds, non-overlapping track items, valid transitions, camera keyframes and fades, and an asset id required for `ready` generated scenes. | M1 |
| TL-3 | Versioned format: `schemaVersion`, sequential migrations, `parseTimeline` migrates then parses, newer versions are rejected. | M1 |
| TL-4 | Each successful director run stores an immutable project version (previous max + 1) holding the timeline and all artifacts. | M1 |
| TL-5 | Timeline JSON can be viewed (pretty-printed) and copied in the UI. | M1 |
| TL-6 | Editor changes are saved as new validated versions. | M2 |
| TL-7 | Multi-track editing (overlay, audio, video tracks and transitions). | M7 |

### 6.6 Engines, templates and providers (ENG)

| ID | Requirement | Milestone |
|---|---|---|
| ENG-1 | Template catalog with Zod props schemas and deterministic `buildProps`. motion2d: `title-card`, `kinetic-text`, `bullet-list`, `quote`, `stat-counter`, `step-instruction`, `split-feature`, `cta-end-card`, `cartoon-scene`, `property-showcase`, `lower-third`. three: `product-turntable`, `logo-reveal-3d`, `floating-shapes`. | M1 (definitions only; no render components) |
| ENG-2 | Engine availability is reported by `GET /v1/system/config` with reasons. In M1: motion2d and three are available for planning; footage, image and screen report "requires uploaded assets (Milestone 3)"; generated reports "no video generation provider configured". | M1 |
| ENG-3 | Remotion components for every motion2d template, rendered from the timeline. | M2 |
| ENG-4 | 3D engine: React Three Fiber, `@remotion/three` and Drei components for the three templates; GLB models; 3D camera presets. | M5 |
| ENG-5 | Footage, image and screen engines (trim, playback rate, fit, Ken Burns, zoom regions, cursor highlight). | M6 (uploads arrive in M3) |
| ENG-6 | Generated-video provider adapters (for example Runway, Kling, Pika) behind one interface, with async jobs and cost controls. A provider shows as connected only when configured. | M6 |
| ENG-7 | Transcription adapter (M3); speech (TTS) and music adapters (M4). Image-generation adapter (used by `split-feature.imagePrompt`). | M3 / M4 / not yet scheduled |
| ENG-8 | Local-model adapters behind the same `AIProvider` interface. | Not scheduled |

### 6.7 Project page, preview and editor (EDIT)

| ID | Requirement | Milestone |
|---|---|---|
| EDIT-1 | Project header with status badge and run progress bar. Cancel and Re-run buttons call real endpoints; with a live (credit-spending) provider, starting or re-running asks for confirmation. Only actions that work are shown. | M1 |
| EDIT-2 | Tabs: Storyboard (scene cards with timecodes, duration, engine and template badges, shot info, voice-over, on-screen text; chapters load lazily), Preview, Brief, Script, Shot list, Timeline JSON (copy button), Usage, Request (the stored request). Only the active tab is rendered; long tabs are paginated. A version switcher shows when a project has several versions. | M1 |
| EDIT-3 | Preview is an **animatic** in the Remotion Player: each scene is a branded card showing the scene title, primary template text and an engine badge, with caption cues and fade/slide transitions, timed by the timeline's integer frames. It is not the final template rendering. | M1 |
| EDIT-4 | Basic editor: scene list and reorder, text and colour edits validated against template props, regenerate scene, a richer versions UI (compare, restore). M1 already has a version switcher. | M2 |
| EDIT-5 | Editor v2: tracks, transitions, audio editing. | M7 |

### 6.8 Rendering and export (RND)

| ID | Requirement | Milestone |
|---|---|---|
| RND-1 | Render jobs on a queue with progress and cancellation. | M2 |
| RND-2 | Rendering by frame-range segments, with FFmpeg assembly and audio muxing. | M2 |
| RND-3 | No full video is held in memory. Segments stream to disk or storage; memory use does not grow with video length. | M2 |
| RND-4 | A failed segment is retried on its own, without re-rendering the whole video. | M2 |
| RND-5 | Export validation with ffprobe (duration, fps, dimensions, codecs, expected streams) before an export is offered. | M2 |
| RND-6 | Render timeouts and temp-file cleanup on success, failure and cancellation. | M2 |
| RND-7 | Distributed chapter/segment rendering across workers; resumable renders. | M7 |
| RND-8 | End-to-end validation of exports longer than 20 minutes. | M7 |
| RND-9 | Codec options from `RenderSettings` (H.264, H.265, VP9, ProRes; AAC, Opus). Which ones ship first is an open question. | M2+ |

### 6.9 Voice, music and captions (AUD)

| ID | Requirement | Milestone |
|---|---|---|
| AUD-1 | One caption track per timeline when voice-over is enabled, with cues of up to 7 words and 80 characters, timed proportionally to word count within each scene. Languages written without spaces are word-segmented with `Intl.Segmenter`. | M1 |
| AUD-2 | TTS and music provider adapters; voice-over and music generation. | M4 |
| AUD-3 | Voice-over alignment and word-timed captions. | M4 |
| AUD-4 | Music ducking under voice and loudness normalization. The campaigns worker already does sidechain ducking and normalizes voice to -16 LUFS; the export target is open. | M4 |

### 6.10 Assets and storage (AST)

| ID | Requirement | Milestone |
|---|---|---|
| AST-1 | `AssetRef` schema. URIs accept only `asset://<assetId>` (internal storage reference) and `https://` with a fully-qualified DNS host; other schemes, credentials, IP literals, local host names, dot segments, control and invisible characters are rejected, and URIs are stored normalized. | M1 (schema) |
| AST-2 | S3-compatible storage (S3, MinIO, R2). | M3 |
| AST-5 | Server-side fetches of `https:` asset URIs resolve the host and refuse private, loopback, link-local and metadata addresses at fetch time (the schema checks shape only). | M3 |
| AST-3 | Uploads with configurable size limits and MIME sniffing from file content, not only the extension or the client header. | M3 |
| AST-4 | GLB model uploads for 3D scenes. | M5 |

### 6.11 Usage, cost and limits (USE)

| ID | Requirement | Milestone |
|---|---|---|
| USE-1 | Per-stage usage table: stage, chunk, attempts, cached, tokens, estimated cost. | M1 |
| USE-2 | `GET /v1/usage`: today (UTC day) and this month, with runs, token counts and estimated USD. | M1 |
| USE-3 | Per-user quotas, checked under a per-user lock: `LIMIT_ACTIVE_RUNS_PER_USER` (default 2 queued or running runs), `LIMIT_DIRECTOR_RUNS_PER_DAY` (default 50) and `LIMIT_DIRECTOR_USD_PER_DAY` (default 25). The USD quota reserves each active run's cost ceiling, so a run that could exceed the remaining budget does not start (on `claude-opus-5-5` at $25, about one hour of `long-form` video at most), and a running run is stopped once today's spend reaches the limit. Exceeding a quota at start returns 429 `QUOTA_EXCEEDED`. | M1 |
| USE-4 | Rate limits: per authenticated user (`RATE_LIMIT_PER_MINUTE`, default 300), and per client IP for failed authentications, checked before any token lookup (`RATE_LIMIT_UNAUTH_PER_MINUTE`, default 60). | M1 |
| USE-5 | Resource limits (duration, dimensions, fps, scenes, chapters, prompt length) configurable via env. | M1 |
| USE-6 | Pricing table in code, overridable with `DIRECTOR_PRICING_JSON`. An unknown model records cost 0 with `pricingKnown = false` instead of guessing. | M1 |
| USE-7 | Cost controls for generative video: estimate before a job, caps, explicit confirmation for expensive jobs. | M6 |
| USE-8 | Billing, plans, per-organization quotas. | M8 |

### 6.12 Security and reliability (SEC)

| ID | Requirement | Milestone |
|---|---|---|
| SEC-1 | Provider keys live on the server only. They are never returned by `GET /v1/system/config` and are redacted from logs. | M1 |
| SEC-2 | API tokens are stored as SHA-256 hashes. | M1 |
| SEC-3 | Every project and run query is scoped by owner. A foreign or missing id returns 404 `NOT_FOUND`. | M1 |
| SEC-4 | Zod validation of env, request bodies, LLM outputs, and (in the web app) every API response. | M1 |
| SEC-5 | 1 MB request body limit; CORS allowlist from env; errors return `{error: {code, message}}` with no stack traces. | M1 |
| SEC-6 | Director run timeout that scales with the plan (`max(DIRECTOR_RUN_TIMEOUT_MS, steps × DIRECTOR_STEP_TIMEOUT_MS)`, defaults 30 min and 2 min per step), cancellation, sanitized error messages. | M1 |
| SEC-7 | Upload size and MIME checks. | M3 |
| SEC-8 | Render timeouts and temp cleanup. | M2 |
| SEC-9 | Worker isolation. M1: with `QUEUE_DRIVER=bullmq`, the director worker is a separate process. Sandboxed render and analysis workers come in M8. | M1 / M8 |
| SEC-10 | OIDC login, teams, roles. | M8 |
| SEC-11 | Structured logging with pino (M1); metrics, tracing and alerting (M8). | M1 / M8 |
| SEC-12 | Backups and CDN delivery. | M8 |

### 6.13 Settings and system (SYS)

| ID | Requirement | Milestone |
|---|---|---|
| SYS-1 | Settings page: AI provider (mode, model, configured), queue driver, limits, engine availability with reasons, template catalog. | M1 |
| SYS-2 | Public `GET /health` returning `{ok, version}` (liveness) and `GET /ready` checking the database and Redis (503 when one fails). | M1 |

### 6.14 Campaigns module (CMP)

| ID | Requirement | Milestone |
|---|---|---|
| CMP-1 | The WhatsApp campaigns MVP (CSV upload, per-contact Remotion intro, optional ElevenLabs voice-over, ducked music, shared base video, WhatsApp Cloud API send, delivery webhooks) keeps working unchanged. | Existing |
| CMP-2 | Campaigns becomes a studio module: one auth system, the studio render pipeline, per-contact variables bound into a studio project, WhatsApp sending. | M7 |

### 6.15 M1 user flow

```mermaid
flowchart LR
  A["New project form<br/>(VideoRequest)"] --> B["POST /v1/projects<br/>limits checked"]
  B --> C["POST director-runs<br/>202, queued"]
  C --> D["Worker: AI Director<br/>brief, outline, chapters"]
  D --> E["Deterministic compile<br/>Timeline v1"]
  E --> F["ProjectVersion n+1<br/>project READY"]
  F --> G["Project page: storyboard,<br/>animatic, artifacts, usage"]
  G -. "M2 (planned)" .-> H["Render, export,<br/>basic editor"]
```

## 7. Non-functional requirements

Numbers marked *target* have not been measured yet. M1 test runs and manual runs should provide baselines.

### 7.1 Performance

- **API.** CRUD endpoints answer without waiting on director work. Director runs are always asynchronous (202 plus polling).
  *Target:* p95 under 200 ms on a developer machine for list and get endpoints, excluding cold start.
- **Progress.** Run progress is persisted at once on every stage change and otherwise at most every 500 ms, and polled by the
  web app through a server-side route handler (every 1.5 s, 5 s after two minutes, paused while the tab is hidden).
- **Director latency.** Chapters run sequentially (continuity over parallelism). Live-run latency therefore grows with chapter
  count: a 2 h `long-form` plan has 25 chapters and 128 steps, so a live run takes hours. Each run is bounded by a timeout that
  scales with the plan, `max(DIRECTOR_RUN_TIMEOUT_MS, steps × DIRECTOR_STEP_TIMEOUT_MS)` (defaults 30 min and 2 min per step:
  4 h 16 min for that plan). *Target:* a 60 s video reaches READY within 5 minutes at effort `medium`, to be confirmed by
  measurement.
- **Page weight.** The project page renders only the active tab and loads the timeline and storyboard lazily. Measured on a
  2 000-scene project: the HTML went from 35.6 MB to 0.59 MB (28.7 KB gzipped) and the DOM from 100 789 to 4 305 nodes.
- **Mock runs** must be fast enough to run the genre × duration matrix (5 s, 30 s, 10 min, 25 min, 2 h) inside the unit test suite.
- **Rendering (M2+).** Memory must not grow with video length (segment rendering). Throughput scales by adding workers (M7).

### 7.2 Reliability

- The `DirectorRun` row in Postgres is the source of truth. The queue job carries only `{runId}`, and processing skips any run
  that is not `QUEUED`, so a duplicate delivery does nothing.
- Success is committed in one transaction: the new version, run `SUCCEEDED` with usage, and the project set to `READY` with its
  current version.
- On failure, the project returns to `READY` if it already has a version, and becomes `FAILED` otherwise. On cancellation, it
  returns to `READY` if it already has a version, and to `DRAFT` otherwise. A failed run records an error code (a
  `DirectorError` code, or one set by studio-api: `TIMEOUT`, `QUOTA_EXCEEDED`, `SHUTDOWN`, `WORKER_LOST`, `QUEUE_LOST`,
  `QUEUE_UNAVAILABLE` or `INTERNAL`) and a sanitized message.
- BullMQ jobs use `attempts: 1`. Retries happen inside the run (SDK retries for 408/409/429/5xx, the director's repair loop).
  Rerunning a whole run is an explicit user action, and the stage cache makes it cheap.
- A running run writes a heartbeat about every 2 s. If its worker dies, a stale-run reaper fails it with `WORKER_LOST` about a
  minute later (usage written with progress is kept) and the project is unblocked; an old queued run whose job was lost fails
  with `QUEUE_LOST`. Runs are never re-queued automatically.
- On SIGTERM/SIGINT the worker stops its in-flight runs and records them `FAILED` with `SHUTDOWN`. A failed enqueue (Redis down)
  fails fast with 503 `QUEUE_UNAVAILABLE`. The final run writes are retried through short database outages.
- `GET /ready` reports whether the database and Redis answer.

### 7.3 Security

- Bearer token on every `/v1/*` route. Tokens are hashed at rest. Rate limiting is per user, plus a per-IP limit on failed
  authentications that is checked before any token lookup.
- The web app calls the API **server-side only**. The token is never sent to the browser
  ([ADR-017](DECISIONS.md#adr-017-nextjs-accesses-the-api-server-side-only)). Because M1 studio-web acts as a single
  configured user, **an M1 studio-web deployment must not be exposed publicly without an authenticating proxy in front of it.**
- LLM output is untrusted data. It is validated by Zod and mapped onto the template catalog, and it is never executed.
- User and reference content in prompts is tagged as untrusted data.
- Secrets are redacted from logs (pino `redact` for authorization headers and API keys).
- Asset URIs are restricted to `asset://` and `https://` with a fully-qualified DNS host (no IP literals or local names). The
  check is on the shape only; resolving and blocking private addresses at fetch time is M3 (AST-5).
- studio-web binds `127.0.0.1` by default and sends strict security headers (CSP without `unsafe-eval` in production,
  `frame-ancestors 'none'`, `nosniff`, Referrer-Policy, Permissions-Policy, COOP).
- Planned: upload validation (M3), sandboxed workers and OIDC (M8).

### 7.4 Cost controls

- Mock provider by default; tests never call the network.
- Per-user active-run, daily run and daily USD quotas; the USD quota reserves each run's cost ceiling before it starts and stops
  a running run that reaches the limit. Per-user and per-IP rate limits; configurable resource limits checked before any
  provider call. In live mode the web app asks for confirmation before starting a run.
- Default model `claude-opus-5-5` at effort `medium` with `max_tokens` 16 000 per call. Chunking keeps each output small.
- System prompts are stable and sent with `cache_control` so Anthropic prompt caching applies. A stage-level content-hash cache
  skips repeat calls entirely.
- Cost formula with the default pricing for `claude-opus-5-5` (USD per million tokens): input 4.00, output 20.00, cache read
  0.20, 5-minute cache write 5.00. Thinking is always on for this model (adaptive), and thinking tokens are billed as output
  tokens even though they are not displayed.
- *Illustrative arithmetic, not a measurement:* a call with 6 000 input and 4 000 output tokens costs about
  0.024 + 0.080 = $0.10. A 25-minute explainer (9 chapters, 47 LLM calls before repairs) would then cost on the order of $5 to
  plan. Real figures come from the Usage tab once live runs are measured.
- *Reserved ceiling, computed by the code:* before a run starts, studio-api reserves its worst case,
  $0.48 + $1.84 × chapters on `claude-opus-5-5` (every call at its full `max_tokens`). That is $17.04 for the 25-minute
  explainer and $46.48 for a 2 h `long-form` video, so with the default `LIMIT_DIRECTOR_USD_PER_DAY=25` a 2 h video cannot start
  until the limit is raised ([DEVELOPMENT.md section 4.4](DEVELOPMENT.md#44-quotas)).

### 7.5 Accessibility

- *Target:* studio-web meets WCAG 2.2 AA. M1 builds on Radix primitives (keyboard-operable select, tabs, switch, progress),
  labelled form controls, visible focus and theme tokens with light and dark modes. Navigation links keep an accessible name
  at phone width, the animatic player does not take focus away from the tab list, and an invalid form submit moves focus to
  the first invalid field. No formal audit has been done.
- Generated videos: a caption track is produced in M1 when voice-over is enabled; word-timed captions follow in M4. Template
  components (M2) should keep text-to-background contrast at AA levels and respect safe zones for 9:16 social formats.
- Status is never conveyed by colour alone; badges carry text.

### 7.6 Maintainability and portability

- pnpm workspace. Packages are consumed as TypeScript source. Strict TypeScript with no `any` and no `@ts-ignore`; ESM only.
- Configuration comes from env and is validated with Zod at startup. Every variable is documented in `.env.example`
  ([DEVELOPMENT.md](DEVELOPMENT.md)).
- Postgres 16 and Redis 7 through `docker-compose.yml`. Containerizing the studio apps themselves is not scheduled yet (section 11).

## 8. Success metrics

### 8.1 M1 exit metrics (verifiable now, by tests)

| Metric | Target |
|---|---|
| Mock pipeline across genres × {5 s, 30 s, 10 min, 25 min, 2 h} | 100 % produce timelines that pass `TimelineSchema`, with scene frames summing exactly to `durationInFrames` and scene counts within the planned range |
| Second identical run | 0 provider calls, reported as cached calls |
| Repairs | A scripted invalid output followed by a valid one succeeds; exhausting repairs yields `VALIDATION_FAILED` |
| API end to end | Director run produces version 1 with a valid timeline; owner isolation returns 404; limits return 422; quotas return 429 |
| Build health | typecheck and test pass for all four packages; `@vc/studio-web` build passes |

### 8.2 Product metrics (from live use; targets to be fixed after a baseline)

| Metric | Definition | Initial target |
|---|---|---|
| Director success rate | SUCCEEDED / (SUCCEEDED + FAILED), excluding cancelled runs | ≥ 95 % |
| First-attempt validity | Share of LLM calls valid without repair, per stage | ≥ 90 % |
| Repair exhaustion | Share of calls ending in `VALIDATION_FAILED` | < 1 % |
| Refusal rate | Share of calls with `stop_reason: refusal` after fallbacks | Tracked; any refusal on a benign genre is investigated |
| Planning cost per finished minute | Estimated USD / minutes of planned video | Baseline first |
| Time to first animatic | Submit to READY for videos of 60 s or less (p50) | ≤ 3 min (live) |
| Cache effectiveness | Cached calls / total calls on reruns | Tracked |
| Render success (M2+) | Validated exports / render jobs | ≥ 99 % after segment retries |
| Export correctness (M2+) | Exports passing ffprobe validation | 100 % (invalid exports are never offered) |
| Edit-instead-of-regenerate (M2+) | Projects with at least one scene edit or regeneration before export | Tracked |

## 9. Constraints

- **Runtime:** Node ≥ 22, pnpm 10.28, Postgres 16, Redis 7. Studio databases `video_studio` and `video_studio_test`. The compose
  file's default database, `video_creation`, belongs to campaigns.
- **Stack (studio):** Next.js 16 App Router, React 19, Tailwind CSS v4, shadcn-style components, Remotion 4.0.534 Player;
  Fastify 5; Prisma 7.10 (`prisma-client` generator plus `@prisma/adapter-pg`); BullMQ 5 plus ioredis; Zod 4.6;
  `@anthropic-ai/sdk` 0.132. Planned: Remotion renderer and FFmpeg (M2), Three.js / React Three Fiber / `@remotion/three` /
  Drei (M5), S3-compatible storage (M3).
- **Campaigns stays as-is:** Express 5, Zod 3, React + Vite, raw SQL migrations. No schema or code sharing with the studio
  before M7.
- **Remotion licensing:** Remotion is free for individuals and companies with up to 3 employees. Larger companies need a company
  license. This applies to the studio (Player now, renderer from M2) as it does to campaigns. The studio's `<Player>` does
  **not** set `acknowledgeRemotionLicense`: that is left unset on purpose until the owner decides how the project is licensed.
- **Claude API behaviour as of 2026-10** for `claude-opus-5-5`: thinking cannot be disabled (adaptive); `temperature`, `top_p`,
  `top_k`, `budget_tokens` and assistant prefill return 400; forced `tool_choice` returns 400; effort defaults to `medium`;
  refusals arrive as `stop_reason: "refusal"`. The server-side `fallbacks` parameter is a first-party Claude API feature and is
  not available on Bedrock, Vertex AI or Foundry ([ADR-006](DECISIONS.md#adr-006-claude-structured-outputs-instead-of-forced-tool-use),
  [ADR-007](DECISIONS.md#adr-007-default-model-claude-opus-5-5-at-effort-medium-with-server-side-refusal-fallbacks)).
- **No video-generation provider is configured** in M1, and the product must not imply one is.

## 10. Assumptions

- Users accept an animatic, not a rendered video, as the M1 output. Rendering is M2.
- One studio-web deployment serves one configured API user in M1 (development and internal use).
- English is the primary UI language. The request `language` field flows into prompts and captions; UI localization is not
  planned.
- Claude can produce valid structured output for the M1 schemas at effort `medium` with at most 2 repairs in the large majority
  of calls. This must be verified with live runs (no live calls run in CI).
- The heuristic mock is good enough to exercise every code path, but its creative quality is not representative. The UI shows
  mock mode explicitly.

## 11. Open questions

| # | Question | Needed by |
|---|---|---|
| Q1 | Should `three` be reported as available before the M5 renderer exists? In M1 it is available for planning and previews as an animatic card. | M2 |
| Q2 | M1 reports footage/image/screen as "requires uploaded assets (Milestone 3)", but those engines are scheduled to render in M6. Should the simple image engine (Ken Burns over a photo) move earlier, for example to M3, to serve real-estate users? | M3 planning |
| Q3 | Do M2 renders include the caption track (burned in) and/or sidecar SRT/VTT export? | M2 |
| Q4 | Which codecs ship first (H.264/AAC only, or also VP9/ProRes)? | M2 |
| Q5 | The stage cache is scoped per user since the M1 review, so a hit can no longer reveal another user's request. Open: should it be scoped per organization once organizations exist, and what eviction or TTL policy should apply to `DirectorCacheEntry` (including entries orphaned by a `PROMPT_VERSION` bump)? | M8 at the latest |
| Q6 | How does a user ask for a fresh creative take of an unchanged request when the cache would return the same plan (a per-run "bypass cache" option)? `regenerateScene` already bypasses the cache for one scene. | M2 |
| Q7 | Voice-over timing policy: re-time scenes to the synthesized voice-over, time-stretch the voice, or constrain the script length? | M4 |
| Q8 | Which TTS, music and transcription providers? Campaigns already uses ElevenLabs. | M3 / M4 |
| Q9 | Which object storage for deployments (S3, R2, MinIO), and are asset URLs signed and expiring? | M3 |
| Q10 | Should cheaper models (`claude-sonnet-5-5`, `claude-haiku-5-5`) be routed per stage? Should the Batch API (asynchronous, lower cost) be used for long-form planning? Decide after measuring quality and cost. | After M1 live baseline |
| Q11 | Export loudness target (for example -14 LUFS for social, -16 LUFS for voice-led training)? | M4 |
| Q12 | Containerizing studio-api, the worker and studio-web (Dockerfiles, compose profiles). The render worker needs Chromium and FFmpeg. M2 or M8? | M2 |
| Q13 | During the M7 merge, are campaigns tables brought into Prisma or kept in raw SQL? Are campaigns Express routes ported to Fastify? | M7 |
| Q14 | Per-plan limits and pricing for end users (who pays for generation, and how quotas map to plans). | M8 |
| Q15 | A periodic live-provider evaluation (small fixed request set with a real key, run manually or on a schedule) to catch prompt or model regressions that mock-only CI cannot see. | M2 |

## 12. Glossary

| Term | Meaning |
|---|---|
| Animatic | M1 preview: scene cards timed like the final video, played in the Remotion Player. Not the final rendering. |
| Artifacts | The director's validated outputs: brief, outline, script, storyboard, shot list, engine selection, scene specs. |
| Chapter | A contiguous span of scenes. The unit of chunked generation for long videos. |
| Director run | One execution of the AI Director for a project, with status, progress, usage and an optional resulting version. |
| Engine | How a scene is produced: `motion2d`, `three`, `footage`, `generated`, `image`, `screen`. |
| Project version | Immutable snapshot of a timeline and its artifacts. Each successful run adds one. |
| Reference profile | Structured analysis of an uploaded reference (schema in M1, produced from M3). |
| Template | A reviewed component with a Zod props schema. The LLM only chooses a template and fills its props. |
| Timeline | The versioned, integer-frame JSON document consumed by the preview, editor and renderers. |
