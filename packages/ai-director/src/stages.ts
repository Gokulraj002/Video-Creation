import { z } from 'zod';
import {
  CameraPresetSchema,
  ChapterEngineSelectionSchema,
  ChapterScriptSchema,
  ChapterShotListSchema,
  ChapterStoryboardSchema,
  CreativeBriefSchema,
  IdSchema,
  ScriptOutlineSchema,
  TEMPLATE_CATALOG,
  type AnyTemplateDefinition,
  type ChapterScript,
  type CreativeBrief,
  type DirectorStage,
  type EngineChoice,
  type EngineType,
  type Shot,
  type StoryboardScene,
  type VideoGenre,
} from '@vc/schema';

/** Stages that call the provider (everything but `compile`). */
export type LlmStage = Exclude<DirectorStage, 'compile'>;

export const LLM_STAGES: readonly LlmStage[] = ['brief', 'outline', 'script', 'storyboard', 'shotList', 'engineSelection', 'sceneSpecs'];

// =============================================================================================
// LLM output schemas
// =============================================================================================

function sceneSpecVariant(t: AnyTemplateDefinition) {
  return z.object({
    sceneId: IdSchema,
    engine: z.literal(t.engine),
    template: z.literal(t.id),
    props: t.propsSchema,
    cameraPreset: CameraPresetSchema.nullable(),
  });
}

/**
 * Per-chapter scene-specs schema the model must produce: one discriminated variant per catalog template
 * (`props` = the template's LLM-safe `propsSchema`).
 */
export function buildChapterSceneSpecsLlmSchema(templates: readonly [AnyTemplateDefinition, ...AnyTemplateDefinition[]] = TEMPLATE_CATALOG) {
  const [first, ...rest] = templates;
  return z.object({
    chapterId: IdSchema,
    scenes: z.array(z.discriminatedUnion('template', [sceneSpecVariant(first), ...rest.map(sceneSpecVariant)])),
  });
}

export const ChapterSceneSpecsLlmSchema = buildChapterSceneSpecsLlmSchema();
export type ChapterSceneSpecsLlm = z.infer<typeof ChapterSceneSpecsLlmSchema>;

const SCENE_SPECS_SCHEMA_MEMO = new Map<string, typeof ChapterSceneSpecsLlmSchema>();
const MAX_SCENE_SPECS_SCHEMAS = 256;

/**
 * Scene-specs schema restricted to the given templates (the ones selected for a chunk): a much smaller structured
 * output schema than the whole catalog. Unknown ids are ignored; with no known id the full catalog schema is used.
 * Memoized per template set (stable instances keep the JSON-schema conversion cached).
 */
export function chapterSceneSpecsSchemaFor(templateIds: readonly string[]): typeof ChapterSceneSpecsLlmSchema {
  const wanted = new Set(templateIds);
  const selected = TEMPLATE_CATALOG.filter((t) => wanted.has(t.id));
  const [first, ...rest] = selected;
  if (!first) return ChapterSceneSpecsLlmSchema;
  if (selected.length === TEMPLATE_CATALOG.length) return ChapterSceneSpecsLlmSchema;
  const key = selected.map((t) => t.id).join('|');
  const cached = SCENE_SPECS_SCHEMA_MEMO.get(key);
  if (cached) return cached;
  const schema = buildChapterSceneSpecsLlmSchema([first, ...rest]);
  if (SCENE_SPECS_SCHEMA_MEMO.size >= MAX_SCENE_SPECS_SCHEMAS) SCENE_SPECS_SCHEMA_MEMO.clear();
  SCENE_SPECS_SCHEMA_MEMO.set(key, schema);
  return schema;
}

/** Output schema of every LLM stage. All are structured-output safe (see `llmSchemaIssues`). */
export const STAGE_OUTPUT_SCHEMAS = {
  brief: CreativeBriefSchema,
  outline: ScriptOutlineSchema,
  script: ChapterScriptSchema,
  storyboard: ChapterStoryboardSchema,
  shotList: ChapterShotListSchema,
  engineSelection: ChapterEngineSelectionSchema,
  sceneSpecs: ChapterSceneSpecsLlmSchema,
} as const satisfies Record<LlmStage, z.ZodType>;

export const STAGE_SCHEMA_NAMES: Readonly<Record<LlmStage, string>> = {
  brief: 'creative_brief',
  outline: 'script_outline',
  script: 'chapter_script',
  storyboard: 'chapter_storyboard',
  shotList: 'chapter_shot_list',
  engineSelection: 'chapter_engine_selection',
  sceneSpecs: 'chapter_scene_specs',
};

/** max_tokens per stage (non-streaming requests stay ≤ 16 000; adaptive thinking shares this budget). */
export const STAGE_MAX_OUTPUT_TOKENS: Readonly<Record<LlmStage, number>> = {
  brief: 8000,
  outline: 12000,
  script: 16000,
  storyboard: 16000,
  shotList: 16000,
  engineSelection: 12000,
  sceneSpecs: 16000,
};

// =============================================================================================
// Structured stage inputs (also rendered into the prompt; mocks build outputs from them)
// =============================================================================================

export interface RequestDigest {
  title: string;
  prompt: string;
  genre: VideoGenre;
  styleNotes: string | null;
  durationSeconds: number;
  aspectRatio: string;
  width: number;
  height: number;
  fps: number;
  language: string;
  brand: {
    name: string | null;
    colors: string[];
    fontHeading: string | null;
    fontBody: string | null;
    hasLogo: boolean;
  } | null;
  voiceOver: { enabled: boolean; style: string | null; gender: string | null };
  music: { enabled: boolean; mood: string | null };
}

export interface ReferenceDigest {
  id: string;
  kind: string;
  durationSeconds: number | null;
  sceneCount: number;
  averageShotSeconds: number | null;
  cutsPerMinute: number | null;
  palette: string[];
  moodTags: string[];
  styleSummary: string | null;
  transitions: string[];
  shotTypes: string[];
  cameraMovements: string[];
  fonts: string[];
  hasMusic: boolean | null;
  hasVoice: boolean | null;
  tempoBpm: number | null;
  transcriptExcerpt: string | null;
}

export interface PlanDigest {
  totalSeconds: number;
  chapterCount: number;
  chapterTargetSeconds: number[];
  targetSceneSeconds: number;
  sceneCountRange: { min: number; max: number };
  perChapterSceneRange: { min: number; max: number }[];
}

export interface ChapterContext {
  id: string;
  /** 0-based index. */
  index: number;
  /** 1-based number. */
  number: number;
  count: number;
  title: string;
  summary: string;
  targetDurationSeconds: number;
  sceneRange: { min: number; max: number };
  isFirst: boolean;
  isLast: boolean;
}

export interface BriefStageInput {
  request: RequestDigest;
  references: ReferenceDigest[];
  plan: PlanDigest;
}

export interface OutlineStageInput {
  request: RequestDigest;
  references: ReferenceDigest[];
  brief: CreativeBrief;
  plan: PlanDigest;
}

export interface ScriptStageInput {
  request: RequestDigest;
  brief: CreativeBrief;
  chapter: ChapterContext;
  targetSceneSeconds: number;
  /** Max segment count accepted by validation. */
  maxSegments: number;
  previousChapter: { title: string; summary: string } | null;
  nextChapter: { title: string; summary: string } | null;
}

export interface RegenerateContext {
  sceneId: string;
  durationSeconds: number;
  instructions: string | null;
  current: StoryboardScene;
  previousScene: { title: string; visualDescription: string } | null;
  nextScene: { title: string; visualDescription: string } | null;
  /** 0-based index of the scene in the whole video. */
  globalIndex: number;
  totalScenes: number;
}

export interface StoryboardStageInput {
  request: RequestDigest;
  brief: CreativeBrief;
  chapter: ChapterContext;
  script: ChapterScript;
  targetSceneSeconds: number;
  /** Index (0-based, whole video) of this chapter's first scene. */
  firstSceneIndex: number;
  references: ReferenceDigest[];
  regenerate: RegenerateContext | null;
}

export interface ShotListStageInput {
  request: RequestDigest;
  brief: CreativeBrief;
  chapter: ChapterContext;
  scenes: StoryboardScene[];
  references: ReferenceDigest[];
}

export interface PositionedScene {
  scene: StoryboardScene;
  /** 0-based index in the whole video. */
  globalIndex: number;
  isFirstInVideo: boolean;
  isLastInVideo: boolean;
  isFirstInChapter: boolean;
  isLastInChapter: boolean;
}

export interface EngineOption {
  engine: EngineType;
  available: boolean;
  reason: string | null;
}

export interface EngineSelectionStageInput {
  request: RequestDigest;
  brief: CreativeBrief;
  chapter: ChapterContext;
  scenes: PositionedScene[];
  totalScenes: number;
  engines: EngineOption[];
  hasCallToAction: boolean;
  /** Previous selection for the scene being regenerated (prefer a different look). */
  previousChoice: EngineChoice | null;
}

export interface SceneSpecTemplateInfo {
  id: string;
  engine: 'motion2d' | 'three';
  name: string;
  description: string;
  propsJsonSchema: Record<string, unknown>;
}

/** Global SOP step position of a `step-instruction` scene (numbered across the whole video, not per chapter). */
export interface StepPosition {
  stepNumber: number;
  totalSteps: number;
}

export interface SceneSpecsSceneInput extends PositionedScene {
  shots: Shot[];
  choice: EngineChoice;
  /**
   * Set for `step-instruction` scenes: the step's global number and the video's total step count (the director
   * enforces these values on the final props). Null / absent for other templates.
   */
  step?: StepPosition | null;
}

export interface SceneSpecsStageInput {
  request: RequestDigest;
  brief: CreativeBrief;
  chapter: ChapterContext;
  scenes: SceneSpecsSceneInput[];
  totalScenes: number;
  /** Only the templates selected for this chunk. */
  templates: SceneSpecTemplateInfo[];
  /** Asset ids the props may reference (image assets only). */
  imageAssetIds: string[];
}

export interface StageInputMap {
  brief: BriefStageInput;
  outline: OutlineStageInput;
  script: ScriptStageInput;
  storyboard: StoryboardStageInput;
  shotList: ShotListStageInput;
  engineSelection: EngineSelectionStageInput;
  sceneSpecs: SceneSpecsStageInput;
}
