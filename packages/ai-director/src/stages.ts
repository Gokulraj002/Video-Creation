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
  type TemplateSummary,
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

export interface SceneSpecsSceneInput extends PositionedScene {
  shots: Shot[];
  choice: EngineChoice;
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

export type TemplateCatalogSummary = TemplateSummary[];
