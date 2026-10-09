import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as schema from '../src/index';

/** Every name the M1 spec (section 1) requires from `@vc/schema`. */
const REQUIRED_SCHEMAS = [
  // 1.1 common
  'IdSchema',
  'HexColorSchema',
  'FrameSchema',
  'DurationFramesSchema',
  'EasingSchema',
  'JsonValueSchema',
  'SafeUriSchema',
  'FontFamilySchema',
  'TemplateIdSchema',
  // 1.2 render settings
  'AspectRatioSchema',
  'ResolutionSchema',
  'RenderSettingsSchema',
  // 1.4–1.10
  'AssetRefSchema',
  'CameraPresetSchema',
  'Camera2DKeyframeSchema',
  'Camera3DKeyframeSchema',
  'CameraTrackSchema',
  'TransitionSchema',
  'AnimationPresetSchema',
  'Layer2DSchema',
  'EngineTypeSchema',
  'SceneContentSchema',
  'SceneSchema',
  'ChapterSchema',
  'BrandKitSchema',
  'TrackSchema',
  // 1.11–1.14
  'TimelineSchema',
  'ResourceLimitsSchema',
  'ReferenceProfileSchema',
  // 1.15 director
  'VideoGenreSchema',
  'ShotTypeSchema',
  'CameraMovementSchema',
  'VideoRequestSchema',
  'CreativeBriefSchema',
  'ScriptOutlineSchema',
  'ChapterScriptSchema',
  'ScriptSchema',
  'StoryboardSceneSchema',
  'ChapterStoryboardSchema',
  'StoryboardSchema',
  'ShotSchema',
  'ChapterShotListSchema',
  'ShotListSchema',
  'EngineChoiceSchema',
  'ChapterEngineSelectionSchema',
  'EngineSelectionSchema',
  'SceneSpecSchema',
  'SceneSpecsSchema',
  'DirectorArtifactsSchema',
  'DirectorStageSchema',
  'TokenUsageSchema',
  'StageUsageSchema',
  'UsageReportSchema',
  // 1.17 API
  'CreateProjectRequestSchema',
  'ProjectStatusSchema',
  'DirectorRunStatusSchema',
  'ProjectSummaryDTOSchema',
  'DirectorRunDTOSchema',
  'ProjectDetailDTOSchema',
  'ProjectVersionSummaryDTOSchema',
  'ProjectVersionDTOSchema',
  'SystemConfigDTOSchema',
  'UsageSummaryDTOSchema',
  'UsageWindowSchema',
  'ApiErrorSchema',
  'CreateDirectorRunRequestSchema',
  'MeDTOSchema',
] as const;

const REQUIRED_VALUES = [
  'resolveDimensions',
  'secondsToFrames',
  'framesToSeconds',
  'allocateFrames',
  'formatTimecode',
  'expandCameraPreset',
  'parseTimeline',
  'safeParseTimeline',
  'CURRENT_TIMELINE_VERSION',
  'DEFAULT_RESOURCE_LIMITS',
  'checkTimelineLimits',
  'checkVideoRequestLimits',
  'TIMELINE_MIGRATIONS',
  'migrateTimeline',
  'TEMPLATE_CATALOG',
  'getTemplate',
  'listTemplates',
  'validateTemplateProps',
  'templateCatalogSummary',
  'paginated',
] as const;

describe('public API (src/index.ts)', () => {
  it.each(REQUIRED_SCHEMAS)('exports %s as a Zod schema', (name) => {
    const value: unknown = (schema as Record<string, unknown>)[name];
    expect(value).toBeInstanceOf(z.ZodType);
  });

  it.each(REQUIRED_VALUES)('exports %s', (name) => {
    expect((schema as Record<string, unknown>)[name]).toBeDefined();
  });

  it('exports catalog templates by id order', () => {
    expect(schema.TEMPLATE_CATALOG.map((t) => t.id)).toEqual([...schema.TEMPLATE_IDS]);
  });
});
