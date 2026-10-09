import { z } from 'zod';
import { CameraPresetSchema } from './camera';
import {
  findIllFormedStrings,
  FontFamilySchema,
  HexColorSchema,
  IdSchema,
  ILL_FORMED_TEXT_MESSAGE,
  JsonObjectSchema,
  LanguageTagSchema,
  TemplateIdSchema,
} from './common';
import {
  ASPECT_RATIO_VALUES,
  AspectRatioSchema,
  dimensionsMatchAspectRatio,
  EvenDimensionSchema,
  FpsSchema,
  ResolutionSchema,
} from './render-settings';
import { EngineTypeSchema } from './scene-content';
import { TransitionTypeSchema } from './transitions';

// =============================================================================================
// Vocabularies
// =============================================================================================

export const VideoGenreSchema = z.enum([
  'cinematic-ad',
  'promo',
  'sop-training',
  'corporate-training',
  'comedy',
  'cartoon',
  'motion-graphics',
  'product-3d',
  'real-estate',
  'explainer',
  'presentation',
  'social-short',
  'long-form',
  'reference-based',
]);
export type VideoGenre = z.infer<typeof VideoGenreSchema>;

export const ShotTypeSchema = z.enum([
  'establishing',
  'wide',
  'medium',
  'close-up',
  'extreme-close-up',
  'over-the-shoulder',
  'pov',
  'overhead',
  'macro',
  'insert',
  'two-shot',
]);
export type ShotType = z.infer<typeof ShotTypeSchema>;

export const CameraMovementSchema = z.enum([
  'static',
  'pan-left',
  'pan-right',
  'tilt-up',
  'tilt-down',
  'dolly-in',
  'dolly-out',
  'truck-left',
  'truck-right',
  'orbit',
  'crane-up',
  'crane-down',
  'push-in',
  'pull-out',
  'zoom-in',
  'zoom-out',
  'handheld',
  'tracking',
]);
export type CameraMovement = z.infer<typeof CameraMovementSchema>;

// =============================================================================================
// User input (NOT LLM-facing)
// =============================================================================================

export const VideoRequestBrandSchema = z.object({
  name: z.string().max(120).optional(),
  colors: z.array(HexColorSchema).max(8),
  fontHeading: FontFamilySchema.optional(),
  fontBody: FontFamilySchema.optional(),
  logoAssetId: IdSchema.optional(),
});
export type VideoRequestBrand = z.infer<typeof VideoRequestBrandSchema>;

export const VoiceGenderSchema = z.enum(['female', 'male', 'neutral']);
export type VoiceGender = z.infer<typeof VoiceGenderSchema>;

export const VoiceOverSettingsSchema = z.object({
  enabled: z.boolean(),
  style: z.string().max(200).optional(),
  gender: VoiceGenderSchema.optional(),
});
export type VoiceOverSettings = z.infer<typeof VoiceOverSettingsSchema>;

export const MusicSettingsSchema = z.object({
  enabled: z.boolean(),
  mood: z.string().max(200).optional(),
});
export type MusicSettings = z.infer<typeof MusicSettingsSchema>;

/** Matches when a string has at least one character that is neither whitespace nor an invisible format char. */
const VISIBLE_CHAR = /[^\s\p{Cf}]/u;

/** Trimmed text with at least one visible character (whitespace / zero-width-only input is rejected). */
const RequiredUserText = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'Must not be empty or whitespace-only')
    .max(max)
    .refine((v) => v.length === 0 || VISIBLE_CHAR.test(v), {
      message: 'Must contain at least one visible (non-whitespace) character',
    });

/**
 * A user's video request. `durationSeconds` has NO maximum here — resource limits are applied separately
 * (`checkVideoRequestLimits`).
 * - `title` and `prompt` are trimmed and must contain a visible character; every string must be well-formed UTF-16.
 * - `custom` aspect ratio / resolution requires even custom dims in [16, 8192].
 * - aspectRatio `custom`: the custom W×H is used as-is and the resolution preset is IGNORED.
 * - resolution `custom` with a preset aspect ratio: the custom W×H must match that ratio (±1 px per side).
 */
export const VideoRequestSchema = z
  .object({
    title: RequiredUserText(200),
    prompt: RequiredUserText(20000),
    genre: VideoGenreSchema,
    styleNotes: z.string().max(2000).optional(),
    durationSeconds: z.number().positive(),
    aspectRatio: AspectRatioSchema,
    resolution: ResolutionSchema,
    customWidth: EvenDimensionSchema.optional(),
    customHeight: EvenDimensionSchema.optional(),
    fps: FpsSchema.default(30),
    language: LanguageTagSchema.default('en'),
    brand: VideoRequestBrandSchema.optional(),
    voiceOver: VoiceOverSettingsSchema,
    music: MusicSettingsSchema,
    referenceAssetIds: z.array(IdSchema).max(20).default([]),
  })
  .superRefine((req, ctx) => {
    if (req.aspectRatio === 'custom' || req.resolution === 'custom') {
      if (req.customWidth === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['customWidth'],
          message: 'customWidth (even, 16..8192) is required when aspectRatio or resolution is "custom"',
        });
      }
      if (req.customHeight === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['customHeight'],
          message: 'customHeight (even, 16..8192) is required when aspectRatio or resolution is "custom"',
        });
      }
    }
    if (
      req.resolution === 'custom' &&
      req.aspectRatio !== 'custom' &&
      req.customWidth !== undefined &&
      req.customHeight !== undefined &&
      !dimensionsMatchAspectRatio(req.customWidth, req.customHeight, req.aspectRatio)
    ) {
      const { w, h } = ASPECT_RATIO_VALUES[req.aspectRatio];
      const expectedHeight = Math.max(2, Math.round((req.customWidth * h) / w / 2) * 2);
      ctx.addIssue({
        code: 'custom',
        path: ['customWidth'],
        message:
          `Custom size ${req.customWidth}×${req.customHeight} does not match aspect ratio ${req.aspectRatio} ` +
          `(e.g. ${req.customWidth}×${expectedHeight}; ±1 px per side allowed). Use aspectRatio "custom" for a free size.`,
      });
    }
    findIllFormedStrings(req, (path) => ctx.addIssue({ code: 'custom', path, message: ILL_FORMED_TEXT_MESSAGE }));
  });
export type VideoRequest = z.infer<typeof VideoRequestSchema>;
export type VideoRequestInput = z.input<typeof VideoRequestSchema>;

// =============================================================================================
// LLM-facing artifacts — structured-output safe: closed objects, ALL properties required
// (nullable instead of optional), no records/maps, no recursion, no defaults.
// =============================================================================================

const LlmText = (max: number) => z.string().min(1).max(max);
const LlmNullableText = (max: number) => z.string().max(max).nullable();
const PositiveSeconds = z.number().gt(0);

export const VisualStyleSchema = z.object({
  description: LlmText(1000),
  palette: z.array(HexColorSchema).min(2).max(8),
  typography: LlmText(300),
  motionLanguage: LlmText(500),
});
export type VisualStyle = z.infer<typeof VisualStyleSchema>;

export const CreativeBriefSchema = z.object({
  title: LlmText(200),
  logline: LlmText(300),
  objective: LlmText(1000),
  targetAudience: LlmText(500),
  tone: z.array(LlmText(60)).min(1).max(6),
  genre: VideoGenreSchema,
  visualStyle: VisualStyleSchema,
  keyMessages: z.array(LlmText(300)).min(1).max(10),
  callToAction: LlmNullableText(200),
  referenceInfluence: LlmNullableText(1000),
  brandConsistencyNotes: z.string().max(1000),
});
export type CreativeBrief = z.infer<typeof CreativeBriefSchema>;

export const OutlineChapterSchema = z.object({
  id: IdSchema,
  title: LlmText(200),
  summary: LlmText(2000),
  targetDurationSeconds: PositiveSeconds,
});
export type OutlineChapter = z.infer<typeof OutlineChapterSchema>;

export const ScriptOutlineSchema = z.object({
  chapters: z.array(OutlineChapterSchema).min(1),
});
export type ScriptOutline = z.infer<typeof ScriptOutlineSchema>;

export const ScriptSegmentSchema = z.object({
  id: IdSchema,
  voiceOver: LlmNullableText(5000),
  onScreenText: LlmNullableText(500),
  visualIntent: LlmText(1000),
  targetDurationSeconds: PositiveSeconds,
});
export type ScriptSegment = z.infer<typeof ScriptSegmentSchema>;

export const ChapterScriptSchema = z.object({
  chapterId: IdSchema,
  segments: z.array(ScriptSegmentSchema).min(1),
});
export type ChapterScript = z.infer<typeof ChapterScriptSchema>;

/** Assembled from the outline + per-chapter scripts (not produced by the LLM in one call). */
export const ScriptChapterSchema = z.object({
  id: IdSchema,
  title: LlmText(200),
  summary: LlmText(2000),
  targetDurationSeconds: PositiveSeconds,
  segments: z.array(ScriptSegmentSchema),
});
export type ScriptChapter = z.infer<typeof ScriptChapterSchema>;

export const ScriptSchema = z.object({
  language: LanguageTagSchema,
  chapters: z.array(ScriptChapterSchema),
});
export type Script = z.infer<typeof ScriptSchema>;

export const StoryboardSceneSchema = z.object({
  id: IdSchema,
  chapterId: IdSchema,
  segmentIds: z.array(IdSchema).max(50),
  title: LlmText(200),
  visualDescription: LlmText(2000),
  voiceOver: LlmNullableText(5000),
  onScreenText: LlmNullableText(500),
  durationSeconds: PositiveSeconds,
  mood: LlmText(100),
  shotType: ShotTypeSchema,
  transitionIn: TransitionTypeSchema,
});
export type StoryboardScene = z.infer<typeof StoryboardSceneSchema>;

export const ChapterStoryboardSchema = z.object({
  chapterId: IdSchema,
  scenes: z.array(StoryboardSceneSchema),
});
export type ChapterStoryboard = z.infer<typeof ChapterStoryboardSchema>;

export const StoryboardSchema = z.object({
  scenes: z.array(StoryboardSceneSchema),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

export const ShotSchema = z.object({
  id: IdSchema,
  shotType: ShotTypeSchema,
  cameraMovement: CameraMovementSchema,
  subject: LlmText(500),
  durationSeconds: PositiveSeconds,
  notes: LlmNullableText(1000),
});
export type Shot = z.infer<typeof ShotSchema>;

export const SceneShotsSchema = z.object({
  sceneId: IdSchema,
  shots: z.array(ShotSchema).min(1).max(8),
});
export type SceneShots = z.infer<typeof SceneShotsSchema>;

export const ChapterShotListSchema = z.object({
  chapterId: IdSchema,
  scenes: z.array(SceneShotsSchema),
});
export type ChapterShotList = z.infer<typeof ChapterShotListSchema>;

export const ShotListSchema = z.object({
  scenes: z.array(SceneShotsSchema),
});
export type ShotList = z.infer<typeof ShotListSchema>;

export const EngineChoiceSchema = z.object({
  sceneId: IdSchema,
  engine: EngineTypeSchema,
  template: z.string().max(64).nullable(),
  provider: z.string().max(64).nullable(),
  rationale: z.string().max(500),
});
export type EngineChoice = z.infer<typeof EngineChoiceSchema>;

export const ChapterEngineSelectionSchema = z.object({
  chapterId: IdSchema,
  choices: z.array(EngineChoiceSchema),
});
export type ChapterEngineSelection = z.infer<typeof ChapterEngineSelectionSchema>;

export const EngineSelectionSchema = z.object({
  choices: z.array(EngineChoiceSchema),
});
export type EngineSelection = z.infer<typeof EngineSelectionSchema>;

// =============================================================================================
// Assembled artifacts (NOT LLM-facing as-is)
// =============================================================================================

export const SceneSpecEngineSchema = z.enum(['motion2d', 'three']);
export type SceneSpecEngine = z.infer<typeof SceneSpecEngineSchema>;

/**
 * Assembled scene spec. The LLM-facing per-template variant is built by the director from the catalog
 * (`props` = the template's `propsSchema`).
 */
export const SceneSpecSchema = z.object({
  sceneId: IdSchema,
  engine: SceneSpecEngineSchema,
  template: TemplateIdSchema,
  props: JsonObjectSchema,
  cameraPreset: CameraPresetSchema.nullable(),
});
export type SceneSpec = z.infer<typeof SceneSpecSchema>;

export const SceneSpecsSchema = z.object({
  scenes: z.array(SceneSpecSchema),
});
export type SceneSpecs = z.infer<typeof SceneSpecsSchema>;

/** Scene-spec props are checked by `JsonObjectSchema` itself; skip them in the artifact-wide string walk. */
const SKIP_PROPS: ReadonlySet<string> = new Set(['props']);

/** All director artifacts. Every string must be well-formed UTF-16 (artifacts are stored as PostgreSQL `jsonb`). */
export const DirectorArtifactsSchema = z
  .object({
    brief: CreativeBriefSchema,
    outline: ScriptOutlineSchema,
    script: ScriptSchema,
    storyboard: StoryboardSchema,
    shotList: ShotListSchema,
    engineSelection: EngineSelectionSchema,
    sceneSpecs: SceneSpecsSchema,
  })
  .superRefine((artifacts, ctx) => {
    findIllFormedStrings(
      artifacts,
      (path) => ctx.addIssue({ code: 'custom', path, message: ILL_FORMED_TEXT_MESSAGE }),
      SKIP_PROPS,
    );
  });
export type DirectorArtifacts = z.infer<typeof DirectorArtifactsSchema>;

export const DirectorStageSchema = z.enum([
  'brief',
  'outline',
  'script',
  'storyboard',
  'shotList',
  'engineSelection',
  'sceneSpecs',
  'compile',
]);
export type DirectorStage = z.infer<typeof DirectorStageSchema>;

// =============================================================================================
// Usage
// =============================================================================================

const TokenCount = z.number().int().min(0);

export const TokenUsageSchema = z.object({
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  cacheReadTokens: TokenCount,
  cacheWriteTokens: TokenCount,
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const StageUsageSchema = z.object({
  stage: DirectorStageSchema,
  chunk: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  attempts: z.number().int().min(1),
  cached: z.boolean(),
  usage: TokenUsageSchema,
  estimatedCostUsd: z.number().min(0),
  pricingKnown: z.boolean(),
  latencyMs: z.number().min(0),
});
export type StageUsage = z.infer<typeof StageUsageSchema>;

export const UsageTotalsSchema = TokenUsageSchema.extend({
  estimatedCostUsd: z.number().min(0),
  calls: z.number().int().min(0),
  cachedCalls: z.number().int().min(0),
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const UsageReportSchema = z.object({
  stages: z.array(StageUsageSchema),
  totals: UsageTotalsSchema,
});
export type UsageReport = z.infer<typeof UsageReportSchema>;

// =============================================================================================
// LLM-safety inspection
// =============================================================================================

const ALLOWED_LEAF_TYPES = new Set(['string', 'number', 'int', 'boolean', 'null', 'enum', 'literal']);

/**
 * Lists the reasons a schema is NOT structured-output safe (empty array = safe): optional/default/catch
 * wrappers, records/maps/sets/tuples, lazy (recursion), transforms/pipes, any/unknown/custom, open objects
 * (catchall) and any other type that cannot be expressed as a closed JSON Schema.
 */
export function llmSchemaIssues(schema: z.core.$ZodType, path = '(root)'): string[] {
  const type = schema._zod.def.type;
  if (schema instanceof z.core.$ZodObject) {
    const issues: string[] = [];
    const { shape, catchall } = schema._zod.def;
    if (catchall !== undefined && catchall._zod.def.type !== 'never') {
      issues.push(`${path}: object must be closed (no catchall)`);
    }
    for (const [key, child] of Object.entries(shape)) {
      const childPath = `${path}.${key}`;
      const childType = child._zod.def.type;
      if (childType === 'optional' || childType === 'default' || childType === 'prefault') {
        issues.push(`${childPath}: property must be required (use .nullable() instead of .${childType}())`);
        continue;
      }
      issues.push(...llmSchemaIssues(child, childPath));
    }
    return issues;
  }
  if (schema instanceof z.core.$ZodArray) {
    return llmSchemaIssues(schema._zod.def.element, `${path}[]`);
  }
  if (schema instanceof z.core.$ZodNullable) {
    return llmSchemaIssues(schema._zod.def.innerType, path);
  }
  if (schema instanceof z.core.$ZodReadonly) {
    return llmSchemaIssues(schema._zod.def.innerType, path);
  }
  if (schema instanceof z.core.$ZodUnion) {
    return schema._zod.def.options.flatMap((option, i) => llmSchemaIssues(option, `${path}|${i}`));
  }
  if (schema instanceof z.core.$ZodIntersection) {
    return [
      ...llmSchemaIssues(schema._zod.def.left, `${path}&0`),
      ...llmSchemaIssues(schema._zod.def.right, `${path}&1`),
    ];
  }
  if (ALLOWED_LEAF_TYPES.has(type)) return [];
  return [`${path}: type "${type}" is not allowed in LLM-facing schemas`];
}
