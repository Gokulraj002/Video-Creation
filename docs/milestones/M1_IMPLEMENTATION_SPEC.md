# Universal AI Video Studio — Milestone 1 Implementation Spec (authoritative contract)

Repo: `/home/user/Video-Creation` (pnpm 10 workspace, Node 22, ESM everywhere, TypeScript strict via `tsconfig.base.json`:
`strict`, `noUncheckedIndexedAccess`, `moduleResolution: Bundler`, `noEmit`). Postgres 16 and Redis run locally
(`postgres://postgres:postgres@localhost:5432/...`, `redis://localhost:6379`). Databases `video_studio` and
`video_studio_test` already exist.

The repo ALREADY contains a separate, working product: the WhatsApp personalized-video "campaigns" MVP
(`apps/api`, `apps/worker`, `apps/web`, `packages/core`, `packages/video`, `db/migrations`). DO NOT modify those
directories. Milestone 1 builds the new **Universal AI Video Studio** beside it:

| Path | Package | Role |
|---|---|---|
| `packages/schema` | `@vc/schema` | Isomorphic Zod v4 schemas + types: timeline v1, reference profile, director artifacts, template catalog, API DTOs, limits, frame math, migrations |
| `packages/ai-director` | `@vc/ai-director` | Server-only AI Director pipeline, provider adapters (heuristic mock, scripted mock, Anthropic), caching, usage/cost, timeline compiler |
| `apps/studio-api` | `@vc/studio-api` | Fastify 5 API + Prisma 7 (Postgres) + BullMQ worker entrypoint |
| `apps/studio-web` | `@vc/studio-web` | Next.js 16 App Router + Tailwind v4 + shadcn-style UI + Remotion Player animatic |
| `docs/*.md` | — | PRD, ARCHITECTURE, AI_DIRECTOR, TIMELINE_SCHEMA, DATABASE, ROADMAP, DECISIONS, DEVELOPMENT |

## 0. Global rules for every agent

- Strict TypeScript, no `any` (use `unknown` + narrowing), no `@ts-ignore`. ESM only. Import Zod as `import { z } from 'zod'` (v4.6).
- Dependencies are ALREADY installed (see each package.json). Do NOT run `pnpm install`/`pnpm add`/`npm`. If a dependency is truly
  missing, work around it or list it in your result's `dependenciesNeeded`.
- Only write inside your assigned directories. Do NOT `git commit`, `git add`, push, or touch other agents' directories.
- Verify with the package's own scripts: `pnpm --filter <pkg> typecheck` and `pnpm --filter <pkg> test`.
- Tests must never hit the network or spend Claude credits: AI calls are mocked by default. Anthropic adapter tests inject a fake client.
- Workspace packages are consumed as TypeScript source (`"exports": {".": "./src/index.ts"}`), no build step.
- Never execute code produced by an LLM. LLM output is data, validated by Zod, mapped onto a fixed template catalog.
- Keep modules small and focused; export public API from `src/index.ts`.

## 1. `@vc/schema` (packages/schema) — contract

Files (all under `src/`, re-exported from `src/index.ts`): `common.ts`, `render-settings.ts`, `frames.ts`, `assets.ts`,
`camera.ts`, `transitions.ts`, `layers.ts`, `scene-content.ts`, `scene.ts`, `tracks.ts`, `chapter.ts`, `brand.ts`,
`timeline.ts`, `limits.ts`, `migrations.ts`, `reference-profile.ts`, `director.ts`, `templates/` (one file per template +
`catalog.ts`), `api.ts`. Every schema exported as `XxxSchema` with `export type Xxx = z.infer<typeof XxxSchema>`.

### 1.1 common
- `IdSchema`: `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`.
- `HexColorSchema`: `/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/`.
- `FrameSchema` int ≥ 0; `DurationFramesSchema` int ≥ 1.
- `EasingSchema`: `'linear'|'ease-in'|'ease-out'|'ease-in-out'|'spring'`.
- `JsonValueSchema`: recursive JSON value (string ≤ 10_000 chars, finite numbers, booleans, null, arrays ≤ 500, objects ≤ 200 keys,
  max depth 8). Used for timeline-level template props (`Record<string, JsonValue>`), never sent to the LLM.
- `SafeUriSchema`: string ≤ 2048, must parse as URL with protocol `asset:` (internal storage reference, e.g. `asset://<assetId>`)
  or `https:`; reject `http:`, `file:`, `data:`, `javascript:`, URLs with username/password, and control characters.
- `FontFamilySchema`: `/^[A-Za-z0-9 \-]{1,64}$/`.

### 1.2 render settings
- `AspectRatioSchema`: `'9:16'|'16:9'|'1:1'|'4:5'|'custom'`. `ResolutionSchema`: `'480p'|'720p'|'1080p'|'1440p'|'2160p'|'custom'`.
- `resolveDimensions({aspectRatio, resolution, customWidth?, customHeight?}) → {width, height}`: preset = SHORT side in px
  (480/720/1080/1440/2160); long side = round(short × ratio) rounded to even. `'custom'` aspect or resolution requires both
  custom dims; output always even integers. Examples: 9:16+1080p → 1080×1920; 16:9+1080p → 1920×1080; 1:1+720p → 720×720;
  4:5+1080p → 1080×1350; 16:9+2160p → 3840×2160.
- `RenderSettingsSchema`: `{width, height (even ints 16..8192), fps (int 1..240), backgroundColor: Hex, sampleRate: 44100|48000,
  videoCodec: 'h264'|'h265'|'vp9'|'prores', audioCodec: 'aac'|'opus'}`.

### 1.3 frames
- `secondsToFrames(seconds, fps) = Math.round(seconds * fps)`; `framesToSeconds(frames, fps)`.
- `allocateFrames(weights: number[], totalFrames: number, minFrames = 1): number[]` — largest-remainder apportionment of
  `totalFrames` proportional to positive `weights`; every entry ≥ `minFrames`; sum EXACTLY `totalFrames`; deterministic tie
  breaking (lower index first). Throws `RangeError` if `weights.length * minFrames > totalFrames` or weights invalid.
- `formatTimecode(frame, fps) → 'HH:MM:SS:FF'`.

### 1.4 assets — `AssetRefSchema`
`{id, kind: 'image'|'video'|'audio'|'font'|'model3d'|'document'|'subtitle', uri: SafeUri, mimeType (≤127, /^[\w.+-]+\/[\w.+-]+$/),
name?, sizeBytes? (int ≥0), width?, height?, durationInFrames?, source: 'upload'|'generated'|'stock'|'external', provider?, license?}`.

### 1.5 camera
- `CameraPresetSchema`: `'static'|'push-in'|'pull-out'|'pan-left'|'pan-right'|'tilt-up'|'tilt-down'|'orbit-left'|'orbit-right'|
  'dolly-in'|'dolly-out'|'crane-up'|'crane-down'|'ken-burns'|'handheld'`.
- `Camera2DKeyframe {frame, x, y, zoom (>0, ≤20), rotation (deg), easing}`; `Camera3DKeyframe {frame, position:[x,y,z], target:[x,y,z],
  fov (1..179), easing}` (finite numbers, |v| ≤ 10_000). Frames are RELATIVE to the scene start.
- `CameraTrackSchema`: discriminated union on `space`: `{space:'2d', preset?, keyframes: Camera2DKeyframe[] (1..500)}` |
  `{space:'3d', preset?, keyframes: Camera3DKeyframe[] (1..500)}`.
- `expandCameraPreset(preset, space, durationInFrames) → CameraTrack` deterministic keyframes (2D push-in zoom 1→1.15, pan ±0.1,
  ken-burns zoom 1→1.12 + drift; 3D orbit = points on a circle radius 6 around origin, dolly = position z 8→5, crane = y 0.5→4;
  static = single keyframe). Used by the director compiler.

### 1.6 transitions — `TransitionSchema`
`{type: 'cut'|'fade'|'crossfade'|'slide'|'wipe'|'zoom'|'blur'|'dip-to-black'|'dip-to-white', durationInFrames: int ≥0,
direction?: 'left'|'right'|'up'|'down', easing}`; `cut` ⇔ durationInFrames 0.

### 1.7 2D layers — `Layer2DSchema` (discriminated on `type`)
Common: `{id, startFrame (rel. to scene), durationInFrames, enter: AnimationPreset, exit: AnimationPreset, opacity 0..1}`;
`AnimationPresetSchema`: `'none'|'fade'|'slide-up'|'slide-down'|'slide-left'|'slide-right'|'scale'|'pop'|'typewriter'|'blur-in'`.
- text: `{type:'text', text ≤2000, x,y (0..1 normalized center), maxWidth 0..1, fontFamily?, fontSize (px at 1080p short side, 4..400),
  fontWeight 100..900, color Hex, align 'left'|'center'|'right'}`
- shape: `{type:'shape', shape:'rect'|'circle'|'line', x,y,width,height (0..1), color Hex, cornerRadius ≥0}`
- image: `{type:'image', assetId, x,y,width,height (0..1), fit 'cover'|'contain'}`

### 1.8 scene content — `SceneContentSchema` discriminated on `engine`
`EngineTypeSchema = 'motion2d'|'three'|'footage'|'generated'|'image'|'screen'`.
- `motion2d`: `{engine, template: TemplateId, props: Record<string, JsonValue>, layers: Layer2D[] (default [])}`
- `three`: `{engine, template: TemplateId, props: Record<string, JsonValue>, modelAssetId?, environment: 'studio'|'sunset'|'city'|'night'|'forest'|'warehouse', lighting: 'soft'|'dramatic'|'high-key'}`
- `footage`: `{engine, assetId, trimStartFrame ≥0, playbackRate 0.25..4, fit 'cover'|'contain', volume 0..1, muted}`
- `generated`: `{engine, provider (Id), prompt ≤4000, negativePrompt?, seed? int, status: 'pending'|'queued'|'ready'|'failed', assetId?, jobId?}`
- `image`: `{engine, assetId, animation: 'none'|'ken-burns'|'zoom-in'|'zoom-out'|'pan-left'|'pan-right'|'parallax', fit, focalPoint {x,y 0..1}}`
- `screen`: `{engine, assetId, trimStartFrame, playbackRate, zoomRegions: {startFrame, durationInFrames, x,y,width,height 0..1}[], highlightCursor}`

### 1.9 scene / chapter / brand
- `SceneSchema {id, chapterId, title ≤200, startFrame, durationInFrames, content: SceneContent, camera?: CameraTrack,
  transitionIn?: Transition, narration?: {text ≤5000, voiceId?, language?}, notes? ≤2000, storyboardSceneId?}`
- `ChapterSchema {id, title ≤200, summary? ≤2000, startFrame, durationInFrames}`
- `BrandKitSchema {name? ≤120, colors: {primary, secondary, accent, background, text: Hex}, fonts: {heading, body: FontFamily}, logoAssetId?}`

### 1.10 tracks — `TrackSchema` discriminated on `kind`
- audio: `{id, kind:'audio', role:'voiceover'|'music'|'sfx', name, muted, volume 0..2, items: {id, assetId, startFrame, durationInFrames, trimStartFrame, volume 0..2, fadeInFrames, fadeOutFrames}[]}`
- caption: `{id, kind:'caption', name, language, style: {preset:'bold-center'|'lower'|'karaoke'|'minimal', position:'bottom'|'center'|'top', fontFamily?, fontSize? 8..200, color, backgroundColor?}, items: {id, startFrame, durationInFrames, text ≤500, speaker?}[]}`
- overlay: `{id, kind:'overlay', name, items: {id, startFrame, durationInFrames, content: motion2d|image content, opacity 0..1, zIndex int}[]}`
- video: `{id, kind:'video', name, items: {id, assetId, startFrame, durationInFrames, trimStartFrame, playbackRate 0.25..4, opacity 0..1, volume 0..2, muted}[]}`

### 1.11 `TimelineSchema` (v1) and invariants
`{schemaVersion: 1, id, title ≤200, settings: RenderSettings, durationInFrames, brand?: BrandKit, assets: AssetRef[],
chapters: Chapter[] (≥1), scenes: Scene[] (≥1), tracks: Track[], metadata: {generator: {name, version, promptVersion?}, language?, createdAt? ISO}}`.
`superRefine` invariants, each reported with a precise `path`:
1. Scenes sorted by `startFrame`; first starts at 0; contiguous (scene[i+1].startFrame === scene[i].startFrame + duration);
   last ends exactly at `durationInFrames`.
2. Chapters satisfy the same contiguity over `[0, durationInFrames]`; every `scene.chapterId` exists; each scene lies fully inside
   its chapter; scene order never goes back to an earlier chapter.
3. All ids (chapters, scenes, assets, tracks, track items, layers) unique in ONE global namespace.
4. Every asset reference exists in `assets` with a compatible kind: footage/screen/video-clip → `video`; image content/image
   layer/brand logo → `image`; audio item → `audio`; `three.modelAssetId` → `model3d`; generated `assetId` → `video`.
5. Track items lie within `[0, durationInFrames]`; items in one track don't overlap (sorted by startFrame).
6. `transitionIn`: none (or `cut`) on the first scene; duration ≤ min(this scene, previous scene) durations.
7. Camera keyframes: `frame < scene.durationInFrames`, strictly increasing; `3d` camera only on `three` scenes, `2d` otherwise.
8. Audio `fadeInFrames + fadeOutFrames ≤ durationInFrames`; layer `startFrame + durationInFrames ≤ scene.durationInFrames`.
9. `generated.status === 'ready'` ⇒ `assetId` required.
Also export `parseTimeline(input: unknown): Timeline` (migrate then parse), `safeParseTimeline`, `CURRENT_TIMELINE_VERSION = 1`.

### 1.12 limits — configurable, NOT hardcoded maxima
`ResourceLimitsSchema {maxDurationSeconds, maxWidth, maxHeight, maxFps, maxScenes, maxChapters, maxTracks, maxAssets, maxPromptChars}`
(all positive ints) and `DEFAULT_RESOURCE_LIMITS` (7200 s, 3840, 3840, 60, 2000, 200, 50, 500, 20000) — defaults only; apps
override from env. `checkTimelineLimits(timeline, limits) → LimitViolation[]` and `checkVideoRequestLimits(request, limits)`;
`LimitViolation {code, message, limit, actual}`.

### 1.13 migrations
`TIMELINE_MIGRATIONS: Record<number, (doc) => doc>` (from version N to N+1; empty in v1) and
`migrateTimeline(input, migrations = TIMELINE_MIGRATIONS)` that reads `schemaVersion` (missing → error), applies migrations
sequentially up to current, rejects versions newer than current. Tested with an injected fake v0→v1 migration.

### 1.14 reference profile — `ReferenceProfileSchema` (produced by M3 analysis engine; consumed by the director now)
`{schemaVersion: 1, id, assetId, kind: 'video'|'image'|'document'|'audio'|'script', createdAt ISO,
metadata: {durationSeconds?, width?, height?, fps?, videoCodec?, audioCodec?, hasAudio?, sizeBytes?, pageCount?},
scenes: {index, startSeconds, endSeconds, keyframeAssetIds: Id[], shotType?: ShotType, cameraMovement?: CameraMovement, description? ≤1000, dominantColors: Hex[]}[],
palette: {hex, weight 0..1}[] (≤16), typography?: {fontsDetected: string[], styleNotes? }, transitions: {type: TransitionType, count}[],
pacing?: {averageShotSeconds, cutsPerMinute}, transcript?: {language, segments: {startSeconds, endSeconds, text ≤2000, speaker?}[]},
audio?: {hasMusic, hasVoice, tempoBpm?, loudnessLufs?}, styleSummary? ≤2000, moodTags: string[] (≤20), warnings: string[]}`.

### 1.15 director artifacts (`director.ts`)
IMPORTANT — LLM-facing schemas (everything the model must output) must be structured-output safe: closed objects only,
ALL properties required (use `.nullable()` instead of `.optional()`), no records/maps, no recursion, no defaults. Length/size
constraints are allowed (the Anthropic SDK strips them from the wire schema and Zod re-validates client-side).
- `VideoGenreSchema`: `'cinematic-ad'|'promo'|'sop-training'|'corporate-training'|'comedy'|'cartoon'|'motion-graphics'|'product-3d'|
  'real-estate'|'explainer'|'presentation'|'social-short'|'long-form'|'reference-based'`.
- `ShotTypeSchema`: `'establishing'|'wide'|'medium'|'close-up'|'extreme-close-up'|'over-the-shoulder'|'pov'|'overhead'|'macro'|'insert'|'two-shot'`.
- `CameraMovementSchema`: `'static'|'pan-left'|'pan-right'|'tilt-up'|'tilt-down'|'dolly-in'|'dolly-out'|'truck-left'|'truck-right'|
  'orbit'|'crane-up'|'crane-down'|'push-in'|'pull-out'|'zoom-in'|'zoom-out'|'handheld'|'tracking'`.
- `VideoRequestSchema` (user input; NOT LLM-facing): `{title 1..200, prompt 1..20000, genre, styleNotes? ≤2000,
  durationSeconds (finite > 0, NO max — limits are applied separately), aspectRatio, resolution, customWidth?, customHeight?,
  fps int 1..240 default 30, language BCP-47 `/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/` default 'en',
  brand?: {name? ≤120, colors: Hex[] ≤8, fontHeading?, fontBody?, logoAssetId?}, voiceOver: {enabled, style? ≤200, gender?: 'female'|'male'|'neutral'},
  music: {enabled, mood? ≤200}, referenceAssetIds: Id[] ≤20 default []}` + refine: custom aspect/resolution needs custom dims (even, 16..8192).
- `CreativeBriefSchema` (LLM): `{title, logline ≤300, objective, targetAudience, tone: string[] 1..6, genre, visualStyle:
  {description, palette: Hex[] 2..8, typography, motionLanguage}, keyMessages: string[] 1..10, callToAction: string|null,
  referenceInfluence: string|null, brandConsistencyNotes: string}`.
- `ScriptOutlineSchema` (LLM): `{chapters: {id, title, summary, targetDurationSeconds (>0)}[] (≥1)}`.
- `ChapterScriptSchema` (LLM): `{chapterId, segments: {id, voiceOver: string|null, onScreenText: string|null, visualIntent, targetDurationSeconds}[] (≥1)}`.
- `ScriptSchema` (assembled): `{language, chapters: {id, title, summary, targetDurationSeconds, segments: Segment[]}[]}`.
- `StoryboardSceneSchema` (LLM): `{id, chapterId, segmentIds: string[], title, visualDescription, voiceOver: string|null,
  onScreenText: string|null, durationSeconds (>0), mood, shotType, transitionIn: TransitionType}`; `ChapterStoryboardSchema {chapterId, scenes: StoryboardScene[]}`; `StoryboardSchema {scenes}`.
- `ShotSchema` (LLM) `{id, shotType, cameraMovement, subject, durationSeconds, notes: string|null}`; `ChapterShotListSchema {chapterId, scenes: {sceneId, shots: Shot[] (1..8)}[]}`; `ShotListSchema {scenes}`.
- `EngineChoiceSchema` (LLM) `{sceneId, engine: EngineType, template: string|null, provider: string|null, rationale ≤500}`; `ChapterEngineSelectionSchema {chapterId, choices}`; `EngineSelectionSchema {choices}`.
- `SceneSpecSchema` (assembled; LLM-facing per-template variant built by the director from the catalog):
  `{sceneId, engine: 'motion2d'|'three', template: TemplateId, props: Record<string, JsonValue>, cameraPreset: CameraPreset|null}`; `SceneSpecsSchema {scenes}`.
- `DirectorArtifactsSchema {brief, outline, script, storyboard, shotList, engineSelection, sceneSpecs}`.
- `DirectorStageSchema`: `'brief'|'outline'|'script'|'storyboard'|'shotList'|'engineSelection'|'sceneSpecs'|'compile'`.
- `TokenUsageSchema {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}` (ints ≥0).
- `StageUsageSchema {stage, chunk: string|null, provider, model, attempts (int ≥1), cached, usage: TokenUsage, estimatedCostUsd ≥0, pricingKnown, latencyMs}`.
- `UsageReportSchema {stages: StageUsage[], totals: TokenUsage & {estimatedCostUsd, calls, cachedCalls}}`.

### 1.16 template catalog (`templates/`)
`TemplateDefinition<P extends z.ZodObject>`: `{id, engine: 'motion2d'|'three', name, description (what it looks like, when to use),
genres: VideoGenre[], propsSchema: P (LLM-safe: closed, all-required, nullable for optional, no records/recursion),
minDurationSeconds, buildProps(ctx: TemplatePropsContext) → z.infer<P>}`.
`TemplatePropsContext {title: string, text: string | null, bullets: string[], palette: string[] (hex, ≥2), brandName: string | null}`
— `buildProps` deterministically produces VALID props (used by the heuristic mock and by engine-fallback coercion).
M1 templates (ids exactly):
- motion2d: `title-card` {headline, subheadline|null, align 'left'|'center', background {style 'solid'|'gradient', colors Hex[1..3]}, accentColor}
  · `kinetic-text` {lines string[1..6], emphasis string|null, style 'bold'|'minimal'|'playful', color, backgroundColor}
  · `bullet-list` {title, bullets string[1..6], marker 'check'|'dot'|'number', accentColor, backgroundColor}
  · `quote` {quote, attribution|null, accentColor, backgroundColor}
  · `stat-counter` {value number, decimals int 0..3, prefix|null, suffix|null, label, accentColor, backgroundColor}
  · `step-instruction` (SOP) {stepNumber int ≥1, totalSteps int ≥1, title, instruction, caution|null, accentColor, backgroundColor}
  · `split-feature` {headline, body, mediaSide 'left'|'right', imageAssetId|null, imagePrompt|null, accentColor, backgroundColor}
  · `cta-end-card` {headline, callToAction, contactLine|null, accentColor, backgroundColor}
  · `cartoon-scene` (comedy/cartoon) {character 'blob'|'robot'|'cat'|'bird', expression 'happy'|'surprised'|'confused'|'angry'|'laughing',
    dialogue|null, setting 'room'|'office'|'park'|'space'|'stage', gag 'none'|'bounce'|'shake'|'spin'|'squash', backgroundColor}
  · `property-showcase` (real estate) {propertyName, location, price|null, features string[1..6], accentColor, backgroundColor}
  · `lower-third` {name, role|null, accentColor} (usable as scene or overlay)
- three: `product-turntable` {primitive 'box'|'cylinder'|'sphere'|'bottle'|'phone'|'can', color, metalness 0..1, roughness 0..1, headline|null, rotationTurns 0.25..4}
  · `logo-reveal-3d` {text, depth 0.05..2, color, accentColor}
  · `floating-shapes` {shapes 'spheres'|'cubes'|'torus'|'mixed', count int 3..40, palette Hex[2..5], headline|null}
Catalog API: `TEMPLATE_CATALOG`, `getTemplate(id)`, `listTemplates({engine?, genre?})`, `validateTemplateProps(id, props) → {success:true, data}|{success:false, issues: string[]}`,
`templateCatalogSummary()` (serializable: id, engine, name, description, genres, minDurationSeconds — no Zod objects).
`TemplateIdSchema` = string matching IdSchema (catalog membership is checked by the director, not by the timeline schema, so
future templates don't break old timelines).

### 1.17 API DTOs (`api.ts`) — the HTTP contract between studio-api and studio-web
- `CreateProjectRequestSchema = VideoRequestSchema`.
- `ProjectStatusSchema 'draft'|'directing'|'ready'|'failed'`; `DirectorRunStatusSchema 'queued'|'running'|'succeeded'|'failed'|'cancelled'`.
- `ProjectSummaryDTO {id, title, status, genre, durationSeconds, aspectRatio, createdAt, updatedAt (ISO strings), currentVersion: int|null}`.
- `DirectorRunDTO {id, projectId, status, provider, model, progress: {completedSteps, totalSteps, currentStage: DirectorStage|null, message: string|null},
  usage: UsageReport|null, error: {code, message}|null, versionNumber: int|null, createdAt, startedAt: string|null, finishedAt: string|null}`.
- `ProjectDetailDTO = ProjectSummary & {request: VideoRequest, latestRun: DirectorRunDTO|null}`.
- `ProjectVersionSummaryDTO {id, projectId, version, schemaVersion, createdAt, sceneCount, durationInFrames, fps}`;
  `ProjectVersionDTO = summary & {artifacts: DirectorArtifacts, timeline: Timeline}`.
- `SystemConfigDTO {aiProvider: {name, model, mode: 'mock'|'live', configured: boolean}, queueDriver: 'bullmq'|'inline',
  limits: ResourceLimits, engines: {engine: EngineType, available: boolean, reason: string|null}[],
  templates: ReturnType<typeof templateCatalogSummary>, promptVersion: string}`.
- `UsageSummaryDTO {today: UsageWindow, month: UsageWindow}`, `UsageWindow {runs, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, estimatedCostUsd}`.
- `ApiErrorSchema {error: {code: string, message: string, details?: unknown}}`; `paginated(item) → {items: T[], nextCursor: string|null}`.
- `CreateDirectorRunRequestSchema {}` (empty object; reserved), `MeDTO {id, email, name: string|null}`.

## 2. `@vc/ai-director` (packages/ai-director) — contract

### 2.1 Provider interface (`src/provider.ts`)
```ts
export interface StructuredGenerationRequest<T> {
  stage: DirectorStage; chunk: string | null;         // chunk = chapter id for chunked stages
  system: string;                                      // stable, cacheable stage system prompt
  prompt: string;                                      // rendered user content (data wrapped in XML-ish tags)
  input: unknown;                                      // structured stage input (mocks build output from this)
  schema: z.ZodType<T>; schemaName: string;            // output schema (LLM-safe)
  maxOutputTokens: number;
  signal?: AbortSignal;
}
export interface StructuredGenerationResult {
  output: unknown;        // NOT yet validated — the director validates with Zod + semantic checks
  usage: TokenUsage; provider: string; model: string; stopReason: string; latencyMs: number;
}
export interface AIProvider {
  readonly name: string; readonly model: string; readonly mode: 'mock' | 'live';
  generateStructured<T>(req: StructuredGenerationRequest<T>): Promise<StructuredGenerationResult>;
}
```
Errors (`src/errors.ts`): `DirectorError` base `{code: 'VALIDATION_FAILED'|'PROVIDER_REFUSAL'|'PROVIDER_UNAVAILABLE'|'PROVIDER_CONFIG'|'PROVIDER_REQUEST'|'PROVIDER_TRUNCATED'|'CANCELLED'|'LIMIT_EXCEEDED'|'INTERNAL', retryable, details?}` and subclasses.

### 2.2 Providers
- `HeuristicMockProvider` (`name 'mock'`, `model 'mock-director-v1'`, `mode 'mock'`): deterministic (seeded by a hash of the
  input), genre-aware outputs for EVERY stage built from `req.input`; must always produce schema-valid AND semantically valid
  output for the plan it is given (scene counts within range, durations summing to targets, valid template props via
  `buildProps`). Usage = estimated tokens (chars/4) so the UI shows realistic numbers; pricing for `mock-director-v1` is 0.
  This is the DEFAULT provider (`AI_PROVIDER=mock`) so the app works end-to-end without spending credits.
- `ScriptedMockProvider`: `new ScriptedMockProvider(handler: (req, callIndex) => unknown | Promise<unknown>)`; records `calls`
  (stage, chunk, prompt, input). Used in tests to inject invalid outputs, refusals, delays.
- `AnthropicProvider` (`mode 'live'`) — options `{apiKey?, model = 'claude-opus-5-5', effort = 'medium', maxOutputTokens = 16000,
  fallbacks: 'default'|'off' = 'default', structuredOutput: 'json_schema'|'prompt' = 'json_schema', timeoutMs = 600_000,
  maxRetries = 2, client?: AnthropicLikeClient}`. Facts from the current Claude API reference (do not deviate):
  - Default model `claude-opus-5-5` ($4 / $20 per MTok input/output, cache read $0.20, 5-min cache write 1.25× input).
  - On Opus 5.5: thinking cannot be disabled — OMIT the `thinking` param (adaptive by default); NEVER send `budget_tokens`,
    `temperature`, `top_p`, `top_k`, or an assistant prefill (all 400). Set effort explicitly: `output_config: {effort}`.
  - Forced `tool_choice` (`any`/`tool`) returns 400 on Opus 5.5 → use structured outputs instead:
    `output_config: { effort, format: { type: 'json_schema', schema: <JSON Schema> } }`.
  - JSON Schema limits for structured outputs: supported = object/array/string/integer/number/boolean/null, enum, const, anyOf,
    allOf, $ref/$defs, `additionalProperties: false` REQUIRED on every object; NOT supported = recursion, numeric constraints
    (minimum/maximum/exclusive*/multipleOf), string constraints (minLength/maxLength), complex array constraints
    (minItems/maxItems/uniqueItems), `additionalProperties` other than false, `oneOf` (convert to anyOf). Implement
    `toStructuredOutputSchema(zodSchema)`: `z.toJSONSchema(schema, {io: 'output'})` (Zod v4), then recursively strip
    `$schema` and unsupported keywords, convert `oneOf`→`anyOf`, force `additionalProperties: false` on objects, and keep
    `format` only if in {date-time,time,date,duration,email,hostname,uri,ipv4,ipv6,uuid}. Zod re-validates everything.
  - Refusal fallbacks ON by default: call `client.beta.messages.create({... , betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'})`
    (omit both when `fallbacks: 'off'`). Always check `stop_reason` before reading content: `'refusal'` → `ProviderRefusalError`
    (non-retryable; include `stop_details?.category`), `'max_tokens'` → `ProviderTruncatedError`.
  - System prompt as `system: [{type:'text', text, cache_control: {type:'ephemeral'}}]` (stable stage prompt first so it caches;
    volatile data only in the user message). Single user message; no multi-turn history (repairs are fresh single-turn requests).
  - Response: concatenate `content` blocks with `type === 'text'`, strip optional ``` fences, `JSON.parse`. Usage from
    `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens ?? 0`, `usage.cache_creation_input_tokens ?? 0`;
    served model = `response.model`.
  - Errors: use SDK typed classes (`Anthropic.AuthenticationError`, `PermissionDeniedError` → PROVIDER_CONFIG;
    `RateLimitError`, `InternalServerError`, `APIConnectionError`, `APIConnectionTimeoutError` → PROVIDER_UNAVAILABLE (retryable);
    `BadRequestError` → if `structuredOutput === 'json_schema'` and the message mentions schema/output_config/format, retry ONCE
    in prompt mode (JSON schema embedded in the prompt, no `format`), else PROVIDER_REQUEST). The SDK itself retries 408/409/429/5xx
    (`maxRetries`). Non-streaming requests with `max_tokens` ≤ 16000 (chunking keeps outputs small).
  - `AnthropicLikeClient` = minimal structural type `{ beta: { messages: { create(params: Record<string, unknown>, options?: {signal?: AbortSignal}): Promise<unknown> } } }`
    so tests inject a fake; the real client is `new Anthropic({apiKey, timeout, maxRetries})`. Validate the response shape
    defensively (narrow `unknown`). If the installed SDK types don't include `fallbacks`/`output_config`, build params as a
    plain object typed via the structural interface (no `any`).

### 2.3 Pricing / usage (`src/pricing.ts`, `src/usage.ts`)
`DEFAULT_PRICING: Record<string, {inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok}>`:
`claude-opus-5-5` 4/20/0.20/5.00 · `claude-opus-5` 5/25/0.50/6.25 · `claude-sonnet-5-5` 2/10/0.20/2.50 ·
`claude-haiku-5-5` 0.10/0.50/0.01/0.125 · `claude-opus-4-8` 5/25/0.50/6.25 · `mock-director-v1` 0/0/0/0.
`estimateCostUsd(model, usage, pricing) → {costUsd, pricingKnown}` (unknown model → 0 + pricingKnown false). Pricing overridable
via constructor (apps pass env JSON). `UsageTracker` accumulates `StageUsage[]` and produces `UsageReport`.

### 2.4 Cache (`src/cache.ts`)
`DirectorCache {get(key): Promise<CacheEntry|null>; set(key, entry): Promise<void>}`; `CacheEntry {output: unknown, usage, provider, model, createdAt}`;
`MemoryDirectorCache(maxEntries = 500)` (LRU). `computeCacheKey({stage, chunk, promptVersion, provider, model, schemaName, system, prompt})`
= sha256 hex of canonical (sorted-key) JSON. Only VALIDATED outputs are cached. A cache hit records a `StageUsage` with
`cached: true`, zero tokens, zero cost.

### 2.5 Planning (`src/planning.ts`)
`planStructure(request, references?, limits) → StructurePlan {fps, totalFrames, durationSeconds, chapterCount, chapterTargetSeconds: number[],
targetSceneSeconds, sceneCountRange: {min, max}, perChapterSceneRange: {min,max}[], chunked}`.
- Target scene seconds by genre: social-short 2.5, cinematic-ad 3, promo 3.5, comedy 4, cartoon 4, motion-graphics 4, product-3d 5,
  real-estate 5, reference-based 5 (or the reference profile's `pacing.averageShotSeconds` clamped 1.5..20 when present),
  explainer 7, sop-training 9, presentation 10, corporate-training 10, long-form 12.
- expectedScenes = clamp(round(duration / target), 1, limits.maxScenes); range = [max(1, floor(expected×0.75)), max(1, ceil(expected×1.25))],
  never more scenes than `floor(duration)` (≥1 s per scene; videos shorter than 1 s get exactly 1 scene).
- chapterCount = duration ≤ 120 s ? 1 : min(limits.maxChapters, max(ceil(duration / 300), ceil(expectedScenes / 24))).
  Chapter targets split the duration evenly (sum exact to 1e-6). Per-chapter scene ranges are proportional.
- Unbounded durations are supported (20 min, 2 h, more) subject only to `limits.maxDurationSeconds`; requests above the limit
  fail fast with `LIMIT_EXCEEDED` before any provider call.

### 2.6 Pipeline (`src/director.ts`) — `AIDirector`
```ts
new AIDirector({ provider, cache?, pricing?, limits?, maxRepairAttempts = 2, engineAvailability?, promptVersion?, logger?, idFactory? })
planProject(input: {request: VideoRequest, references?: ReferenceProfile[], assets?: AssetRef[]},
            opts?: {signal?: AbortSignal, onProgress?: (p: DirectorProgress) => void | Promise<void>}): Promise<DirectorResult>
regenerateScene(input: {request, references?, assets?, artifacts: DirectorArtifacts, sceneId: string, instructions?: string}, opts?): Promise<DirectorResult>
DirectorResult = {artifacts: DirectorArtifacts, timeline: Timeline, usage: UsageReport, warnings: string[], plan: StructurePlan}
DirectorProgress = {stage: DirectorStage, chunk: string|null, completedSteps: number, totalSteps: number, message: string}
EngineAvailability = Record<EngineType, {available: boolean, reason: string|null}>  // default: motion2d+three available; others unavailable ("no assets"/"no video provider configured")
```
Flow: `validate limits` → `brief` (1 call) → `outline` (1 call; for 1-chapter plans the outline is still requested so titles are
creative; semantic check: exactly `chapterCount` chapters, ids unique, durations sum within ±2 % of total — the director then
normalizes chapter targets to the plan exactly) → for each chapter sequentially (continuity: pass previous chapter title+summary):
`script` → `storyboard` → `shotList` → `engineSelection` → `sceneSpecs` → `compile` (deterministic, no LLM).
totalSteps = 2 + 5 × chapterCount + 1.
- Repair loop per call: provider output → Zod `safeParse` → semantic validator for the stage; on failure re-request as a FRESH
  single-turn prompt = original prompt + `<validation_errors>` (≤ 30 issues) + `<previous_output>` (truncated 20k chars), up to
  `maxRepairAttempts` extra attempts; then throw `DirectorError('VALIDATION_FAILED')` with issues. Provider refusals/config
  errors are not retried by the director.
- Semantic validators: outline as above; chapter script: segment ids unique, durations sum within ±10 % of chapter target, count
  within the chapter's scene range ×1.5 upper bound; storyboard: scene count within the chapter range, every scene references
  existing segmentIds, ids unique across the whole video (director prefixes/remaps ids to `c{n}-s{m}` to guarantee uniqueness),
  durations > 0; shotList: exactly one entry per storyboard scene; engineSelection: one choice per scene, template exists in
  the catalog for the chosen engine (motion2d/three) or null for others; sceneSpecs: one spec per scene, template === selection,
  props valid for the template.
- Engine selection coercion (deterministic, after validation): a choice whose engine is unavailable is coerced to `motion2d`
  with a genre-appropriate template (`title-card` for first scene, `cta-end-card` for last when CTA exists, else genre default),
  and a warning is recorded. `generated` is unavailable unless a video provider is configured (none in M1).
- Scene specs LLM schema = `z.object({chapterId, scenes: z.array(z.discriminatedUnion('template', CATALOG.map(t =>
  z.object({sceneId: z.string(), engine: z.literal(t.engine), template: z.literal(t.id), props: t.propsSchema, cameraPreset: CameraPresetSchema.nullable()}))))})`.
  The prompt includes only the templates relevant to that chapter's selection (ids + description + props JSON schema).
- Compiler (`src/compiler.ts`): `resolveDimensions`, `totalFrames = max(1, secondsToFrames(duration, fps))`,
  `allocateFrames(storyboard durations, totalFrames, minFrames = max(1, min(fps, floor(totalFrames / sceneCount))))`;
  chapters = spans of their scenes; content from sceneSpecs (motion2d/three; three gets environment/lighting from genre);
  camera = `expandCameraPreset(spec.cameraPreset ?? mapped from the first shot's cameraMovement, '2d'|'3d', frames)`;
  transitionIn from storyboard (first scene none; duration = min(round(0.5 × fps), floor(min(adjacent)/2)), `cut` → 0);
  narration = storyboard voiceOver; ONE caption track generated from voiceOver (cues of ≤ 7 words, frames proportional to word
  count within each scene, contiguous, no overlap, language = request.language) when voiceOver is enabled and text exists;
  brand = request.brand colors + brief palette mapped to {primary, secondary, accent, background, text} with sensible defaults;
  fonts default 'Inter'; assets = input assets (logo if referenced); metadata.generator = {name: 'vc-ai-director', version: '0.1.0', promptVersion}.
  Finally `TimelineSchema.parse` + `checkTimelineLimits` (violations → `LIMIT_EXCEEDED`).
- `regenerateScene`: keeps the scene's duration and id; re-runs storyboard (single scene, with optional user instructions),
  shotList, engineSelection, sceneSpecs for that scene only (chunk = sceneId), splices it into the artifacts and recompiles.
  Other scenes untouched (verified by test).
- Prompts (`src/prompts/`): one stable system prompt per stage + `renderPrompt(stage, input)`. Exported `PROMPT_VERSION = 'm1.0'`.
  Hardening: user prompt, style notes and reference data are wrapped in `<user_request>` / `<reference_profile>` tags and the
  system prompt states they are untrusted data, never instructions. Include genre guidance (pacing, tone, template preferences)
  and duration/scene-count targets from the plan. Never ask the model for code.
- Cancellation: check `signal.aborted` before every provider call and every chapter → `DirectorError('CANCELLED')`.

### 2.7 Tests (vitest, no network)
Schema-validation tests for every LLM-facing schema (valid + invalid fixtures); `toStructuredOutputSchema` strips unsupported
keywords and closes objects; full pipeline with HeuristicMockProvider for genres × durations {5 s, 30 s, 10 min, 25 min,
2 h} (timeline valid, frames sum exactly, chapters chunked, scene counts in range); repair loop (scripted invalid → valid);
repairs exhausted → VALIDATION_FAILED; cache: second identical run makes 0 provider calls and reports cachedCalls; cost math;
engine coercion warning; regenerateScene keeps other scenes identical and timing unchanged; cancellation; limit exceeded before
any call; AnthropicProvider request shape (model, output_config.effort/format, system cache_control, betas+fallbacks, no
thinking/temperature) and response handling (text extraction, usage mapping, refusal, max_tokens, BadRequest → prompt-mode retry)
using an injected fake client.

## 3. `@vc/studio-api` (apps/studio-api) — contract

Stack: Fastify 5, Prisma 7.10 with `prisma-client` generator (output `src/generated/prisma`, gitignored) + `@prisma/adapter-pg`,
`prisma.config.ts` (datasource url from `DATABASE_URL`), BullMQ 5 + ioredis 5, Zod v4 for env + body validation.
Verified locally: `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })` with
`import { PrismaClient } from './generated/prisma/client'` works.

Prisma models (PascalCase models, camelCase fields, `@@map` to snake_case tables):
`User {id cuid, email unique, name?, createdAt, updatedAt}` · `ApiToken {id, userId → User (cascade), label, tokenHash unique (sha256 hex), createdAt, lastUsedAt?, revokedAt?}` ·
`Project {id, ownerId → User (cascade), title, genre, durationSeconds Float, aspectRatio, status ProjectStatus(DRAFT,DIRECTING,READY,FAILED),
request Json, currentVersionId? unique → ProjectVersion, createdAt, updatedAt; @@index([ownerId, updatedAt])}` ·
`ProjectVersion {id, projectId → Project (cascade), version Int, schemaVersion Int, timeline Json, artifacts Json, directorRunId?, createdAt; @@unique([projectId, version])}` ·
`DirectorRun {id, projectId → Project (cascade), requestedById → User, status RunStatus(QUEUED,RUNNING,SUCCEEDED,FAILED,CANCELLED),
provider, model, promptVersion, progress Json, usage Json?, inputTokens Int, outputTokens Int, cacheReadTokens Int, cacheWriteTokens Int,
estimatedCostUsd Decimal(12,6), errorCode?, errorMessage?, createdAt, startedAt?, finishedAt?; @@index([projectId, createdAt]), @@index([requestedById, createdAt])}` ·
`DirectorCacheEntry {key String @id, stage, model, provider, output Json, usage Json, hits Int @default(0), createdAt, lastHitAt?}`.
Create the initial migration with `pnpm --filter @vc/studio-api exec prisma migrate dev --name init` (DATABASE_URL →
`video_studio`) and commit the migration SQL (in `prisma/migrations`).

Env (`src/config.ts`, Zod; document every var in `.env.example`): `NODE_ENV`, `STUDIO_API_HOST=0.0.0.0`, `STUDIO_API_PORT=4100`,
`DATABASE_URL`, `REDIS_URL`, `QUEUE_DRIVER=bullmq|inline`, `CORS_ORIGINS=http://localhost:3000` (comma list), `LOG_LEVEL=info`,
`AI_PROVIDER=mock|anthropic` (default mock), `ANTHROPIC_API_KEY` (required iff AI_PROVIDER=anthropic), `ANTHROPIC_MODEL=claude-opus-5-5`,
`ANTHROPIC_EFFORT=medium`, `ANTHROPIC_MAX_OUTPUT_TOKENS=16000`, `ANTHROPIC_FALLBACKS=default|off`, `ANTHROPIC_STRUCTURED_OUTPUT=json_schema|prompt`,
`DIRECTOR_MAX_REPAIR_ATTEMPTS=2`, `DIRECTOR_RUN_TIMEOUT_MS=1800000`, `DIRECTOR_CACHE=on|off`, `DIRECTOR_PRICING_JSON` (optional override),
`DIRECTOR_WORKER_CONCURRENCY=2`, limits `LIMIT_MAX_DURATION_SECONDS=7200`, `LIMIT_MAX_WIDTH=3840`, `LIMIT_MAX_HEIGHT=3840`,
`LIMIT_MAX_FPS=60`, `LIMIT_MAX_SCENES=2000`, `LIMIT_MAX_CHAPTERS=200`, `LIMIT_MAX_PROMPT_CHARS=20000`,
`LIMIT_DIRECTOR_RUNS_PER_DAY=50`, `LIMIT_DIRECTOR_USD_PER_DAY=25`, `RATE_LIMIT_PER_MINUTE=300`,
`STUDIO_DEV_USER_EMAIL=dev@localhost`, `STUDIO_DEV_API_TOKEN` (≥ 32 chars; used only by the seed script).
Secrets never logged (pino `redact` authorization + api keys); `/v1/system/config` never returns secrets.

Layout: `src/config.ts`, `src/db.ts`, `src/app.ts` (`buildApp(deps: {config, prisma, queue, directorFactory?, logger?})` — tests
build the app with the inline queue + mock provider), `src/server.ts`, `src/worker.ts`, `src/plugins/{auth,errors}.ts`,
`src/routes/{health,me,system,projects,director-runs,usage}.ts`, `src/services/*.ts`, `src/queue/{types,bullmq,inline}.ts`,
`src/director/{factory,prisma-cache,process-run}.ts`, `src/lib/{tokens,dto}.ts`, `src/scripts/seed.ts`, `test/*.test.ts`,
`vitest.config.ts` (`fileParallelism: false`; test DB `video_studio_test` migrated with `prisma migrate deploy` in a global setup
and tables truncated between tests).

Endpoints (JSON; all `/v1/*` require `Authorization: Bearer <token>`; 401 `UNAUTHORIZED` otherwise):
- `GET /health` (public) → `{ok: true, version}`; `GET /v1/me` → MeDTO.
- `GET /v1/system/config` → SystemConfigDTO (engines: motion2d/three available; footage/image/screen "requires uploaded assets
  (Milestone 3)"; generated "no video generation provider configured").
- `GET /v1/projects?limit=20&cursor=` → paginated ProjectSummaryDTO (owner-scoped, updatedAt desc, cursor = id).
- `POST /v1/projects` (body CreateProjectRequest; also `checkVideoRequestLimits` → 422 `LIMIT_EXCEEDED`) → 201 ProjectDetailDTO.
- `GET /v1/projects/:id` → ProjectDetailDTO; `DELETE /v1/projects/:id` → 204 (refuse 409 while a run is active).
- `POST /v1/projects/:id/director-runs` → 202 DirectorRunDTO; 409 `RUN_ACTIVE` if queued/running run exists; 429 `QUOTA_EXCEEDED`
  when the user's runs today ≥ limit or estimated cost today ≥ USD limit. Sets project status DIRECTING and enqueues `{runId}`.
- `GET /v1/projects/:id/director-runs` → DirectorRunDTO[] (latest 20); `GET /v1/director-runs/:runId` → DirectorRunDTO;
  `POST /v1/director-runs/:runId/cancel` → DirectorRunDTO (QUEUED/RUNNING → CANCELLED; else 409).
- `GET /v1/projects/:id/versions` → ProjectVersionSummaryDTO[]; `GET /v1/projects/:id/versions/:version` → ProjectVersionDTO.
- `GET /v1/usage` → UsageSummaryDTO (from DirectorRun rows of the user; today = UTC day).
Authorization: every project/run query is scoped by owner (`ownerId: user.id`); foreign or missing ids → 404 `NOT_FOUND`.
Errors: `{error: {code, message, details?}}`; ZodError → 400 `VALIDATION_ERROR` with issues; unknown → 500 `INTERNAL` (no stack).
Body limit 1 MB; `@fastify/rate-limit` per token (RATE_LIMIT_PER_MINUTE); CORS from env.

Run processing (`src/director/process-run.ts`, used by BullMQ worker AND inline queue): load run+project; skip unless QUEUED;
mark RUNNING (startedAt); build `AIDirector` (provider from config via factory, `PrismaDirectorCache` when DIRECTOR_CACHE=on,
limits, engine availability); `planProject` with `onProgress` → persist progress (throttle ≥ 500 ms) and check for cancellation
(run status CANCELLED in DB → abort the AbortController); overall timeout via `DIRECTOR_RUN_TIMEOUT_MS`. Success (transaction):
create ProjectVersion (version = max + 1, timeline, artifacts), run SUCCEEDED (usage totals + JSON, finishedAt), project READY +
currentVersionId. Failure: run FAILED (errorCode = DirectorError code or INTERNAL, sanitized message), project READY if it
already has a version else FAILED. Cancelled: run CANCELLED, project status restored the same way. Queue: BullMQ queue
`studio-director`, `attempts: 1`, `removeOnComplete: 1000`, `removeOnFail: 5000`; worker concurrency from env; graceful shutdown.
Inline queue: processes jobs asynchronously in-process and exposes `onIdle(): Promise<void>` for tests.
Seed script: upsert dev user + hashed `STUDIO_DEV_API_TOKEN`; prints nothing secret.
Tests (Fastify `inject`, inline queue, HeuristicMockProvider or ScriptedMockProvider, real Postgres test DB): health; 401 without
/with bad token; create/list/get/delete project; validation 400; limits 422; owner isolation (user B gets 404 on A's project/run);
director run end-to-end → version 1 with valid timeline (re-parse with TimelineSchema) and usage; second run → version 2 and cache
hits (0 new tokens); 409 concurrent run; cancel; quota 429; provider failure → run FAILED with code; system config has no secrets.

## 4. `@vc/studio-web` (apps/studio-web) — contract
Next.js 16 App Router (`src/app`), React 19, TypeScript strict, Tailwind CSS v4 (`@tailwindcss/postcss`, `src/app/globals.css`
with `@import "tailwindcss";` + CSS-variable theme tokens and dark mode), shadcn/ui-style components hand-written in
`src/components/ui/` (button, card, input, textarea, label, badge, select (Radix), tabs (Radix), switch (Radix), progress (Radix),
separator) + `src/lib/utils.ts` (`cn`). `next.config.ts`: `transpilePackages: ['@vc/schema']`.
Server-only API access: `src/lib/studio-api.ts` reads `STUDIO_API_URL` + `STUDIO_API_TOKEN` (never `NEXT_PUBLIC_`), validates
every response with the `@vc/schema` DTO schemas, throws typed errors. Mutations are Server Actions; client polling goes through
a Next route handler `src/app/api/runs/[runId]/route.ts` that proxies server-side (token never reaches the browser).
All pages `export const dynamic = 'force-dynamic'` (no build-time API calls).
Pages: `/` dashboard (stat cards: projects, runs today, tokens + est. cost this month; recent projects table; empty state);
`/projects/new` (form: title, prompt, genre, style notes, duration value + unit s/min/h (no hardcoded max; show configured limit
from system config), aspect ratio incl. custom W×H, resolution, fps, language, brand colors (color inputs, up to 5) + brand name,
voice-over toggle/style/gender, music toggle/mood — validated with VideoRequestSchema in the server action → create project →
start director run → redirect); `/projects/[id]` (header with status badge + run progress bar, Cancel / Re-run buttons wired to
real endpoints, tabs: Storyboard (scene cards with timecodes, duration, engine+template badges, shot info, VO, on-screen text),
Preview (Remotion `<Player>` animatic of the timeline: each scene a branded card showing scene title + primary template text +
engine badge, caption cue overlay, fade/slide transitions, using the timeline's integer frames), Brief, Script, Shot list,
Timeline JSON (pretty-printed, copy button), Usage (per-stage table: stage, chunk, attempts, cached, tokens, est. cost));
`/settings` (AI provider mode/model/configured, queue driver, limits, engine availability with reasons, template catalog).
`loading.tsx`, `error.tsx`, `not-found.tsx`. No fake buttons: only show actions that work. `.env.example` with
`STUDIO_API_URL=http://localhost:4100`, `STUDIO_API_TOKEN=`. Tests: vitest for pure helpers (duration formatting/parsing,
form → VideoRequest mapping). `pnpm --filter @vc/studio-web build` must pass.

## 5. Docs
`docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/AI_DIRECTOR.md`, `docs/TIMELINE_SCHEMA.md`, `docs/DATABASE.md`, `docs/ROADMAP.md`,
`docs/DECISIONS.md`, `docs/DEVELOPMENT.md` (env vars + local startup). Mermaid diagrams (```mermaid fences) where helpful;
GitHub-renderable. Must match the code that ships; mark future milestones explicitly as planned (never claim unbuilt features exist).

Roadmap milestones: M1 Foundation (this) · M2 Remotion 2D engine + render pipeline (template components, frame-range segment
rendering, FFmpeg assembly, render queue/progress/cancel, export validation) + basic editor (scene list/reorder, text & color
edits, regenerate scene endpoint/UI, project versions UI) · M3 Assets & reference analysis (S3/MinIO storage, uploads with size +
MIME sniffing, ffprobe metadata, keyframe/scene sampling, palette, transcription adapter, camera-movement classification,
ReferenceProfile generation, Claude vision on sampled frames) · M4 Voice & music (TTS/music provider adapters, VO alignment,
word-timed captions, ducking, loudness normalization) · M5 3D engine (React Three Fiber + @remotion/three + Drei, GLB uploads,
camera presets) · M6 Generative video & footage (provider adapters e.g. Runway/Kling/Pika — not connected until configured,
async jobs, cost controls; footage/screen/image engines) · M7 Long-form at scale (distributed chapter/segment rendering,
resumable renders, > 20 min validation, editor v2 tracks/transitions/audio, campaigns MVP merged as a module) · M8 Production
hardening (OIDC auth, teams, billing/quotas, observability, sandboxed workers, backups, CDN).
