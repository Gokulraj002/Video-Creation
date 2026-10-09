# Universal Timeline schema (v1)

| | |
|---|---|
| Document status | Living document. Revised whenever the timeline schema changes. |
| Last updated | 2026-10-09 |
| Current milestone | **M1 Foundation (in progress)**. See [ROADMAP.md](ROADMAP.md). |
| Schema version | **`schemaVersion: 1`** (`CURRENT_TIMELINE_VERSION = 1`) |
| Source of truth | **`packages/schema/src/`** (`@vc/schema`) and its tests in `packages/schema/test/` |
| Contract | [M1 spec, section 1](milestones/M1_IMPLEMENTATION_SPEC.md#1-vcschema-packagesschema--contract). The differences are listed in [section 17](#17-differences-from-the-m1-spec). |
| Related | [ARCHITECTURE.md](ARCHITECTURE.md) · [AI_DIRECTOR.md](AI_DIRECTOR.md) · [DATABASE.md](DATABASE.md) · [DECISIONS.md](DECISIONS.md) ([ADR-005](DECISIONS.md#adr-005-zod-v4-as-the-single-source-of-truth-json-schema-derived-for-llm-outputs), [ADR-008](DECISIONS.md#adr-008-deterministic-compilation-the-llm-plans-in-seconds-code-allocates-frames), [ADR-009](DECISIONS.md#adr-009-fixed-template-catalog-with-per-template-zod-props-never-llm-generated-code), [ADR-011](DECISIONS.md#adr-011-integer-frames-and-a-versioned-timeline-with-migrations), [ADR-016](DECISIONS.md#adr-016-configurable-resource-limits-instead-of-hardcoded-duration-caps)) |

> **The Zod schemas in `packages/schema/src/` are the source of truth.** This document describes Timeline v1 as it is
> implemented in that code and its 620 passing tests. If the code and this document disagree, the code is right and this
> document has a bug. Every rule, bound and error message below was read from the source. The behaviour that is not obvious
> from reading the source (which errors suppress the invariant pass, preset keyframes, allocation results, both examples) was
> also checked by running the code against Zod 4.6.5.

**Status labels.** Everything described here exists in M1 code unless it is marked **Planned (Mx)**. In M1 the timeline is
produced by the AI Director and consumed by the API, the database and the web preview. The renderers that will turn it into
a video file are **planned (M2 for 2D, M5 for 3D, M6 for footage and generated video)**.

## Contents

1. [What the timeline is](#1-what-the-timeline-is)
2. [Design goals](#2-design-goals)
3. [Structure at a glance](#3-structure-at-a-glance)
4. [Field reference](#4-field-reference)
5. [Validation and the nine invariants](#5-validation-and-the-nine-invariants)
6. [Frame math](#6-frame-math)
7. [Camera tracks and presets](#7-camera-tracks-and-presets)
8. [Transitions](#8-transitions)
9. [Tracks](#9-tracks)
10. [Asset references and `SafeUri`](#10-asset-references-and-safeuri)
11. [Template catalog](#11-template-catalog)
12. [LLM-safe schema rules](#12-llm-safe-schema-rules)
13. [Resource limits](#13-resource-limits)
14. [Versioning and migrations](#14-versioning-and-migrations)
15. [Examples](#15-examples)
16. [`ReferenceProfile` schema](#16-referenceprofile-schema)
17. [Differences from the M1 spec](#17-differences-from-the-m1-spec)
18. [Source map](#18-source-map)

---

## 1. What the timeline is

A **timeline** is one JSON document that describes a complete video: render settings, a brand kit, the assets it uses,
chapters, a contiguous sequence of scenes, and parallel tracks (audio, captions, overlays, video clips). All positions and
durations are integer frames.

```mermaid
flowchart LR
  REQ["VideoRequest<br/>(user input, seconds)"] --> DIR["AI Director stages<br/>(LLM output in seconds,<br/>validated by Zod)"]
  DIR --> COMP["Deterministic compiler<br/>secondsToFrames · allocateFrames<br/>expandCameraPreset"]
  COMP --> TL["Timeline v1<br/>(integer frames)"]
  TL --> DB[("ProjectVersion.timeline<br/>(Postgres JSON)")]
  DB -->|parseTimeline on read| API["studio-api DTOs"]
  API --> WEB["studio-web<br/>Remotion Player animatic"]
  TL -.-> R2["Renderers<br/>Planned (M2, M5, M6)"]
```

- The AI Director never asks the model for a timeline. The model produces artifacts measured in seconds (brief, outline,
  script, storyboard, shot list, engine selection, scene specs). The compiler in `packages/ai-director/src/compiler.ts` turns
  them into a timeline and then calls `TimelineSchema.safeParse` and `checkTimelineLimits`.
- `apps/studio-api` stores the timeline in `ProjectVersion.timeline` together with its `schemaVersion`. On every read it goes
  through `parseTimeline`, so older stored versions are migrated before they are served (`apps/studio-api/src/lib/dto.ts`,
  `toVersionDto`).
- `apps/studio-web` receives the timeline inside `ProjectVersionDTO` and validates it with the same `@vc/schema` package.

## 2. Design goals

1. **Integer frame positions.** Every position and duration is an integer number of frames at `settings.fps`. `FrameSchema`
   is an integer ≥ 0 and `DurationFramesSchema` is an integer ≥ 1. `fps` is an integer from 1 to 240. Sums are exact, scene
   boundaries never drift, and segment rendering (planned, M2) can cut at exact frames. Fractional broadcast rates such as
   29.97 fps cannot be represented in v1 ([ADR-011](DECISIONS.md#adr-011-integer-frames-and-a-versioned-timeline-with-migrations)).
2. **One global id namespace.** Chapters, scenes, assets, tracks, track items and 2D layers share a single id space
   ([invariant 3](#invariant-3-one-global-id-namespace)). Any id identifies exactly one entity, so an editor, a comment or a
   render job can address an entity by id alone.
3. **`schemaVersion` plus migrations.** Every document carries `schemaVersion`. `parseTimeline` runs the registered
   migrations (version N to N + 1) before validation, so stored timelines stay readable as the schema evolves.
   [Section 14](#14-versioning-and-migrations) covers the details.
4. **Isomorphic Zod validation.** `@vc/schema` depends only on `zod` (^4.6.5). It uses no Node built-ins (`SafeUriSchema`
   relies on the global `URL`, which browsers and Node both provide). It is consumed as TypeScript source
   (`"exports": {".": "./src/index.ts"}`; `apps/studio-web/next.config.ts` lists it in `transpilePackages`). The director,
   the API and the web app therefore validate with the same code, the same bounds and the same error messages.
5. **Engine-agnostic scenes.** Every scene has the same envelope (timing, chapter, camera, transition, narration). Only
   `content` depends on the engine. It is a discriminated union over six engines (`motion2d`, `three`, `footage`,
   `generated`, `image`, `screen`). Template ids are open strings and template props are generic JSON, so new templates and
   new engine renderers can arrive without a timeline schema change.
6. **The LLM never emits frame numbers.** The schemas the model must fill ([section 12](#12-llm-safe-schema-rules)) measure
   time in seconds (`targetDurationSeconds`, `durationSeconds`) and describe motion with enums (`cameraMovement`,
   `cameraPreset`, `transitionIn: TransitionType`). Frames, keyframes and transition lengths are computed by deterministic code
   ([ADR-008](DECISIONS.md#adr-008-deterministic-compilation-the-llm-plans-in-seconds-code-allocates-frames)).
7. **Precise, machine-readable errors.** Every invariant violation is a Zod issue with an exact `path` (for example
   `scenes.3.content.assetId`). Issues can be shown in the UI or fed back to a repair loop as they are.
8. **Configurable limits, not hard caps.** The schema has sanity bounds (dimensions up to 8192 px, 500 keyframes per camera
   track). Product limits such as maximum duration or scene count are a separate, configurable check
   ([section 13](#13-resource-limits)).

## 3. Structure at a glance

```mermaid
classDiagram
  direction TB
  class Timeline {
    +schemaVersion: 1
    +id: Id
    +title: string
    +durationInFrames: int
    +brand?: BrandKit
    +assets: List~AssetRef~
    +chapters: List~Chapter~
    +scenes: List~Scene~
    +tracks: List~Track~
  }
  class RenderSettings {
    +width: even int
    +height: even int
    +fps: int
    +backgroundColor: Hex
    +sampleRate: int
    +videoCodec: enum
    +audioCodec: enum
  }
  class TimelineMetadata {
    +generator: TimelineGenerator
    +language?: LanguageTag
    +createdAt?: IsoDateTime
  }
  class BrandKit {
    +name?: string
    +colors: BrandColors
    +fonts: BrandFonts
    +logoAssetId?: Id
  }
  class AssetRef {
    +id: Id
    +kind: AssetKind
    +uri: SafeUri
    +mimeType: string
    +source: AssetSource
  }
  class Chapter {
    +id: Id
    +title: string
    +startFrame: int
    +durationInFrames: int
  }
  class Scene {
    +id: Id
    +chapterId: Id
    +title: string
    +startFrame: int
    +durationInFrames: int
    +content: SceneContent
    +camera?: CameraTrack
    +transitionIn?: Transition
    +narration?: Narration
  }
  class SceneContent {
    <<union>>
    +engine: EngineType
  }
  class Motion2DContent {
    +engine: motion2d
    +template: TemplateId
    +props: JsonObject
    +layers: List~Layer2D~
  }
  class ThreeContent {
    +engine: three
    +template: TemplateId
    +props: JsonObject
    +modelAssetId?: Id
    +environment: enum
    +lighting: enum
  }
  class FootageContent {
    +engine: footage
    +assetId: Id
    +trimStartFrame: int
    +playbackRate: number
  }
  class GeneratedContent {
    +engine: generated
    +provider: Id
    +prompt: string
    +status: enum
    +assetId?: Id
  }
  class ImageContent {
    +engine: image
    +assetId: Id
    +animation: enum
    +focalPoint: FocalPoint
  }
  class ScreenContent {
    +engine: screen
    +assetId: Id
    +zoomRegions: List~ZoomRegion~
    +highlightCursor: boolean
  }
  class Layer2D {
    <<union>>
    +type: text, shape or image
    +startFrame: int
    +durationInFrames: int
  }
  class CameraTrack {
    <<union>>
    +space: 2d or 3d
    +preset?: CameraPreset
    +keyframes: List
  }
  class Transition {
    +type: TransitionType
    +durationInFrames: int
    +direction?: enum
    +easing: Easing
  }
  class Narration {
    +text: string
    +voiceId?: string
    +language?: LanguageTag
  }
  class Track {
    <<union>>
    +id: Id
    +kind: TrackKind
    +items: List
  }
  class AudioTrack {
    +kind: audio
    +role: enum
    +volume: number
  }
  class CaptionTrack {
    +kind: caption
    +language: LanguageTag
    +style: CaptionStyle
  }
  class OverlayTrack {
    +kind: overlay
  }
  class VideoTrack {
    +kind: video
  }
  class OverlayItem {
    +content: OverlayContent
    +opacity: number
    +zIndex: int
  }

  Timeline "1" *-- "1" RenderSettings : settings
  Timeline "1" *-- "1" TimelineMetadata : metadata
  Timeline "1" *-- "0..1" BrandKit : brand
  Timeline "1" *-- "0..*" AssetRef : assets
  Timeline "1" *-- "1..*" Chapter : chapters
  Timeline "1" *-- "1..*" Scene : scenes
  Timeline "1" *-- "0..*" Track : tracks
  Scene "1..*" --> "1" Chapter : chapterId
  Scene "1" *-- "1" SceneContent : content
  Scene "1" *-- "0..1" CameraTrack : camera
  Scene "1" *-- "0..1" Transition : transitionIn
  Scene "1" *-- "0..1" Narration : narration
  SceneContent <|-- Motion2DContent
  SceneContent <|-- ThreeContent
  SceneContent <|-- FootageContent
  SceneContent <|-- GeneratedContent
  SceneContent <|-- ImageContent
  SceneContent <|-- ScreenContent
  Motion2DContent "1" *-- "0..500" Layer2D : layers
  Track <|-- AudioTrack
  Track <|-- CaptionTrack
  Track <|-- OverlayTrack
  Track <|-- VideoTrack
  OverlayTrack "1" *-- "0..*" OverlayItem : items
  OverlayItem --> Motion2DContent : content
  OverlayItem --> ImageContent : content
  BrandKit ..> AssetRef : logoAssetId
```

The diagram omits most asset references. [Invariant 4](#invariant-4-asset-references-exist-and-have-a-compatible-kind)
lists all eleven of them.

### Conventions

| Convention | Rule |
|---|---|
| Absolute frames | `chapters[].startFrame`, `scenes[].startFrame` and every track item's `startFrame` are timeline frames counted from 0. |
| Relative frames | Layer `startFrame`, camera keyframe `frame` and `zoomRegions[].startFrame` are relative to the start of their container: the scene, or the overlay item for layers inside overlay content. |
| Source offsets | `trimStartFrame` (footage, screen, audio and video items) is a frame offset into the source media. v1 does not check it against the asset's length. |
| Normalized coordinates | 2D positions and sizes (`x`, `y`, `width`, `height`, `maxWidth`, `focalPoint`) are in `[0, 1]` of the frame. The code documents text-layer `x`/`y` as the center. |
| Colors | `#RRGGBB` or `#RRGGBBAA`. |
| Numbers | Zod 4 rejects `NaN` and `±Infinity` for every number field. |
| Unknown keys | Objects are Zod's default "strip" objects. **Unknown keys are removed silently**, so a misspelled optional field (for example `transitionln`) is dropped without an error. |
| Defaults | The only default in the timeline is `layers: []` on `motion2d` content, which also covers overlay items. `Timeline` is the *output* type. Use `z.input<typeof TimelineSchema>` for documents that may omit `layers`. |
| Absent vs. `null` | Optional fields are omitted when unused. `null` is not accepted anywhere in the timeline, except inside template `props`, which are free JSON. |

## 4. Field reference

"Req." is **yes** for required fields, **no** for optional ones, and **default** where Zod fills in a value. Bounds are
inclusive unless written as `(a, b]`.

### 4.1 Primitives (`common.ts`)

| Schema | Type | Rule |
|---|---|---|
| `IdSchema` | string | `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`: 1 to 64 characters of letters, digits, `_` and `-`, starting with a letter or digit. Case-sensitive. Rejects `''`, `-a`, `a b`, `a.b`, `a/b`, `é` and 65 characters. |
| `TemplateIdSchema` | string | Same as `IdSchema`. **No catalog check** ([section 11.3](#113-why-the-timeline-does-not-check-catalog-membership)). |
| `HexColorSchema` | string | `/^#(?:[0-9a-fA-F]{6}\|[0-9a-fA-F]{8})$/`. Rejects `#fff`, `red` and `000000`. |
| `FrameSchema` | number | Integer ≥ 0. |
| `DurationFramesSchema` | number | Integer ≥ 1. |
| `NormalizedSchema` | number | 0 ≤ v ≤ 1. |
| `EasingSchema` | enum | `linear`, `ease-in`, `ease-out`, `ease-in-out`, `spring`. |
| `FontFamilySchema` | string | `/^[A-Za-z0-9 \-]{1,64}$/`: letters, digits, spaces and hyphens only, so no quotes, semicolons or `url(`. Rejects `Inter;` and `Inter'`. |
| `LanguageTagSchema` | string | `/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/`. Accepts `en`, `en-US`, `pt-BR`, `zh-Hant`, `es-419` and `yue`. Rejects `EN`, `en_US` and `english`. |
| `IsoDateTimeSchema` | string | `z.iso.datetime({ offset: true })`. Seconds are required and fractions are allowed. A `Z` or `±hh:mm` offset is required: `2026-10-09T08:00:00Z` and `2026-10-09T08:00:00.123+02:00` pass, `2026-10-09T08:00:00` and `2026-10-09T08:00Z` fail. |
| `JsonValueSchema` | JSON | Strings ≤ 10 000 characters, finite numbers, booleans, `null`, arrays ≤ 500 items, objects ≤ 200 keys, at most 8 nested containers (`JSON_LIMITS`). Built level by level without `z.lazy`, so it converts to JSON Schema. |
| `JsonObjectSchema` | object | Record of JSON values with ≤ 200 keys. The object counts as one level, so its values may nest at most 7 more containers. Used for template `props`. |
| `SafeUriSchema` | string | See [section 10.2](#102-safeuri-rules). |

`formatZodIssues(error, maxIssues = 50)` formats issues as `path: message`. Paths are joined with `.`, and a top-level issue
uses `(root)`.

### 4.2 `TimelineSchema` (top level, `timeline.ts`)

`TimelineSchema = TimelineBaseSchema.superRefine(invariants)`. `TimelineBaseSchema` is the same object without the cross-field
invariants. It is exported for tooling that needs a structural check only.

| Field | Type | Req. | Notes |
|---|---|---|---|
| `schemaVersion` | literal `1` | yes | `z.literal(CURRENT_TIMELINE_VERSION)`. `migrateTimeline` reads it before parsing. |
| `id` | `Id` | yes | Identifies the timeline. It is **not** part of the global id namespace, so a scene may reuse it. |
| `title` | string ≤ 200 | yes | May be empty. |
| `settings` | [`RenderSettings`](#43-rendersettings-render-settingsts) | yes | |
| `durationInFrames` | int ≥ 1 | yes | Total length. Scenes and chapters must end exactly here. |
| `brand` | [`BrandKit`](#48-brandkit-brandts) | no | |
| `assets` | [`AssetRef`](#414-assetref-assetsts)`[]` | yes | May be `[]`. No schema maximum; `maxAssets` applies ([section 13](#13-resource-limits)). Unreferenced assets are allowed. |
| `chapters` | [`Chapter`](#44-chapter-chapterts)`[]` | yes | At least 1. |
| `scenes` | [`Scene`](#45-scene-scenets)`[]` | yes | At least 1. |
| `tracks` | [`Track`](#412-tracks-tracksts)`[]` | yes | May be `[]`. |
| `metadata` | `TimelineMetadata` | yes | See below. |

**`TimelineMetadataSchema`**

| Field | Type | Req. | Notes |
|---|---|---|---|
| `generator` | `TimelineGenerator` | yes | What produced the document. |
| `language` | `LanguageTag` | no | Primary language. |
| `createdAt` | `IsoDateTime` | no | |

**`TimelineGeneratorSchema`**

| Field | Type | Req. | Notes |
|---|---|---|---|
| `name` | string 1..120 | yes | `vc-ai-director` for director output. |
| `version` | string 1..64 | yes | Generator version, for example `0.1.0`. |
| `promptVersion` | string 1..64 | no | Director prompt version, for example `m1.0`. |

### 4.3 `RenderSettings` (`render-settings.ts`)

| Field | Type | Req. | Notes |
|---|---|---|---|
| `width` | even int 16..8192 | yes | `EvenDimensionSchema`. Odd values fail with "Dimension must be an even integer". |
| `height` | even int 16..8192 | yes | |
| `fps` | int 1..240 | yes | `FpsSchema`. `29.97` fails. |
| `backgroundColor` | `HexColor` | yes | |
| `sampleRate` | `44100` or `48000` | yes | |
| `videoCodec` | `h264`, `h265`, `vp9`, `prores` | yes | |
| `audioCodec` | `aac`, `opus` | yes | |

The timeline stores pixels only. `AspectRatioSchema` (`9:16`, `16:9`, `1:1`, `4:5`, `custom`) and `ResolutionSchema`
(`480p` to `2160p`, `custom`) belong to the request. The compiler resolves them with `resolveDimensions`
([section 6.4](#64-resolvedimensions)).

### 4.4 `Chapter` (`chapter.ts`)

| Field | Type | Req. | Notes |
|---|---|---|---|
| `id` | `Id` | yes | Global namespace. |
| `title` | string ≤ 200 | yes | |
| `summary` | string ≤ 2000 | no | |
| `startFrame` | `Frame` | yes | Absolute. |
| `durationInFrames` | `DurationFrames` | yes | |

### 4.5 `Scene` (`scene.ts`)

| Field | Type | Req. | Notes |
|---|---|---|---|
| `id` | `Id` | yes | Global namespace. The director uses `c{n}-s{m}`. |
| `chapterId` | `Id` | yes | Must name a chapter that contains the scene ([invariant 2](#invariant-2-chapters-cover-the-timeline-and-contain-their-scenes)). |
| `title` | string ≤ 200 | yes | |
| `startFrame` | `Frame` | yes | Absolute. |
| `durationInFrames` | `DurationFrames` | yes | |
| `content` | [`SceneContent`](#46-scenecontent-scene-contentts) | yes | Discriminated on `engine`. |
| `camera` | [`CameraTrack`](#410-cameratrack-camerats) | no | `3d` only on `three` scenes ([invariant 7](#invariant-7-camera-keyframes)). |
| `transitionIn` | [`Transition`](#411-transition-transitionsts) | no | The transition into this scene from the previous one. |
| `narration` | `Narration` | no | See below. |
| `notes` | string ≤ 2000 | no | Free text. |
| `storyboardSceneId` | string 1..128 | no | Links back to the director's storyboard scene. A free string, not an `Id`, and not part of the id namespace. |

**`NarrationSchema`.** v1 stores narration as text only. The voice-over audio is a separate audio track (TTS is
**planned, M4**).

| Field | Type | Req. | Notes |
|---|---|---|---|
| `text` | string ≤ 5000 | yes | May be empty. |
| `voiceId` | string 1..128 | no | Provider voice id. |
| `language` | `LanguageTag` | no | |

### 4.6 `SceneContent` (`scene-content.ts`)

`SceneContentSchema` is `z.discriminatedUnion('engine', [...])` over `EngineTypeSchema`: `motion2d`, `three`, `footage`,
`generated`, `image`, `screen`. An unknown engine fails with `invalid_union` at `content.engine`. In M1 the director emits only
`motion2d` and `three`, and coerces any other engine choice to `motion2d` with a warning. The other four variants are fully
specified and validated, so their renderers (**planned, M6**) do not need a schema change.

**`motion2d`** (`Motion2DContentSchema`)

| Field | Type | Req. | Notes |
|---|---|---|---|
| `engine` | `"motion2d"` | yes | |
| `template` | `TemplateId` | yes | A `motion2d` catalog template in director output ([section 11](#11-template-catalog)). |
| `props` | `JsonObject` | yes | Template props, validated against the catalog by the director, not by the timeline. |
| `layers` | [`Layer2D`](#47-layer2d-layersts)`[]` ≤ 500 | default `[]` | Extra 2D layers drawn with the template. |

**`three`** (`ThreeContentSchema`)

| Field | Type | Req. | Notes |
|---|---|---|---|
| `engine` | `"three"` | yes | |
| `template` | `TemplateId` | yes | A `three` catalog template in director output. |
| `props` | `JsonObject` | yes | |
| `modelAssetId` | `Id` | no | Must reference a `model3d` asset. |
| `environment` | `studio`, `sunset`, `city`, `night`, `forest`, `warehouse` | yes | |
| `lighting` | `soft`, `dramatic`, `high-key` | yes | |

**`footage`** (`FootageContentSchema`)

| Field | Type | Req. | Notes |
|---|---|---|---|
| `engine` | `"footage"` | yes | |
| `assetId` | `Id` | yes | Must reference a `video` asset. |
| `trimStartFrame` | `Frame` | yes | Offset into the source. |
| `playbackRate` | 0.25..4 | yes | `PlaybackRateSchema`. |
| `fit` | `cover`, `contain` | yes | |
| `volume` | 0..1 | yes | |
| `muted` | boolean | yes | |

**`generated`** (`GeneratedContentSchema`). Generative video providers are **planned (M6)**. The director never selects this
engine in M1.

| Field | Type | Req. | Notes |
|---|---|---|---|
| `engine` | `"generated"` | yes | |
| `provider` | `Id` | yes | For example `runway`. |
| `prompt` | string ≤ 4000 | yes | Also counted against `maxPromptChars` ([section 13](#13-resource-limits)). |
| `negativePrompt` | string ≤ 4000 | no | |
| `seed` | int | no | |
| `status` | `pending`, `queued`, `ready`, `failed` | yes | |
| `assetId` | `Id` | no | Must reference a `video` asset. **Required when `status` is `ready`** ([invariant 9](#invariant-9-ready-generated-scenes-have-an-asset)). |
| `jobId` | string 1..256 | no | Provider job id. |

**`image`** (`ImageContentSchema`)

| Field | Type | Req. | Notes |
|---|---|---|---|
| `engine` | `"image"` | yes | |
| `assetId` | `Id` | yes | Must reference an `image` asset. |
| `animation` | `none`, `ken-burns`, `zoom-in`, `zoom-out`, `pan-left`, `pan-right`, `parallax` | yes | |
| `fit` | `cover`, `contain` | yes | |
| `focalPoint` | `{ x, y }`, each normalized | yes | `FocalPointSchema`. |

**`screen`** (`ScreenContentSchema`)

| Field | Type | Req. | Notes |
|---|---|---|---|
| `engine` | `"screen"` | yes | |
| `assetId` | `Id` | yes | Must reference a `video` asset. |
| `trimStartFrame` | `Frame` | yes | |
| `playbackRate` | 0.25..4 | yes | |
| `zoomRegions` | `ZoomRegion[]` ≤ 200 | yes | May be `[]`. |
| `highlightCursor` | boolean | yes | |

**`ZoomRegionSchema`**: `startFrame` (`Frame`, relative to the scene), `durationInFrames` (`DurationFrames`), and `x`, `y`,
`width`, `height` (all normalized). Zoom regions are **not** checked against the scene duration in v1.

`OverlayContentSchema` is the subset allowed on overlay track items: `motion2d` or `image` only.

### 4.7 `Layer2D` (`layers.ts`)

`Layer2DSchema` is discriminated on `type` (`text`, `shape`, `image`). All three variants share these fields:

| Field | Type | Req. | Notes |
|---|---|---|---|
| `id` | `Id` | yes | Global namespace. |
| `type` | `text`, `shape`, `image` | yes | Discriminator. |
| `startFrame` | `Frame` | yes | Relative to the container start. |
| `durationInFrames` | `DurationFrames` | yes | `startFrame + durationInFrames` must not exceed the container ([invariant 8](#invariant-8-audio-fades-and-layers-fit-their-container)). |
| `enter` | `AnimationPreset` | yes | `none`, `fade`, `slide-up`, `slide-down`, `slide-left`, `slide-right`, `scale`, `pop`, `typewriter`, `blur-in`. |
| `exit` | `AnimationPreset` | yes | Same values. |
| `opacity` | 0..1 | yes | |

**`text`** (`TextLayerSchema`)

| Field | Type | Req. | Notes |
|---|---|---|---|
| `text` | string ≤ 2000 | yes | |
| `x`, `y` | normalized | yes | Center position. |
| `maxWidth` | normalized | yes | Fraction of the frame width. |
| `fontFamily` | `FontFamily` | no | Falls back to the brand fonts or the renderer default. |
| `fontSize` | 4..400 | yes | Pixels at a 1080 px short side. Renderers scale proportionally. |
| `fontWeight` | int 100..900 | yes | |
| `color` | `HexColor` | yes | |
| `align` | `left`, `center`, `right` | yes | |

**`shape`** (`ShapeLayerSchema`): `shape` (`rect`, `circle`, `line`), `x`, `y`, `width`, `height` (normalized), `color`
(`HexColor`), `cornerRadius` (number ≥ 0, no maximum).

**`image`** (`ImageLayerSchema`): `assetId` (`Id`, must reference an `image` asset), `x`, `y`, `width`, `height`
(normalized), `fit` (`cover`, `contain`).

### 4.8 `BrandKit` (`brand.ts`)

| Field | Type | Req. | Notes |
|---|---|---|---|
| `name` | string ≤ 120 | no | |
| `colors.primary` | `HexColor` | yes | All five colors are required. |
| `colors.secondary` | `HexColor` | yes | |
| `colors.accent` | `HexColor` | yes | |
| `colors.background` | `HexColor` | yes | |
| `colors.text` | `HexColor` | yes | |
| `fonts.heading` | `FontFamily` | yes | The director defaults to `Inter`. |
| `fonts.body` | `FontFamily` | yes | |
| `logoAssetId` | `Id` | no | Must reference an `image` asset. |

### 4.9 Camera keyframes (`camera.ts`)

**`Camera2DKeyframeSchema`**

| Field | Type | Req. | Notes |
|---|---|---|---|
| `frame` | `Frame` | yes | Relative to the scene. Must be `< scene.durationInFrames` and strictly increasing. |
| `x`, `y` | −10 000..10 000 | yes | Normalized offsets of the view center (`0.1` = 10 % of the frame). |
| `zoom` | (0, 20] | yes | `1` = no zoom. |
| `rotation` | −10 000..10 000 | yes | Degrees. |
| `easing` | `Easing` | yes | |

**`Camera3DKeyframeSchema`**

| Field | Type | Req. | Notes |
|---|---|---|---|
| `frame` | `Frame` | yes | Relative to the scene. |
| `position` | `[x, y, z]`, each −10 000..10 000 | yes | `Vec3Schema` (a tuple of exactly three numbers). |
| `target` | `[x, y, z]` | yes | Look-at point. |
| `fov` | 1..179 | yes | Degrees. |
| `easing` | `Easing` | yes | |

### 4.10 `CameraTrack` (`camera.ts`)

`CameraTrackSchema` is discriminated on `space`.

| Field | Type | Req. | Notes |
|---|---|---|---|
| `space` | `2d` or `3d` | yes | `3d` only on `three` scenes, `2d` on every other engine. |
| `preset` | `CameraPreset` | no | Records which preset produced the keyframes ([section 7](#7-camera-tracks-and-presets)). |
| `keyframes` | 1..500 `Camera2DKeyframe` (2d) or `Camera3DKeyframe` (3d) | yes | |

### 4.11 `Transition` (`transitions.ts`)

| Field | Type | Req. | Notes |
|---|---|---|---|
| `type` | `TransitionType` | yes | `cut`, `fade`, `crossfade`, `slide`, `wipe`, `zoom`, `blur`, `dip-to-black`, `dip-to-white`. |
| `durationInFrames` | int ≥ 0 | yes | `cut` ⇔ `0`. A refinement on the schema enforces both directions. |
| `direction` | `left`, `right`, `up`, `down` | no | Accepted on any type. Meaningful for `slide` and `wipe`. |
| `easing` | `Easing` | yes | |

### 4.12 Tracks (`tracks.ts`)

`TrackSchema` is discriminated on `kind` (`audio`, `caption`, `overlay`, `video`). Every track has `id` (`Id`) and `name`
(string 1..200). Item arrays have no schema maximum. Item `startFrame` values are **absolute**.

**`AudioTrackSchema`**: `kind: "audio"`, `role` (`voiceover`, `music`, `sfx`), `name`, `muted` (boolean), `volume` (0..2),
`items: AudioTrackItem[]`.

| `AudioTrackItem` field | Type | Req. | Notes |
|---|---|---|---|
| `id` | `Id` | yes | Global namespace. |
| `assetId` | `Id` | yes | Must reference an `audio` asset. |
| `startFrame` | `Frame` | yes | Absolute. |
| `durationInFrames` | `DurationFrames` | yes | |
| `trimStartFrame` | `Frame` | yes | Offset into the source. |
| `volume` | 0..2 | yes | `1` = unity gain. |
| `fadeInFrames` | `Frame` | yes | `fadeInFrames + fadeOutFrames ≤ durationInFrames`. |
| `fadeOutFrames` | `Frame` | yes | |

**`CaptionTrackSchema`**: `kind: "caption"`, `name`, `language` (`LanguageTag`, required), `style: CaptionStyle`,
`items: CaptionItem[]`.

| `CaptionStyle` field | Type | Req. |
|---|---|---|
| `preset` | `bold-center`, `lower`, `karaoke`, `minimal` | yes |
| `position` | `bottom`, `center`, `top` | yes |
| `fontFamily` | `FontFamily` | no |
| `fontSize` | 8..200 | no |
| `color` | `HexColor` | yes |
| `backgroundColor` | `HexColor` | no |

| `CaptionItem` field | Type | Req. |
|---|---|---|
| `id` | `Id` | yes |
| `startFrame` | `Frame` | yes |
| `durationInFrames` | `DurationFrames` | yes |
| `text` | string ≤ 500 | yes |
| `speaker` | string 1..120 | no |

**`OverlayTrackSchema`**: `kind: "overlay"`, `name`, `items: OverlayItem[]`.

| `OverlayItem` field | Type | Req. | Notes |
|---|---|---|---|
| `id` | `Id` | yes | |
| `startFrame` | `Frame` | yes | Absolute. |
| `durationInFrames` | `DurationFrames` | yes | Also the container length for layers inside `content`. |
| `content` | `OverlayContent` (`motion2d` or `image`) | yes | `footage`, `three` and the other engines are rejected. |
| `opacity` | 0..1 | yes | |
| `zIndex` | int | yes | Stacking order among overlays. Not required to be unique. |

**`VideoTrackSchema`**: `kind: "video"`, `name`, `items: VideoTrackItem[]`.

| `VideoTrackItem` field | Type | Req. | Notes |
|---|---|---|---|
| `id` | `Id` | yes | |
| `assetId` | `Id` | yes | Must reference a `video` asset. |
| `startFrame` | `Frame` | yes | Absolute. |
| `durationInFrames` | `DurationFrames` | yes | |
| `trimStartFrame` | `Frame` | yes | |
| `playbackRate` | 0.25..4 | yes | |
| `opacity` | 0..1 | yes | |
| `volume` | 0..2 | yes | |
| `muted` | boolean | yes | |

### 4.13 `AssetKind` and `AssetSource`

| Enum | Values |
|---|---|
| `AssetKindSchema` | `image`, `video`, `audio`, `font`, `model3d`, `document`, `subtitle` |
| `AssetSourceSchema` | `upload`, `generated`, `stock`, `external` |

### 4.14 `AssetRef` (`assets.ts`)

| Field | Type | Req. | Notes |
|---|---|---|---|
| `id` | `Id` | yes | Global namespace. |
| `kind` | `AssetKind` | yes | Must match every reference to it ([invariant 4](#invariant-4-asset-references-exist-and-have-a-compatible-kind)). |
| `uri` | `SafeUri` | yes | `asset://<assetId>` or `https://…` ([section 10](#10-asset-references-and-safeuri)). |
| `mimeType` | string ≤ 127, `/^[\w.+-]+\/[\w.+-]+$/` | yes | For example `image/png` or `model/gltf-binary`. |
| `name` | string 1..255 | no | Display name. |
| `sizeBytes` | int ≥ 0 | no | |
| `width`, `height` | int ≥ 1 | no | Pixels. |
| `durationInFrames` | `DurationFrames` | no | Informational. Not cross-checked against trims. |
| `source` | `AssetSource` | yes | |
| `provider` | string 1..120 | no | For example a stock or generation provider. |
| `license` | string 1..500 | no | For example `CC-BY-4.0`. |

## 5. Validation and the nine invariants

### 5.1 How validation runs

1. **Migrate.** `parseTimeline` and `safeParseTimeline` first run `migrateTimeline`
   ([section 14](#14-versioning-and-migrations)).
2. **Structural pass.** `TimelineBaseSchema` checks types, enums, bounds, regexes and per-object refinements, such as the
   transition `cut` rule and even dimensions.
3. **Invariant pass.** A single `superRefine` runs `checkTimelineInvariants` and reports every violation as a `custom` issue
   with an exact path. Every violation is collected; none stops the pass early.

Zod 4 skips the invariant pass if the structural pass produced an *aborting* issue. Verified on Zod 4.6.5:

| Structural issue | Example | Invariant pass |
|---|---|---|
| Wrong type, missing required key, non-integer for an int field (`invalid_type`) | `chapters.0.title: 5`, `chapters.0.startFrame: 0.5`, no `metadata` | **skipped** |
| Unknown enum or literal value (`invalid_value`) | `settings.videoCodec: "av1"` | **skipped** |
| Unknown discriminator (`invalid_union`) | `content.engine: "unreal"` | **skipped** |
| Bound (`too_small`, `too_big`), regex (`invalid_format`), refinement (`custom`) | `title` over 200 chars, `id: "bad id"`, odd `width`, `cut` with frames | **runs**, and its issues are reported together with the structural ones |

So fix the reported issues and validate again. After a bound or format issue, the invariant pass may add follow-on issues.
For example, a chapter id that fails the regex also makes the scene's `chapterId` an "Unknown chapter".

`parseTimeline(input)` returns a `Timeline` or throws `TimelineMigrationError` or `ZodError`.
`safeParseTimeline(input)` returns `{ success: true, data }` or `{ success: false, error: ZodError }`. It converts migration
errors into a ZodError ([section 14.2](#142-migration-errors)).

### Invariant 1: scenes are sorted, contiguous and cover `[0, durationInFrames]`

The rule: `scenes[0].startFrame === 0`, `scenes[i+1].startFrame === scenes[i].startFrame + scenes[i].durationInFrames`, and
the last scene ends exactly at `durationInFrames`. The expected start of each scene is computed from the actual previous
scene, so unsorted scenes show up as contiguity errors.

| Violation | Path | Message (example) |
|---|---|---|
| First scene does not start at 0 | `scenes.0.startFrame` | `Scene 0 must start at frame 0 (got 5)` |
| Gap, overlap or wrong order | `scenes.{i}.startFrame` | `Scenes must be sorted and contiguous: expected startFrame 90, got 91` |
| Last scene ends early or late | `scenes.{last}.durationInFrames` | `Last scene must end exactly at durationInFrames 90 (ends at 80)` |

### Invariant 2: chapters cover the timeline and contain their scenes

Chapters follow the same contiguity rule over `[0, durationInFrames]`, with the same messages using "Chapter" and paths under
`chapters.{i}`. In addition, for every scene:

| Rule | Path | Message (example) |
|---|---|---|
| `chapterId` names an existing chapter | `scenes.{i}.chapterId` | `Unknown chapter "ch-404"` |
| Scene order never returns to an earlier chapter | `scenes.{i}.chapterId` | `Scene order goes back to an earlier chapter ("ch-1")` |
| Scene starts inside its chapter | `scenes.{i}.startFrame` | `Scene starts before its chapter "ch-2" (150)` |
| Scene ends inside its chapter | `scenes.{i}.durationInFrames` | `Scene ends after its chapter "ch-1" (150)` |

Two properties follow from invariants 1 and 2 together: **every chapter contains at least one scene**, and **chapter
boundaries always fall on scene boundaries**. A scene that straddles two chapters is rejected. If chapter ids are duplicated,
the first chapter with that id is used for the lookup, and the duplicate is reported by invariant 3.

### Invariant 3: one global id namespace

Ids must be unique across all of these:

- chapters, scenes and assets;
- tracks and their items (audio items, caption cues, overlay items, video clips);
- 2D layers, both in scene content and in overlay content.

Ids are claimed in a fixed order: chapters, then scenes, then assets, then each track followed by its items, then scene
layers, then overlay layers. The **later** occurrence is reported, at its own `id` path:

| Example | Path | Message |
|---|---|---|
| An asset reuses scene id `s-1` | `assets.0.id` | `Duplicate id "s-1" (already used at scenes.0.id)` |
| A scene reuses chapter id `ch-1` | `scenes.0.id` | `Duplicate id "ch-1" (already used at chapters.0.id)` |
| A caption cue reuses track id `t-vo` | `tracks.1.items.1.id` | `Duplicate id "t-vo" (already used at tracks.0.id)` |
| An overlay layer reuses a scene layer id | `tracks.2.items.0.content.layers.0.id` | `Duplicate id "layer-text" (already used at scenes.0.content.layers.0.id)` |

Not in the namespace: the timeline's own `id`, `storyboardSceneId`, `generated.jobId`, `narration.voiceId`, and ids that appear
inside template `props` (for example `split-feature.imageAssetId`).

### Invariant 4: asset references exist and have a compatible kind

Every reference must name an entry in `assets` whose `kind` matches the table.

| Reference | Required `kind` | Path |
|---|---|---|
| `footage` content `assetId` | `video` | `scenes.{i}.content.assetId` |
| `screen` content `assetId` | `video` | `scenes.{i}.content.assetId` |
| `generated` content `assetId` (when present) | `video` | `scenes.{i}.content.assetId` |
| `image` content `assetId` | `image` | `scenes.{i}.content.assetId` |
| `three` content `modelAssetId` (when present) | `model3d` | `scenes.{i}.content.modelAssetId` |
| Image layer in a scene's `motion2d` content | `image` | `scenes.{i}.content.layers.{k}.assetId` |
| `brand.logoAssetId` | `image` | `brand.logoAssetId` |
| Audio track item | `audio` | `tracks.{t}.items.{j}.assetId` |
| Video track item | `video` | `tracks.{t}.items.{j}.assetId` |
| Overlay item with `image` content | `image` | `tracks.{t}.items.{j}.content.assetId` |
| Image layer in an overlay's `motion2d` content | `image` | `tracks.{t}.items.{j}.content.layers.{k}.assetId` |

Messages: `Unknown asset "missing-asset" (not listed in timeline.assets)` and
`Asset "img-1" must be of kind "video" (got "image")`. Asset ids inside template `props` are opaque to the timeline and are
not checked. No v1 field references the kinds `font`, `document` or `subtitle`, but such assets may still be listed.

### Invariant 5: track items are in bounds, sorted and non-overlapping

This applies to every track kind. Items are checked in array order. `previousEnd` is the largest end seen so far in the track.

| Rule | Path | Message (example) |
|---|---|---|
| `startFrame < durationInFrames` | `tracks.{t}.items.{j}.startFrame` | `Track item starts at 300, outside the timeline [0, 300]` |
| Otherwise `startFrame + durationInFrames ≤ durationInFrames` | `tracks.{t}.items.{j}.durationInFrames` | `Track item ends at 301, beyond the timeline duration 300` |
| Sorted by `startFrame` | `tracks.{t}.items.{j}.startFrame` | `Track items must be sorted by startFrame` |
| Otherwise no overlap with earlier items | `tracks.{t}.items.{j}.startFrame` | `Track item overlaps the previous item (which ends at 50)` |

Items may touch: an item may start on the frame where the previous one ends. Items in **different** tracks may overlap
freely. One item can be reported by both a bounds rule and an ordering rule.

### Invariant 6: transitions

| Rule | Path | Message (example) |
|---|---|---|
| The first scene has no `transitionIn`, or only a `cut` | `scenes.0.transitionIn` | `The first scene cannot have a transitionIn (other than "cut")` |
| `transitionIn.durationInFrames ≤ min(scene.durationInFrames, previousScene.durationInFrames)` | `scenes.{i}.transitionIn.durationInFrames` | `Transition duration 31 exceeds min(scene, previous scene) duration 30` |

The structural `TransitionSchema` refinement also applies, at `….transitionIn.durationInFrames`:
`A "cut" transition must have durationInFrames 0` and
`A "fade" transition must have durationInFrames > 0 (use "cut" for 0)`.

### Invariant 7: camera keyframes

| Rule | Path | Message (example) |
|---|---|---|
| `space` is `3d` on `three` scenes and `2d` on every other engine | `scenes.{i}.camera.space` | `Camera space "3d" is not allowed on a "motion2d" scene (expected "2d")` |
| `frame < scene.durationInFrames` | `scenes.{i}.camera.keyframes.{k}.frame` | `Camera keyframe frame 90 must be < scene duration 90` |
| Otherwise frames strictly increase | `scenes.{i}.camera.keyframes.{k}.frame` | `Camera keyframe frames must be strictly increasing (10 after 10)` |

The first keyframe does not have to be at frame 0. Every preset expansion does start at 0.

### Invariant 8: audio fades and layers fit their container

| Rule | Path | Message (example) |
|---|---|---|
| Audio item `fadeInFrames + fadeOutFrames ≤ durationInFrames` (equality allowed) | `tracks.{t}.items.{j}.fadeOutFrames` | `fadeInFrames + fadeOutFrames (151) exceeds durationInFrames 150` |
| Layer `startFrame + durationInFrames ≤` the container duration (the scene, or the overlay item for overlay layers) | `….layers.{k}.durationInFrames` | `Layer "layer-shape" ends at 61, beyond its container duration 60` |

### Invariant 9: `ready` generated scenes have an asset

| Rule | Path | Message |
|---|---|---|
| `generated.status === "ready"` ⇒ `assetId` is present | `scenes.{i}.content.assetId` | `A generated scene with status "ready" requires an assetId` |

`pending`, `queued` and `failed` generations may omit `assetId`.

### 5.2 What v1 does not check

The following are not validated in v1, so consumers must not assume them:

- Zoom regions against the scene duration.
- `trimStartFrame` against the asset's length.
- Template `props` against the catalog, including a template's `minDurationSeconds`.
- Caption text against narration.
- `narration.language` against `metadata.language`.
- Uniqueness of `zIndex`.
- Whether the `kind` of an asset matches its `mimeType`.

## 6. Frame math

The helpers in `frames.ts` and `render-settings.ts` are shared by the compiler, the API and the web preview.

### 6.1 `secondsToFrames(seconds, fps)` and `framesToSeconds(frames, fps)`

- `secondsToFrames` returns `Math.round(seconds × fps)`. It does not validate and can return `0` (`secondsToFrames(0.01, 30)
  === 0`). The compiler clamps the total with `Math.max(1, …)`. Examples: `(1, 30) → 30`, `(2.5, 24) → 60`, `(16, 25) → 400`,
  `(7200, 60) → 432000`.
- `framesToSeconds` returns `frames / fps` and throws `RangeError` if `fps ≤ 0`.

### 6.2 `allocateFrames(weights, totalFrames, minFrames = 1)`

`allocateFrames` turns relative durations (the storyboard's scene seconds) into integer frame counts. Rounding each scene on
its own would drift: three equal scenes in 100 frames round to 33 + 33 + 33 = 99. Largest-remainder apportionment fixes
that:

1. **Validate.** `totalFrames` and `minFrames` must be non-negative integers. `weights` must be non-empty, finite and > 0.
   `weights.length × minFrames ≤ totalFrames`. Any failure throws `RangeError`.
2. **Pin small entries.** Quotas are `freeTotal × wᵢ / freeWeight` over the unpinned entries. Any entry whose quota is below
   `minFrames` (tolerance 1e-9) is pinned to `minFrames`, and the rest is re-apportioned. This repeats until nothing new is
   pinned.
3. **Floor.** Each unpinned entry gets `max(minFrames, floor(quota))`.
4. **Distribute the leftover.** `totalFrames − Σ` frames go one each to the entries with the largest fractional remainder.
   **Ties go to the lower index first.**
5. The result has one entry per weight, every entry is ≥ `minFrames`, and the entries **sum exactly to `totalFrames`**. The
   same input always gives the same output.

**Worked example.** A 16 s request at 25 fps gives `totalFrames = secondsToFrames(16, 25) = 400`. The storyboard has three
scenes of 5 s, 7 s and 3 s (15 s in total; the director accepts some drift between script and target, and the frames follow
the request, not the storyboard total).

| i | weight | quota = 400 × w / 15 | floor | remainder | leftover | **frames** |
|---|---|---|---|---|---|---|
| 0 | 5 | 133.333 | 133 | 0.333 | | **133** |
| 1 | 7 | 186.667 | 186 | 0.667 | +1 | **187** |
| 2 | 3 | 80.000 | 80 | 0.000 | | **80** |
| | | | Σ 399 | | 1 frame left | **Σ 400** |

`allocateFrames([5, 7, 3], 400)` returns `[133, 187, 80]`.

**With a minimum.** `allocateFrames([0.2, 6, 3.8], 300, 30)`:

- Pass 1 gives quotas of 6, 180 and 114. Entry 0 is below 30, so it is pinned to 30.
- Pass 2 splits the remaining 270 frames over weight 9.8: 165.306 and 104.694. The floors are 165 and 104.
- The total is 30 + 165 + 104 = 299. The 1 leftover frame goes to entry 2 (remainder 0.694 > 0.306).
- Result: `[30, 165, 105]`.

**Ties.** `allocateFrames([1, 1, 1], 100)` returns `[34, 33, 33]`. `allocateFrames([1, 1, 1], 10)` returns `[4, 3, 3]`.

The compiler calls `allocateFrames(storyboardSeconds, totalFrames, max(1, min(fps, floor(totalFrames / sceneCount))))`. So
every scene gets at least one second when the total allows it. The function is exact for 2000 scenes over 2 h at 60 fps
(432 000 frames), and that case is covered by a test.

### 6.3 `formatTimecode(frame, fps)`

The format is `HH:MM:SS:FF`, non-drop-frame. `fps` is rounded to an integer base, so `29.97` counts as 30. A fractional
`frame` is floored, and hours do not wrap. Negative or `NaN` frames, and `fps ≤ 0`, throw `RangeError`.

| Call | Result |
|---|---|
| `formatTimecode(0, 30)` | `00:00:00:00` |
| `formatTimecode(1799, 30)` | `00:00:59:29` |
| `formatTimecode(1835, 30)` | `00:01:01:05` |
| `formatTimecode(108000, 30)` | `01:00:00:00` |
| `formatTimecode(45.7, 24)` | `00:00:01:21` |
| `formatTimecode(30, 29.97)` | `00:00:01:00` |
| `formatTimecode(21600000, 60)` | `100:00:00:00` |

### 6.4 `resolveDimensions`

`resolveDimensions({ aspectRatio, resolution, customWidth?, customHeight? })` returns `{ width, height }`.

- For preset sizes, the resolution names the **short side** in pixels: 480, 720, 1080, 1440 or 2160.
- The long side is `round(short × ratio)`, rounded to the nearest even integer. The result is always even.
- If either `aspectRatio` or `resolution` is `custom`, both `customWidth` and `customHeight` are required (positive and
  finite). Otherwise it throws `RangeError`. Custom values are rounded to the nearest even integer, with a minimum of 2:
  `641 × 361` becomes `642 × 362`.
- The 16..8192 range is enforced by `VideoRequestSchema` and `RenderSettingsSchema`, not by this function.

| Resolution | 9:16 | 16:9 | 1:1 | 4:5 |
|---|---|---|---|---|
| `480p` | 480 × 854 | 854 × 480 | 480 × 480 | 480 × 600 |
| `720p` | 720 × 1280 | 1280 × 720 | 720 × 720 | 720 × 900 |
| `1080p` | 1080 × 1920 | 1920 × 1080 | 1080 × 1080 | 1080 × 1350 |
| `1440p` | 1440 × 2560 | 2560 × 1440 | 1440 × 1440 | 1440 × 1800 |
| `2160p` | 2160 × 3840 | 3840 × 2160 | 2160 × 2160 | 2160 × 2700 |

`RESOLUTION_SHORT_SIDE` and `ASPECT_RATIO_VALUES` export the lookup tables.

## 7. Camera tracks and presets

A scene's `camera` is a list of keyframes in either 2D space (pan, zoom and rotation of the view) or 3D space (camera position,
look-at target and field of view). Frames are relative to the scene. [Invariant 7](#invariant-7-camera-keyframes) requires
them to be `< durationInFrames` and strictly increasing, and requires the space to match the engine.

- `preset` is optional. The schema does not tie it to the keyframes, so a track may carry `preset: "push-in"` with
  hand-edited keyframes. **Treat the keyframes as authoritative.**
- The schema does not define whether a keyframe's `easing` applies to the segment arriving at it or the segment leaving it.
  Every preset expansion uses the same easing on all of its keyframes, so for preset-generated tracks both readings give the
  same result.

### 7.1 `expandCameraPreset(preset, space, durationInFrames)`

`expandCameraPreset` returns a `CameraTrack` with `preset` set. The output is deterministic, and every preset is defined in
both spaces. The compiler calls it with the scene spec's `cameraPreset`. When that is `null`, the compiler maps the first
shot's `cameraMovement` to a preset (see [AI_DIRECTOR.md](AI_DIRECTOR.md)).

- `durationInFrames` must be an integer ≥ 1. Otherwise it throws `RangeError`.
- Keyframe frames are spread evenly: `round(i × (d − 1) / (k − 1))` for `k` keyframes. A 2-keyframe move sits on frames
  `0` and `d − 1`.
- `k` is clamped to `d`. A 1-frame scene therefore gets a single keyframe holding the **start** pose, with `easing: linear`.
  The move collapses.
- Moves use `ease-in-out`. `static` and the 3D orbit use `linear`.

**2D (space `2d`)**: the base pose is `x 0, y 0, zoom 1, rotation 0`.

| Preset | Keyframes | From | To |
|---|---|---|---|
| `static` | 1 | base | — |
| `push-in`, `dolly-in` | 2 | zoom 1 | zoom 1.15 |
| `pull-out`, `dolly-out` | 2 | zoom 1.15 | zoom 1 |
| `pan-left` / `pan-right` | 2 | x 0 | x −0.1 / +0.1 |
| `tilt-up`, `crane-up` | 2 | y 0 | y −0.1 |
| `tilt-down`, `crane-down` | 2 | y 0 | y +0.1 |
| `orbit-left` / `orbit-right` | 2 | base | x ∓0.1, zoom 1.05, rotation ∓2° |
| `ken-burns` | 2 | base | x 0.04, y −0.03, zoom 1.12 (zoom with drift) |
| `handheld` | 6 | zoom 1.03 throughout | small deterministic offsets: \|x\| ≤ 0.008, \|y\| ≤ 0.006, \|rotation\| ≤ 0.4°, first keyframe at the origin |

**3D (space `3d`)**: the base pose is `position [0, 1, 8]`, `target [0, 0, 0]`, `fov 50`.

| Preset | Keyframes | From | To |
|---|---|---|---|
| `static` | 1 | base | — |
| `orbit-left` / `orbit-right` | 5 | `[0, 1.5, 6]` | `[−6, 1.5, 0]` / `[6, 1.5, 0]`. A quarter orbit (90°) on a circle of **radius 6** around the origin at height 1.5, looking at the origin. Intermediate points at 22.5° steps, coordinates rounded to 4 decimals. |
| `dolly-in` / `dolly-out` | 2 | z 8 / z 5 | z 5 / z 8 (position `[0, 1, z]`) |
| `push-in` / `pull-out` | 2 | fov 50 / fov 40 | fov 40 / fov 50 (a lens zoom; the position is fixed) |
| `crane-up` / `crane-down` | 2 | y 0.5 / y 4 | y 4 / y 0.5 (position `[0, y, 8]`) |
| `pan-left` / `pan-right` | 2 | target `[0, 0, 0]` | target `[−2, 0, 0]` / `[2, 0, 0]` |
| `tilt-up` / `tilt-down` | 2 | target `[0, 0, 0]` | target `[0, 1.5, 0]` / `[0, −1.5, 0]` |
| `ken-burns` | 2 | base | position `[0.6, 1.2, 7]` |
| `handheld` | 6 | position `[0, 1, 8]` | small deterministic offsets: \|x\| ≤ 0.05, \|y − 1\| ≤ 0.04, z fixed at 8 |

For example, `expandCameraPreset('push-in', '2d', 90)` returns:

```json
{
  "space": "2d",
  "preset": "push-in",
  "keyframes": [
    { "frame": 0, "x": 0, "y": 0, "zoom": 1, "rotation": 0, "easing": "ease-in-out" },
    { "frame": 89, "x": 0, "y": 0, "zoom": 1.15, "rotation": 0, "easing": "ease-in-out" }
  ]
}
```

## 8. Transitions

`transitionIn` describes how a scene is entered from the previous scene. Transitions never change `startFrame` values: the
scene sequence stays contiguous. How a renderer realizes an N-frame blend, for example by overlapping the end of the previous
scene with the start of this one, is a renderer decision (**planned, M2**). The bound in
[invariant 6](#invariant-6-transitions) guarantees that N frames exist on both sides.

- `cut` has `durationInFrames: 0`, and every other type has `durationInFrames ≥ 1`. The schema enforces this in both
  directions.
- The first scene may only have a `cut`, or no transition.
- `direction` matters for `slide` and `wipe`. It is accepted, and ignored, on other types.
- The model only picks a `TransitionType` in the storyboard. It never sets a duration. The compiler sets
  `durationInFrames = min(round(0.5 × fps), floor(min(this scene, previous scene) / 2))`, which is 15 frames at 30 fps for
  scenes of at least 30 frames. If the result is below 1, or the storyboard asked for `cut`, the transition is a `cut`. The
  first scene gets no transition, and `slide` and `wipe` get `direction: "left"`.

## 9. Tracks

Tracks run in parallel with the scene sequence, using absolute frames. [Invariant 5](#invariant-5-track-items-are-in-bounds-sorted-and-non-overlapping)
applies to every kind: items stay inside `[0, durationInFrames]`, sorted by `startFrame`, with no overlap inside one track.
Use several tracks for simultaneous items. Track order in the array carries no meaning in v1.

| Kind | Purpose | Item references | Rules beyond invariant 5 | Produced in M1? |
|---|---|---|---|---|
| `audio` | Voice-over (`role: voiceover`), music bed (`music`), sound effects (`sfx`). Track-level `muted` and `volume` (0..2), and per-item `volume`, `trimStartFrame` and fades. | `audio` asset | Fades fit the item ([invariant 8](#invariant-8-audio-fades-and-layers-fit-their-container)) | No. Voice and music providers are **planned (M4)**. |
| `caption` | Timed caption cues with a `language`, a style preset (`bold-center`, `lower`, `karaoke`, `minimal`) and a position. Cues may carry a `speaker`. | none | — | **Yes.** The compiler emits one caption track (id `captions`) built from storyboard voice-over: cues of at most 7 words, frames proportional to word count, contiguous within each scene. Word-timed captions are **planned (M4)**. |
| `overlay` | Graphics drawn over scenes: `motion2d` template content (for example `lower-third`) or an image, with `opacity` and `zIndex`. | `image` asset (image content or image layers) | Layers fit the overlay item | No. The schema and its tests support overlays, but no M1 code produces or draws them. |
| `video` | B-roll or picture-in-picture clips with `trimStartFrame`, `playbackRate` 0.25..4, `opacity`, `volume` and `muted`. | `video` asset | — | No. Footage is **planned (M6)**. |

## 10. Asset references and `SafeUri`

### 10.1 Asset model

Every external file a timeline uses is listed once in `assets`, as an [`AssetRef`](#414-assetref-assetsts). Everything else
refers to it by id: scene content, layers, the brand logo and track items. This keeps URIs in one place, lets
[invariant 4](#invariant-4-asset-references-exist-and-have-a-compatible-kind) check kinds, and lets a storage migration rewrite
`uri` values without touching scenes. The internal reference form is `asset://<assetId>`, which the server resolves to storage.
Uploads and object storage are **planned (M3)**. v1 does not require `uri` to equal `asset://<id>`.

### 10.2 `SafeUri` rules

`SafeUriSchema` is an allow-list. A URI must pass every check, in this order:

1. A string of 1 to 2048 characters.
2. No control characters (U+0000–U+001F, U+007F–U+009F) and no whitespace of any kind, including spaces, tabs and newlines.
3. Parses as an **absolute** URL with `new URL(value)`.
4. The protocol is **`asset:`** or **`https:`**. Matching is case-insensitive through URL parsing, so `HTTPS://EXAMPLE.COM/x`
   passes and `JavaScript:alert(1)` fails.
5. No username or password.
6. A non-empty host. `asset://img-1` passes. `asset:img-1` fails with
   `URI must have a host (asset://<assetId> or https://host/...)`.

| Accepted | Rejected |
|---|---|
| `asset://img-1` | `http://example.com/a.mp4` (plain http) |
| `asset://abc123/variant.png` | `file:///etc/passwd`, `data:image/png;base64,…`, `javascript:alert(1)`, `ftp://…`, `blob:https://…` |
| `https://cdn.example.com/a.mp4` | `https://user:pass@example.com/a`, `asset://user:pass@img-1` (credentials) |
| `https://example.com/path?query=1#frag` | `/assets/a.png`, `example.com/a.png` (not absolute) |
| `https://example.com:8443/x` | `https://example.com/a b`, `https://exa\tmple.com/`, `…\u0000…`, `…\u0085…` |
| `HTTPS://EXAMPLE.COM/upper` | `asset:img-1` (no host), any URI over 2048 characters |

`SafeUri` checks the *shape* of a URI only. It does not resolve DNS or block private address ranges. Anything that fetches
`https:` URIs on the server (the M2+ renderers, the M3 ingest) must apply its own egress policy.

## 11. Template catalog

### 11.1 Catalog API (`templates/`)

`motion2d` and `three` scenes name a template from a **fixed, reviewed catalog** of 14 templates. The model fills in props
and never writes code ([ADR-009](DECISIONS.md#adr-009-fixed-template-catalog-with-per-template-zod-props-never-llm-generated-code)).
Each `TemplateDefinition` has these fields:

- `id`
- `engine`: `motion2d` or `three`
- `name`
- `description`: shown to the model
- `genres`
- `propsSchema`: an LLM-safe Zod object
- `minDurationSeconds`: advisory; not enforced by any schema
- `buildProps(ctx)`: deterministically builds valid props from a `TemplatePropsContext` `{ title, text, bullets, palette,
  brandName }`. The heuristic mock provider and engine-fallback coercion use it.

| Export | Purpose |
|---|---|
| `TEMPLATE_CATALOG`, `TEMPLATE_IDS` | All definitions and ids, in catalog order. |
| `getTemplate(id)`, `isCatalogTemplateId(id)` | Look up by id. |
| `listTemplates({ engine?, genre? })` | Filter. Every genre has at least one `motion2d` template, and that is tested. |
| `validateTemplateProps(id, props)` | `{ success: true, data }` or `{ success: false, issues: string[] }`. Unknown ids fail with `Unknown template "x"`. Issues look like `headline: Too small: …`. Valid props are also re-checked as `JsonObject`. |
| `templateCatalogSummary()` | A serializable list of `{ id, engine, name, description, genres, minDurationSeconds }` with no Zod objects. Validated by `TemplateSummarySchema` and served by `GET /v1/system/config`. |

### 11.2 The 14 templates

Every prop listed is **required**. "or null" marks the nullable props, which use `.nullable()` instead of `.optional()`
([section 12](#12-llm-safe-schema-rules)). `Hex` means `HexColor`. String bounds are character counts.

| Id | Engine | Min s | Genres | Props |
|---|---|---|---|---|
| `title-card` | motion2d | 1.5 | all 14 genres | `headline` 1..120 · `subheadline` 1..200 or null · `align` `left`, `center` · `background` `{ style: solid, gradient; colors: Hex[1..3] }` · `accentColor` Hex |
| `kinetic-text` | motion2d | 2 | cinematic-ad, promo, motion-graphics, social-short, explainer, long-form, reference-based | `lines` string 1..80 [1..6] · `emphasis` 1..80 or null · `style` `bold`, `minimal`, `playful` · `color` Hex · `backgroundColor` Hex |
| `bullet-list` | motion2d | 4 | sop-training, corporate-training, explainer, presentation, long-form, promo | `title` 1..120 · `bullets` string 1..160 [1..6] · `marker` `check`, `dot`, `number` · `accentColor` · `backgroundColor` |
| `quote` | motion2d | 3 | corporate-training, presentation, long-form, promo, explainer, cinematic-ad | `quote` 1..400 · `attribution` 1..120 or null · `accentColor` · `backgroundColor` |
| `stat-counter` | motion2d | 2.5 | promo, corporate-training, explainer, presentation, motion-graphics, social-short, long-form | `value` number −1e15..1e15 · `decimals` int 0..3 · `prefix` 1..8 or null · `suffix` 1..16 or null · `label` 1..120 · `accentColor` · `backgroundColor` |
| `step-instruction` | motion2d | 4 | sop-training, corporate-training, explainer | `stepNumber` int 1..999 · `totalSteps` int 1..999 (refined: `stepNumber ≤ totalSteps`) · `title` 1..120 · `instruction` 1..500 · `caution` 1..200 or null · `accentColor` · `backgroundColor` |
| `split-feature` | motion2d | 4 | promo, product-3d, explainer, presentation, real-estate, corporate-training, long-form | `headline` 1..120 · `body` 1..500 · `mediaSide` `left`, `right` · `imageAssetId` Id or null · `imagePrompt` 1..500 or null · `accentColor` · `backgroundColor` |
| `cta-end-card` | motion2d | 2.5 | cinematic-ad, promo, social-short, product-3d, real-estate, explainer, motion-graphics, reference-based, corporate-training, presentation | `headline` 1..120 · `callToAction` 1..120 · `contactLine` 1..160 or null · `accentColor` · `backgroundColor` |
| `cartoon-scene` | motion2d | 3 | comedy, cartoon, social-short, explainer | `character` `blob`, `robot`, `cat`, `bird` · `expression` `happy`, `surprised`, `confused`, `angry`, `laughing` · `dialogue` 1..200 or null · `setting` `room`, `office`, `park`, `space`, `stage` · `gag` `none`, `bounce`, `shake`, `spin`, `squash` · `backgroundColor` |
| `property-showcase` | motion2d | 4 | real-estate | `propertyName` 1..120 · `location` 1..160 · `price` 1..40 or null · `features` string 1..120 [1..6] · `accentColor` · `backgroundColor` |
| `lower-third` | motion2d | 2 | corporate-training, presentation, long-form, sop-training, explainer, real-estate, promo | `name` 1..80 · `role` 1..120 or null · `accentColor`. Works as a scene or as overlay content. |
| `product-turntable` | three | 3 | product-3d, promo, cinematic-ad, social-short | `primitive` `box`, `cylinder`, `sphere`, `bottle`, `phone`, `can` · `color` · `metalness` 0..1 · `roughness` 0..1 · `headline` 1..120 or null · `rotationTurns` 0.25..4 |
| `logo-reveal-3d` | three | 2.5 | product-3d, cinematic-ad, promo, motion-graphics, corporate-training | `text` 1..40 · `depth` 0.05..2 · `color` · `accentColor` |
| `floating-shapes` | three | 2 | motion-graphics, product-3d, promo, social-short, cinematic-ad, presentation | `shapes` `spheres`, `cubes`, `torus`, `mixed` · `count` int 3..40 · `palette` Hex[2..5] · `headline` 1..120 or null |

### 11.3 Why the timeline does not check catalog membership

`TemplateIdSchema` is `IdSchema`: any well-formed id passes, and `props` is a generic `JsonObject`. Catalog membership and
props validity are checked **by the director**, when the plan is generated:

- The engine-selection validator requires a catalog template whose engine matches the choice. It reports
  `choices.{i}.template: unknown template "x"` or
  `template "x" is a "three" template, not "motion2d"`.
- The scene-spec validator runs `validateTemplateProps` and reports issues as `scenes.{i}.props.<issue>`.
- The model's scene-spec output schema is itself a discriminated union over the catalog, so each template's `props` schema is
  attached to its id.

The timeline schema deliberately does not repeat these checks:

1. **Old timelines must stay readable.** Stored versions go through `parseTimeline` on every read. If the timeline checked the
   catalog, removing, renaming or tightening a template would make existing projects fail to load.
2. **New templates must not need a schema version.** A template added in a later deploy is just a new id. No migration and no
   `schemaVersion` bump are needed, and the timeline stays independent of the catalog module.
3. **One owner per rule.** The catalog is the director's vocabulary. Renderers (**planned, M2/M5**) and the preview look up
   the template themselves, call `validateTemplateProps(template, props)`, and handle an unknown or invalid template for that
   one scene, instead of rejecting the whole document.

## 12. LLM-safe schema rules

Every schema the model must fill is **structured-output safe**, so it converts to a JSON Schema that Claude structured
outputs accept ([ADR-005](DECISIONS.md#adr-005-zod-v4-as-the-single-source-of-truth-json-schema-derived-for-llm-outputs),
[ADR-006](DECISIONS.md#adr-006-claude-structured-outputs-instead-of-forced-tool-use)).

| Rule | Why |
|---|---|
| Closed objects only (no `catchall` or `looseObject`) | Every object becomes `additionalProperties: false`. |
| **Every property required.** Use `.nullable()`, never `.optional()`, `.default()` or `.prefault()`. | Structured outputs require every key, so "absent" is expressed as `null`. |
| No records, maps or sets | Open-ended keys cannot be closed. |
| No tuples | Not supported by the wire schema subset. |
| No recursion (`z.lazy`) | Structured outputs reject recursive schemas. |
| No transforms or pipes, no `any`, `unknown` or `custom` | The output must be plain data that Zod can re-validate. |
| Allowed: objects, arrays, nullable, readonly, unions, intersections, and leaves of `string`, `number`, `int`, `boolean`, `null`, `enum`, `literal` | |
| Length, size and numeric constraints *are* allowed | The director strips them from the wire schema, and Zod re-validates them client-side. |

`llmSchemaIssues(schema)` in `director.ts` walks a Zod schema and returns the reasons it is unsafe. An empty array means the
schema is safe. Paths use `(root)`, `.key`, `[]` for array elements, `|i` for union options and `&0`/`&1` for intersection
sides. For example:

```text
(root).title: property must be required (use .nullable() instead of .optional())
(root).tags: property must be required (use .nullable() instead of .default())
(root).props: type "record" is not allowed in LLM-facing schemas
(root).pos: type "tuple" is not allowed in LLM-facing schemas
(root).extra: object must be closed (no catchall)
(root).shape|0.v: type "unknown" is not allowed in LLM-facing schemas
(root).n: type "pipe" is not allowed in LLM-facing schemas
```

Tests assert `llmSchemaIssues(...) === []`, and a closed, all-required JSON Schema, for these schemas:

- every catalog `propsSchema`;
- `CreativeBriefSchema`, `ScriptOutlineSchema`, `ChapterScriptSchema`;
- `StoryboardSceneSchema`, `ChapterStoryboardSchema`, `StoryboardSchema`;
- `ShotSchema`, `ChapterShotListSchema`, `ShotListSchema`;
- `EngineChoiceSchema`, `ChapterEngineSelectionSchema`, `EngineSelectionSchema`;
- the scene-spec union over the whole catalog.

Refinements such as `stepNumber ≤ totalSteps` are invisible to the wire schema and are enforced when Zod re-validates.

**The timeline is not LLM-safe, by design, and is never sent to the model.** `llmSchemaIssues(SceneSchema)` reports, for
example, `(root).content|0.props: type "record" is not allowed`,
`(root).content|0.layers: property must be required (use .nullable() instead of .default())` and
`(root).content|1.modelAssetId: property must be required (use .nullable() instead of .optional())`.

The model plans in seconds and enums, and code produces every frame number:

| Model output | Time and motion fields | Compiled into |
|---|---|---|
| `ScriptOutline.chapters[]` | `targetDurationSeconds` | Chapter targets |
| `ChapterScript.segments[]` | `targetDurationSeconds` | Pacing only |
| `StoryboardScene` | `durationSeconds`, `transitionIn: TransitionType` | `allocateFrames` gives the scene frames; the transition duration comes from fps ([section 8](#8-transitions)) |
| `Shot` | `durationSeconds`, `cameraMovement` | The camera preset when `cameraPreset` is null |
| Scene spec (per template) | `cameraPreset: CameraPreset` or null | `expandCameraPreset` gives the keyframes |

## 13. Resource limits

Limits are **configuration, not schema**. `ResourceLimitsSchema` holds nine positive integers.
`DEFAULT_RESOURCE_LIMITS` is only a default: `apps/studio-api/src/config.ts` reads each value from the environment
([ADR-016](DECISIONS.md#adr-016-configurable-resource-limits-instead-of-hardcoded-duration-caps)). `VideoRequestSchema`
deliberately has **no maximum duration**.

| Field | Default | Env var (studio-api) | `checkTimelineLimits` checks | `checkVideoRequestLimits` checks |
|---|---|---|---|---|
| `maxDurationSeconds` | 7200 | `LIMIT_MAX_DURATION_SECONDS` | `durationInFrames / fps` | `durationSeconds` |
| `maxWidth` | 3840 | `LIMIT_MAX_WIDTH` | `settings.width` | resolved width |
| `maxHeight` | 3840 | `LIMIT_MAX_HEIGHT` | `settings.height` | resolved height |
| `maxFps` | 60 | `LIMIT_MAX_FPS` | `settings.fps` | `fps` |
| `maxScenes` | 2000 | `LIMIT_MAX_SCENES` | `scenes.length` | — |
| `maxChapters` | 200 | `LIMIT_MAX_CHAPTERS` | `chapters.length` | — |
| `maxTracks` | 50 | `LIMIT_MAX_TRACKS` | `tracks.length` | — |
| `maxAssets` | 500 | `LIMIT_MAX_ASSETS` | `assets.length` | `referenceAssetIds.length` |
| `maxPromptChars` | 20000 | `LIMIT_MAX_PROMPT_CHARS` | each `generated` scene's `prompt.length` | `prompt.length` |

- Both functions return `LimitViolation[]`, and an empty array means the input is within limits. A violation is
  `{ code, message, limit, actual }` (`LimitViolationSchema`), for example
  `{ code: "MAX_DURATION_SECONDS", message: "Duration (seconds) 10 exceeds the configured limit of 5", limit: 5, actual: 10 }`.
- Limits are **inclusive**: a value equal to the limit passes.
- The codes are `MAX_DURATION_SECONDS`, `MAX_WIDTH`, `MAX_HEIGHT`, `MAX_FPS`, `MAX_SCENES`, `MAX_CHAPTERS`, `MAX_TRACKS`,
  `MAX_ASSETS`, `MAX_PROMPT_CHARS` and `INVALID_DIMENSIONS`. `INVALID_DIMENSIONS` is returned by `checkVideoRequestLimits`
  when `resolveDimensions` throws, for example when custom dimensions are missing. Its `limit` and `actual` are `0`.
- The API rejects over-limit requests with `422 LIMIT_EXCEEDED`. The director checks limits before any provider call, and
  checks the compiled timeline again ([AI_DIRECTOR.md](AI_DIRECTOR.md)).
- The schema still keeps fixed *sanity* bounds that limits cannot raise: dimensions 16..8192, fps 1..240, 500 camera keyframes,
  500 layers per content, 200 zoom regions, the JSON limits, and the text lengths.

## 14. Versioning and migrations

### 14.1 Mechanics (`migrations.ts`)

| Export | Meaning |
|---|---|
| `CURRENT_TIMELINE_VERSION = 1` | The version this code writes and validates. `TimelineBaseSchema.schemaVersion` is `z.literal(CURRENT_TIMELINE_VERSION)`. |
| `TIMELINE_MIGRATIONS` | `Readonly<Record<number, (doc) => doc>>`, keyed by **source** version (N to N + 1). Frozen and **empty in v1**. |
| `migrateTimeline(input, migrations = TIMELINE_MIGRATIONS, targetVersion = CURRENT_TIMELINE_VERSION)` | Validates that the input is an object, reads `schemaVersion`, and applies `migrations[v]` for `v = version … targetVersion − 1` in order. Each step's output must be a plain object with `schemaVersion === v + 1`. Returns the migrated document, which is **not validated yet**. A current-version input is returned as-is (the same object). |
| `TimelineMigrationError` | `{ code, message, version }`. |
| `parseTimeline` / `safeParseTimeline` | Migrate, then `TimelineSchema`. |

Tests check the injection points: a fake v0-to-v1 migration (`name` renamed to `title`) turns a v0 document into a valid v1
timeline, and a two-step chain runs in order up to an explicit `targetVersion` of 2.

### 14.2 Migration errors

| Code | When | `safeParseTimeline` issue path |
|---|---|---|
| `INVALID_DOCUMENT` | The input is not a plain object (`null`, an array, a string) | `[]`, the root: `Timeline must be a JSON object` |
| `MISSING_VERSION` | `schemaVersion` is absent or `undefined` | `schemaVersion`: `Timeline is missing "schemaVersion"` |
| `INVALID_VERSION` | Not a non-negative integer (`"1"`, `0.5`, `-1`) | `schemaVersion`: `Invalid timeline schemaVersion: "1"` |
| `UNSUPPORTED_VERSION` | Newer than the target | `schemaVersion`: `Timeline schemaVersion 2 is newer than the supported version 1` |
| `MISSING_MIGRATION` | No step registered for some `v` | `schemaVersion`: `No timeline migration from version 0 to 1` |
| `MIGRATION_FAILED` | A step returned a non-object or the wrong `schemaVersion` | `schemaVersion` |

`safeParseTimeline` rethrows any exception that is not a `TimelineMigrationError`, for example a bug inside a migration
function.

### 14.3 Storage

- Each `ProjectVersion` row stores `timeline` (JSON) and `schemaVersion` (the version at write time). See
  [DATABASE.md](DATABASE.md).
- Rows are **migrated on read** and never rewritten. `toVersionDto` runs `parseTimeline(row.timeline)` and reports the
  migrated `timeline.schemaVersion`. The version list (`toVersionSummaryDto`) reports the stored `row.schemaVersion`. After a
  bump the two can differ for old rows, and that is expected.
- A reader on old code that meets a newer document fails with `UNSUPPORTED_VERSION`. It never mis-parses the document.

### 14.4 How to add v2, step by step

A new version is needed whenever the stored shape changes: a field is renamed, removed or added, or its meaning changes.
Readers strip unknown keys ([section 3](#conventions)), so even a purely additive field needs a bump. Without one, an older
reader would silently drop the field when it re-saves the document.

1. **Change the schemas** in the relevant module (`scene.ts`, `tracks.ts`, …) and the invariants in `timeline.ts` if needed.
2. **Bump the version.** Set `export const CURRENT_TIMELINE_VERSION = 2;` in `migrations.ts`. `TimelineBaseSchema`, and through
   it `ProjectVersionDTOSchema.timeline`, now require `schemaVersion: 2`.
3. **Register the 1 → 2 migration** in `migrations.ts`, keyed by the source version. The example below is hypothetical:

   ```ts
   // Hypothetical v2: RenderSettings gains a required colorSpace.
   const migrateV1ToV2: TimelineMigration = (doc) => {
     const settings = isPlainObject(doc.settings) ? doc.settings : {};
     return { ...doc, schemaVersion: 2, settings: { ...settings, colorSpace: 'srgb' } };
   };

   export const TIMELINE_MIGRATIONS: TimelineMigrations = Object.freeze({ 1: migrateV1ToV2 });
   ```

   A migration must follow these rules:
   - It is **pure and deterministic**, and **never mutates** its input. Return new objects, because `migrateTimeline` passes
     through the caller's object.
   - It is **total over every valid v1 document**, and it sets `schemaVersion` to exactly `v + 1`.
   - It works on the untyped `TimelineDocument` and **does not validate**: `parseTimeline` validates the final result.
   - It **does not import from `timeline.ts`**. `timeline.ts` imports `migrations.ts`, and the current types describe v2, not
     v1.
   - Steps compose: a v0 document would run `0 → 1 → 2`. Never edit a shipped step. Add a new one.
4. **Freeze a v1 fixture.** Commit a JSON snapshot of a rich v1 timeline (for example `test/fixtures/timeline-v1.json`, taken
   from `buildValidTimeline()` before the change) and test that `parseTimeline(v1Fixture)` succeeds and produces the expected
   v2 shape. Also test the migration on `buildMinimalTimeline()`-sized documents and on documents that omit every optional
   field.
5. **Update the existing version tests.** These tests in `packages/schema/test/` hard-code v1:
   - "exposes CURRENT_TIMELINE_VERSION = 1 and rejects other versions structurally", which uses `schemaVersion: 2` as the
     invalid version (`timeline.test.ts`);
   - "TIMELINE_MIGRATIONS is empty in v1" and "errors on versions newer than current", which uses version 2
     (`migrations-limits.test.ts`).
6. **Update the producers.** Fixtures use `CURRENT_TIMELINE_VERSION`. At the time of writing,
   `packages/ai-director/src/compiler.ts` writes `schemaVersion: 1 as const`: switch it to the constant. Re-run the director
   tests. `ReferenceProfile` has its own, independent `schemaVersion` ([section 16](#16-referenceprofile-schema)); do not bump
   it.
7. **Deploy together.** `@vc/schema` is compiled into studio-api, the director worker and studio-web, and the web app validates
   API responses with `ProjectVersionDTOSchema`. Deploy all three from the same commit. A web build that only knows v1 would
   reject v2 timelines.
8. **Document it.** Update this file: the header version, the field tables, the examples and [section 17](#17-differences-from-the-m1-spec).
   If the decision behind the change differs from ADR-011, add an ADR that supersedes it. Stored rows keep migrating on read.
   A write-back backfill job does not exist and is optional.
9. **Verify.** Run `pnpm --filter @vc/schema typecheck && pnpm --filter @vc/schema test`, then the tests of
   `@vc/ai-director`, `@vc/studio-api` and `@vc/studio-web`.

## 15. Examples

Both examples below were written to temporary files and checked with a `tsx` script run through
`pnpm --filter @vc/schema exec tsx …`. The script ran these checks:

- `parseTimeline` succeeded.
- The parsed result deep-equals the input, so nothing was stripped or defaulted.
- Every `motion2d` and `three` template's props pass `validateTemplateProps`.
- Every preset-labelled camera equals `expandCameraPreset(preset, space, durationInFrames)`.
- `checkTimelineLimits(…, DEFAULT_RESOURCE_LIMITS)` returned no violations.

### 15.1 Minimal valid timeline

One chapter, one `motion2d` scene, no assets and no tracks. This is 3 s of 1920 × 1080 at 30 fps.

```json
{
  "schemaVersion": 1,
  "id": "tl-minimal",
  "title": "Hello, timeline",
  "settings": {
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "backgroundColor": "#0F172A",
    "sampleRate": 48000,
    "videoCodec": "h264",
    "audioCodec": "aac"
  },
  "durationInFrames": 90,
  "assets": [],
  "chapters": [
    { "id": "ch-1", "title": "Opening", "startFrame": 0, "durationInFrames": 90 }
  ],
  "scenes": [
    {
      "id": "c1-s1",
      "chapterId": "ch-1",
      "title": "Title",
      "startFrame": 0,
      "durationInFrames": 90,
      "content": {
        "engine": "motion2d",
        "template": "title-card",
        "props": {
          "headline": "Hello, timeline",
          "subheadline": null,
          "align": "center",
          "background": { "style": "solid", "colors": ["#0F172A"] },
          "accentColor": "#F59E0B"
        },
        "layers": []
      }
    }
  ],
  "tracks": [],
  "metadata": { "generator": { "name": "hand-written", "version": "1" } }
}
```

`layers` could be omitted, and Zod would fill in `[]`. It is written out here so that the parsed output equals the input.

### 15.2 Two-chapter timeline

This example is 12 s of 9:16 at 1080p (1080 × 1920), 30 fps, so 360 frames. It has a brand kit, two assets, both camera
spaces, three kinds of transition, layers, and an audio, a caption and an overlay track.

| Frames | Chapter | Scene | Content | Camera | `transitionIn` |
|---|---|---|---|---|---|
| [0, 90) | `ch-1` Hook [0, 150) | `c1-s1` | `motion2d` / `title-card` | 2D `push-in` | — |
| [90, 150) | `ch-1` | `c1-s2` | `three` / `product-turntable` | 3D `dolly-in` | `crossfade` 15 |
| [150, 270) | `ch-2` Payoff [150, 360) | `c2-s1` | `motion2d` / `bullet-list` plus a text layer | none | `slide` left 15 |
| [270, 360) | `ch-2` | `c2-s2` | `motion2d` / `cta-end-card` plus a logo image layer | 2D `static` | `fade` 15 |

The tracks are:

- `t-music`: one music item over [0, 360) with a 15-frame fade-in and a 30-frame fade-out.
- `t-captions`: five contiguous-per-scene cues.
- `t-overlay`: a `lower-third` over [160, 250).

```json
{
  "schemaVersion": 1,
  "id": "tl-acme-flow",
  "title": "Acme Flow launch teaser",
  "settings": {
    "width": 1080,
    "height": 1920,
    "fps": 30,
    "backgroundColor": "#0F172A",
    "sampleRate": 48000,
    "videoCodec": "h264",
    "audioCodec": "aac"
  },
  "durationInFrames": 360,
  "brand": {
    "name": "Acme",
    "colors": {
      "primary": "#1E3A8A",
      "secondary": "#334155",
      "accent": "#F59E0B",
      "background": "#0F172A",
      "text": "#FFFFFF"
    },
    "fonts": { "heading": "Inter", "body": "Inter" },
    "logoAssetId": "logo-1"
  },
  "assets": [
    {
      "id": "logo-1",
      "kind": "image",
      "uri": "asset://logo-1",
      "mimeType": "image/png",
      "name": "Acme logo",
      "width": 512,
      "height": 512,
      "source": "upload"
    },
    {
      "id": "music-1",
      "kind": "audio",
      "uri": "https://cdn.example.com/music/upbeat-bed.mp3",
      "mimeType": "audio/mpeg",
      "durationInFrames": 900,
      "source": "stock",
      "provider": "example-stock",
      "license": "CC-BY-4.0"
    }
  ],
  "chapters": [
    { "id": "ch-1", "title": "Hook", "summary": "Introduce the product", "startFrame": 0, "durationInFrames": 150 },
    { "id": "ch-2", "title": "Payoff", "summary": "Benefits and call to action", "startFrame": 150, "durationInFrames": 210 }
  ],
  "scenes": [
    {
      "id": "c1-s1",
      "chapterId": "ch-1",
      "title": "Opening title",
      "startFrame": 0,
      "durationInFrames": 90,
      "content": {
        "engine": "motion2d",
        "template": "title-card",
        "props": {
          "headline": "Acme Flow",
          "subheadline": "Plan, ship and measure in one place",
          "align": "center",
          "background": { "style": "gradient", "colors": ["#0F172A", "#1E3A8A"] },
          "accentColor": "#F59E0B"
        },
        "layers": []
      },
      "camera": {
        "space": "2d",
        "preset": "push-in",
        "keyframes": [
          { "frame": 0, "x": 0, "y": 0, "zoom": 1, "rotation": 0, "easing": "ease-in-out" },
          { "frame": 89, "x": 0, "y": 0, "zoom": 1.15, "rotation": 0, "easing": "ease-in-out" }
        ]
      },
      "narration": { "text": "Meet Acme Flow. Plan, ship and measure.", "language": "en" },
      "storyboardSceneId": "c1-s1"
    },
    {
      "id": "c1-s2",
      "chapterId": "ch-1",
      "title": "Product hero",
      "startFrame": 90,
      "durationInFrames": 60,
      "content": {
        "engine": "three",
        "template": "product-turntable",
        "props": {
          "primitive": "phone",
          "color": "#1E3A8A",
          "metalness": 0.4,
          "roughness": 0.3,
          "headline": "Built for teams",
          "rotationTurns": 1
        },
        "environment": "studio",
        "lighting": "soft"
      },
      "camera": {
        "space": "3d",
        "preset": "dolly-in",
        "keyframes": [
          { "frame": 0, "position": [0, 1, 8], "target": [0, 0, 0], "fov": 50, "easing": "ease-in-out" },
          { "frame": 59, "position": [0, 1, 5], "target": [0, 0, 0], "fov": 50, "easing": "ease-in-out" }
        ]
      },
      "transitionIn": { "type": "crossfade", "durationInFrames": 15, "easing": "ease-in-out" },
      "storyboardSceneId": "c1-s2"
    },
    {
      "id": "c2-s1",
      "chapterId": "ch-2",
      "title": "Why teams switch",
      "startFrame": 150,
      "durationInFrames": 120,
      "content": {
        "engine": "motion2d",
        "template": "bullet-list",
        "props": {
          "title": "Why teams switch",
          "bullets": ["Plan together", "Ship faster", "Measure results"],
          "marker": "check",
          "accentColor": "#F59E0B",
          "backgroundColor": "#0F172A"
        },
        "layers": [
          {
            "id": "c2-s1-badge",
            "type": "text",
            "startFrame": 10,
            "durationInFrames": 100,
            "enter": "pop",
            "exit": "fade",
            "opacity": 1,
            "text": "New",
            "x": 0.85,
            "y": 0.1,
            "maxWidth": 0.2,
            "fontFamily": "Inter",
            "fontSize": 48,
            "fontWeight": 800,
            "color": "#F59E0B",
            "align": "center"
          }
        ]
      },
      "transitionIn": { "type": "slide", "durationInFrames": 15, "direction": "left", "easing": "ease-out" },
      "narration": { "text": "Teams plan together, ship faster and measure results.", "language": "en" },
      "storyboardSceneId": "c2-s1"
    },
    {
      "id": "c2-s2",
      "chapterId": "ch-2",
      "title": "Call to action",
      "startFrame": 270,
      "durationInFrames": 90,
      "content": {
        "engine": "motion2d",
        "template": "cta-end-card",
        "props": {
          "headline": "Acme Flow",
          "callToAction": "Start free today",
          "contactLine": "acme.example",
          "accentColor": "#F59E0B",
          "backgroundColor": "#0F172A"
        },
        "layers": [
          {
            "id": "c2-s2-logo",
            "type": "image",
            "startFrame": 0,
            "durationInFrames": 90,
            "enter": "fade",
            "exit": "none",
            "opacity": 1,
            "assetId": "logo-1",
            "x": 0.5,
            "y": 0.2,
            "width": 0.25,
            "height": 0.14,
            "fit": "contain"
          }
        ]
      },
      "camera": {
        "space": "2d",
        "preset": "static",
        "keyframes": [{ "frame": 0, "x": 0, "y": 0, "zoom": 1, "rotation": 0, "easing": "linear" }]
      },
      "transitionIn": { "type": "fade", "durationInFrames": 15, "easing": "ease-in-out" },
      "narration": { "text": "Start free today.", "language": "en" },
      "storyboardSceneId": "c2-s2"
    }
  ],
  "tracks": [
    {
      "id": "t-music",
      "kind": "audio",
      "role": "music",
      "name": "Music bed",
      "muted": false,
      "volume": 0.8,
      "items": [
        {
          "id": "music-bed",
          "assetId": "music-1",
          "startFrame": 0,
          "durationInFrames": 360,
          "trimStartFrame": 0,
          "volume": 0.5,
          "fadeInFrames": 15,
          "fadeOutFrames": 30
        }
      ]
    },
    {
      "id": "t-captions",
      "kind": "caption",
      "name": "Captions (en)",
      "language": "en",
      "style": { "preset": "bold-center", "position": "bottom", "color": "#FFFFFF", "backgroundColor": "#00000099" },
      "items": [
        { "id": "cap-1", "startFrame": 0, "durationInFrames": 45, "text": "Meet Acme Flow." },
        { "id": "cap-2", "startFrame": 45, "durationInFrames": 45, "text": "Plan, ship and measure." },
        { "id": "cap-3", "startFrame": 150, "durationInFrames": 60, "text": "Teams plan together," },
        { "id": "cap-4", "startFrame": 210, "durationInFrames": 60, "text": "ship faster and measure results." },
        { "id": "cap-5", "startFrame": 270, "durationInFrames": 90, "text": "Start free today." }
      ]
    },
    {
      "id": "t-overlay",
      "kind": "overlay",
      "name": "Lower thirds",
      "items": [
        {
          "id": "lt-1",
          "startFrame": 160,
          "durationInFrames": 90,
          "content": {
            "engine": "motion2d",
            "template": "lower-third",
            "props": { "name": "Jane Doe", "role": "Head of Product, Acme", "accentColor": "#F59E0B" },
            "layers": []
          },
          "opacity": 1,
          "zIndex": 10
        }
      ]
    }
  ],
  "metadata": {
    "generator": { "name": "vc-ai-director", "version": "0.1.0", "promptVersion": "m1.0" },
    "language": "en",
    "createdAt": "2026-10-09T08:00:00.000Z"
  }
}
```

How the example satisfies each invariant:

1. The scenes cover 0 → 90 → 150 → 270 → 360.
2. `ch-1` = [0, 150) holds `c1-s*` and `ch-2` = [150, 360) holds `c2-s*`.
3. All 20 ids (2 chapters, 4 scenes, 2 assets, 3 tracks, 7 track items, 2 layers) are unique.
4. `logo-1` is an `image`, used by the brand and an image layer. `music-1` is an `audio`, used by an audio item.
5. Track items are sorted and do not overlap. The cues touch at frame 45.
6. Transitions are 15 ≤ min(60, 90), 15 ≤ min(120, 60) and 15 ≤ min(90, 120).
7. Keyframes are `< 90` and `< 60`. The `3d` camera is on the `three` scene.
8. The fades total 45 ≤ 360. The layers end at 110 ≤ 120 and 90 ≤ 90.
9. There is no `generated` scene, so invariant 9 does not apply.

### 15.3 Validating your own timeline

```ts
// check-timeline.ts. Run with:
//   pnpm --filter @vc/schema exec tsx /abs/path/check-timeline.ts /abs/path/timeline.json
import { readFileSync } from 'node:fs';
import { formatZodIssues, safeParseTimeline } from '/abs/path/to/Video-Creation/packages/schema/src/index.ts';

const result = safeParseTimeline(JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')));
console.log(result.success ? 'valid' : formatZodIssues(result.error).join('\n'));
```

Import Zod only through `@vc/schema`. A bare `import { z } from 'zod'` in a script outside `packages/schema` can resolve to
a different Zod copy in the workspace, such as the campaigns MVP's Zod 3.

## 16. `ReferenceProfile` schema

`ReferenceProfileSchema` (`reference-profile.ts`) describes the analysis of one reference asset: a video, image, document,
audio file or script. The analysis engine that produces profiles is **planned (M3)**. The director already accepts profiles
in M1, for example to adopt `pacing.averageShotSeconds` for `reference-based` videos. The profile has its **own**
`schemaVersion: 1`, independent of the timeline. It uses plain `z.literal(1)` and has no migration registry yet. All times
are **seconds** (floats ≥ 0), not frames.

| Field | Type | Req. | Notes |
|---|---|---|---|
| `schemaVersion` | literal `1` | yes | |
| `id` | `Id` | yes | |
| `assetId` | `Id` | yes | The analyzed asset. |
| `kind` | `video`, `image`, `document`, `audio`, `script` | yes | |
| `createdAt` | `IsoDateTime` | yes | |
| `metadata` | `ReferenceMetadata` | yes | Every field optional; `{}` is valid. |
| `scenes` | `ReferenceScene[]` | yes | May be `[]`. |
| `palette` | `PaletteEntry[]` ≤ 16 | yes | |
| `typography` | `ReferenceTypography` | no | |
| `transitions` | `TransitionStat[]` | yes | |
| `pacing` | `Pacing` | no | |
| `transcript` | `Transcript` | no | |
| `audio` | `ReferenceAudio` | no | |
| `styleSummary` | string ≤ 2000 | no | |
| `moodTags` | string 1..64 [≤ 20] | yes | |
| `warnings` | string ≤ 1000 [] | yes | For example `No visual content`. |

| Sub-schema | Fields |
|---|---|
| `ReferenceMetadata` | `durationSeconds` ≥ 0 · `width`, `height` int ≥ 1 · `fps` (0, 1000] (fractional allowed, for example 29.97) · `videoCodec`, `audioCodec` string 1..64 · `hasAudio` boolean · `sizeBytes` int ≥ 0 · `pageCount` int ≥ 0. All optional. |
| `ReferenceScene` | `index` int ≥ 0 · `startSeconds`, `endSeconds` ≥ 0, refined so that `endSeconds ≥ startSeconds` (issue at `endSeconds`) · `keyframeAssetIds` `Id[]` ≤ 50 · `shotType?` `ShotType` · `cameraMovement?` `CameraMovement` · `description?` ≤ 1000 · `dominantColors` `Hex[]` ≤ 16 |
| `PaletteEntry` | `hex` Hex · `weight` 0..1 |
| `ReferenceTypography` | `fontsDetected` string 1..120 [≤ 50] · `styleNotes?` ≤ 2000 |
| `TransitionStat` | `type` `TransitionType` · `count` int ≥ 0 |
| `Pacing` | `averageShotSeconds` > 0 · `cutsPerMinute` ≥ 0 |
| `Transcript` | `language` `LanguageTag` · `segments` of `{ startSeconds, endSeconds ≥ 0, text ≤ 2000, speaker? 1..120 }`. Segment order and `end ≥ start` are not checked. |
| `ReferenceAudio` | `hasMusic`, `hasVoice` boolean · `tempoBpm?` (0, 400] · `loudnessLufs?` −100..10 |

`ShotTypeSchema` has 11 values: `establishing`, `wide`, `medium`, `close-up`, `extreme-close-up`, `over-the-shoulder`, `pov`,
`overhead`, `macro`, `insert`, `two-shot`.

`CameraMovementSchema` has 18 values: `static`, `pan-left`, `pan-right`, `tilt-up`, `tilt-down`, `dolly-in`, `dolly-out`,
`truck-left`, `truck-right`, `orbit`, `crane-up`, `crane-down`, `push-in`, `pull-out`, `zoom-in`, `zoom-out`, `handheld`,
`tracking`. This is the director's movement vocabulary, which is wider than the 15 `CameraPreset` values the timeline stores.

## 17. Differences from the M1 spec

The implementation follows [section 1 of the M1 spec](milestones/M1_IMPLEMENTATION_SPEC.md#1-vcschema-packagesschema--contract).
The table lists where it is stricter, more specific or broader. None of these differences loosens a rule the spec requires.

| Area | Spec | Implementation |
|---|---|---|
| `SafeUriSchema` | `asset:` or `https:`; reject `http`, `file`, `data`, `javascript`, credentials, control characters | It is an allow-list, so every other scheme (`ftp:`, `blob:`, …) is rejected too. It also rejects **any whitespace**, requires a **non-empty host** (`asset:img-1` fails), and requires at least 1 character. |
| JSON props | `props: Record<string, JsonValue>`, max depth 8 | `props` uses `JsonObjectSchema`. Depth counts nested containers, and the props object itself is level 1. The schema is built without recursion, so it converts to JSON Schema. |
| Structural extras | — | Added bounds: `layers` ≤ 500, `zoomRegions` ≤ 200, `negativePrompt` ≤ 4000, `jobId` 1..256, `narration.voiceId` 1..128, track `name` 1..200, `AssetRef.name` 1..255, `provider` 1..120, `license` 1..500, `width` and `height` int ≥ 1, generator `name` 1..120, `version` and `promptVersion` 1..64. `storyboardSceneId` is a free string of 1..128, not an `Id`. |
| Unknown keys | Not specified | Stripped silently (Zod's default). |
| When invariants run | Not specified | Skipped if the structural pass produced an aborting issue ([section 5.1](#51-how-validation-runs)). |
| Invariant 3 | Unique ids | The timeline's own `id` is outside the namespace. Ids are claimed in a fixed order, so the later duplicate is the one reported. |
| Invariant 4 | Kinds for footage, screen, video clips, image content, image layers, brand logo, audio, `three` model, generated | Also covers overlay `image` content and image layers inside overlay `motion2d` content. |
| Invariant 5 | Items within bounds; no overlap (sorted) | "Not sorted" and "overlaps" are reported separately. Touching items are allowed. |
| Invariant 8 | Layers fit the scene | Layers inside overlay content must also fit their overlay item. |
| `safeParseTimeline` | Non-throwing variant | Converts `TimelineMigrationError` into a ZodError (root path for `INVALID_DOCUMENT`, otherwise `schemaVersion`). Other exceptions propagate. |
| `migrateTimeline` | `(input, migrations)` | Adds a `targetVersion` parameter, checks each step's output version, and uses typed error codes. |
| `expandCameraPreset` | Push-in, pan, Ken Burns, orbit, dolly, crane and static described | All 15 presets are defined in both spaces: 2D orbit, crane and dolly are approximations; 3D push and pull use `fov`; `handheld` has 6 keyframes; 1-frame scenes collapse to the start pose ([section 7](#7-camera-tracks-and-presets)). |
| `resolveDimensions` | Custom aspect or resolution requires both dimensions | Custom values are also rounded to the nearest even integer (minimum 2). The 16..8192 range is left to the schemas. |
| Limits | `checkTimelineLimits`, `checkVideoRequestLimits` | Adds the `INVALID_DIMENSIONS` code. `maxAssets` also bounds `referenceAssetIds`, and `maxPromptChars` also bounds `generated` scene prompts. Limits are inclusive. |
| Templates | `step-instruction`: `stepNumber` int ≥ 1, `totalSteps` int ≥ 1 | Both are capped at 999, with a refinement `stepNumber ≤ totalSteps`. Every text prop has explicit length bounds, and `stat-counter.value` is bounded to ±1e15. |
| `ReferenceProfile` | As listed | Added bounds: `keyframeAssetIds` ≤ 50, `dominantColors` ≤ 16, the refinement `endSeconds ≥ startSeconds`, `fontsDetected` ≤ 50, `moodTags` items 1..64 characters, `metadata.fps` (0, 1000], `tempoBpm` (0, 400], `loudnessLufs` −100..10. |
| Extra exports | — | `TimelineBaseSchema`, `TimelineMetadataSchema`, `TimelineGeneratorSchema`, `NormalizedSchema`, `LanguageTagSchema`, `IsoDateTimeSchema`, `JsonObjectSchema`, `JSON_LIMITS`, `EvenDimensionSchema`, `FpsSchema`, `RESOLUTION_SHORT_SIDE`, `ASPECT_RATIO_VALUES`, `OverlayContentSchema`, `NarrationSchema`, `Vec3Schema`, `TimelineMigrationError`, `formatZodIssues`, `llmSchemaIssues`, `TEMPLATE_IDS`, `isCatalogTemplateId`, `TemplateSummarySchema`, `defineTemplate`. |

## 18. Source map

| File (`packages/schema/src/`) | Contents |
|---|---|
| `common.ts` | `IdSchema`, `TemplateIdSchema`, `HexColorSchema`, `FrameSchema`, `DurationFramesSchema`, `EasingSchema`, `NormalizedSchema`, `FontFamilySchema`, `LanguageTagSchema`, `IsoDateTimeSchema`, `JsonValueSchema`, `JsonObjectSchema`, `SafeUriSchema`, `formatZodIssues` |
| `render-settings.ts` | `AspectRatioSchema`, `ResolutionSchema`, `EvenDimensionSchema`, `FpsSchema`, `RenderSettingsSchema`, `resolveDimensions` |
| `frames.ts` | `secondsToFrames`, `framesToSeconds`, `allocateFrames`, `formatTimecode` |
| `assets.ts` | `AssetRefSchema`, `AssetKindSchema`, `AssetSourceSchema`, `MimeTypeSchema` |
| `camera.ts` | Camera keyframes and tracks, `CameraPresetSchema`, `expandCameraPreset` |
| `transitions.ts` | `TransitionSchema`, `TransitionTypeSchema` |
| `layers.ts` | `Layer2DSchema`, `AnimationPresetSchema`, `FitSchema` |
| `scene-content.ts` | `SceneContentSchema` (6 engines), `OverlayContentSchema`, `EngineTypeSchema` |
| `scene.ts`, `chapter.ts`, `brand.ts` | `SceneSchema`, `NarrationSchema`, `ChapterSchema`, `BrandKitSchema` |
| `tracks.ts` | `TrackSchema` (audio, caption, overlay, video) |
| `timeline.ts` | `TimelineBaseSchema`, `TimelineSchema` (invariants 1–9), `parseTimeline`, `safeParseTimeline` |
| `migrations.ts` | `CURRENT_TIMELINE_VERSION`, `TIMELINE_MIGRATIONS`, `migrateTimeline`, `TimelineMigrationError` |
| `limits.ts` | `ResourceLimitsSchema`, `DEFAULT_RESOURCE_LIMITS`, `checkTimelineLimits`, `checkVideoRequestLimits` |
| `reference-profile.ts` | `ReferenceProfileSchema` |
| `director.ts` | Request and director artifact schemas, vocabularies, usage, `llmSchemaIssues` |
| `templates/` | One file per template, plus `catalog.ts`, `helpers.ts` and `types.ts` |
| `api.ts` | Studio HTTP DTOs (`ProjectVersionDTOSchema.timeline` is `TimelineSchema`) |

| Test (`packages/schema/test/`) | Covers |
|---|---|
| `timeline.test.ts` | Every invariant, with exact paths, plus `parseTimeline` and `safeParseTimeline` |
| `frames.test.ts` | `secondsToFrames`, `allocateFrames` (including 500 seeded random cases and 2 h at 60 fps), `formatTimecode` |
| `render-camera.test.ts` | `resolveDimensions`, `RenderSettingsSchema`, `expandCameraPreset` (every preset × space × 8 durations) |
| `common.test.ts`, `content-tracks.test.ts` | Primitives, `SafeUri`, JSON limits, content, layers and tracks |
| `migrations-limits.test.ts` | Migrations (injected v0 → v1) and resource limits |
| `templates.test.ts`, `director.test.ts` | Catalog, `buildProps` over 7 contexts, LLM safety of every LLM-facing schema |
| `fixtures.ts` | `buildValidTimeline()` (every engine and track kind) and `buildMinimalTimeline()` |
