import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  CameraMovementSchema,
  ChapterEngineSelectionSchema,
  ChapterScriptSchema,
  ChapterShotListSchema,
  ChapterStoryboardSchema,
  CreativeBriefSchema,
  DirectorArtifactsSchema,
  DirectorStageSchema,
  EngineChoiceSchema,
  EngineSelectionSchema,
  ScriptOutlineSchema,
  ScriptSchema,
  SceneSpecSchema,
  SceneSpecsSchema,
  ShotListSchema,
  ShotSchema,
  ShotTypeSchema,
  StageUsageSchema,
  StoryboardSceneSchema,
  StoryboardSchema,
  TokenUsageSchema,
  UsageReportSchema,
  VideoGenreSchema,
  VideoRequestSchema,
  llmSchemaIssues,
} from '../src/index';
import { buildDirectorArtifacts, buildVideoRequest, buildVideoRequestInput } from './fixtures';
import { expectIssueAt, expectSuccess, jsonSchemaIssues, toJsonSchema } from './helpers';

describe('vocabularies', () => {
  it('VideoGenreSchema', () => {
    expect(VideoGenreSchema.options).toEqual([
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
  });
  it('ShotTypeSchema / CameraMovementSchema / DirectorStageSchema', () => {
    expect(ShotTypeSchema.options).toHaveLength(11);
    expect(ShotTypeSchema.options).toContain('over-the-shoulder');
    expect(CameraMovementSchema.options).toHaveLength(18);
    expect(CameraMovementSchema.options).toContain('tracking');
    expect(DirectorStageSchema.options).toEqual([
      'brief',
      'outline',
      'script',
      'storyboard',
      'shotList',
      'engineSelection',
      'sceneSpecs',
      'compile',
    ]);
  });
});

describe('VideoRequestSchema', () => {
  it('applies defaults (fps 30, language en, referenceAssetIds [])', () => {
    const parsed = VideoRequestSchema.parse(buildVideoRequestInput());
    expect(parsed.fps).toBe(30);
    expect(parsed.language).toBe('en');
    expect(parsed.referenceAssetIds).toEqual([]);
  });

  it('accepts a full request', () => {
    expectSuccess(VideoRequestSchema.safeParse(buildVideoRequest()));
  });

  it('has no maximum duration (limits are applied separately)', () => {
    expectSuccess(VideoRequestSchema.safeParse({ ...buildVideoRequestInput(), durationSeconds: 7 * 24 * 3600 }));
    expectSuccess(VideoRequestSchema.safeParse({ ...buildVideoRequestInput(), durationSeconds: 0.5 }));
  });

  it.each([
    ['durationSeconds', { durationSeconds: 0 }],
    ['durationSeconds', { durationSeconds: -5 }],
    ['durationSeconds', { durationSeconds: Number.POSITIVE_INFINITY }],
    ['durationSeconds', { durationSeconds: Number.NaN }],
    ['title', { title: '' }],
    ['title', { title: 'x'.repeat(201) }],
    ['prompt', { prompt: '' }],
    ['prompt', { prompt: 'x'.repeat(20_001) }],
    ['genre', { genre: 'horror' }],
    ['styleNotes', { styleNotes: 'x'.repeat(2001) }],
    ['fps', { fps: 0 }],
    ['fps', { fps: 241 }],
    ['fps', { fps: 29.97 }],
    ['language', { language: 'English' }],
    ['language', { language: 'en_US' }],
    ['aspectRatio', { aspectRatio: '21:9' }],
    ['resolution', { resolution: '4k' }],
    ['referenceAssetIds', { referenceAssetIds: Array.from({ length: 21 }, (_, i) => `ref-${i}`) }],
    ['referenceAssetIds.0', { referenceAssetIds: ['bad id'] }],
    ['brand.colors', { brand: { colors: Array(9).fill('#000000') } }],
    ['brand.colors.0', { brand: { colors: ['red'] } }],
    ['brand.fontHeading', { brand: { colors: [], fontHeading: 'Bad;Font' } }],
    ['brand.name', { brand: { colors: [], name: 'x'.repeat(121) } }],
    ['voiceOver.gender', { voiceOver: { enabled: true, gender: 'robot' } }],
    ['voiceOver.style', { voiceOver: { enabled: true, style: 'x'.repeat(201) } }],
    ['music.mood', { music: { enabled: true, mood: 'x'.repeat(201) } }],
    ['voiceOver', { voiceOver: undefined }],
  ])('rejects invalid %s', (path, patch) => {
    expectIssueAt(VideoRequestSchema.safeParse({ ...buildVideoRequestInput(), ...patch }), path.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)));
  });

  it('accepts BCP-47 language tags', () => {
    for (const language of ['en', 'en-US', 'pt-BR', 'zh-Hant', 'es-419']) {
      expectSuccess(VideoRequestSchema.safeParse({ ...buildVideoRequestInput(), language }));
    }
  });

  describe('custom dimensions refinement', () => {
    it('requires both custom dims for a custom aspect ratio', () => {
      const result = VideoRequestSchema.safeParse({ ...buildVideoRequestInput(), aspectRatio: 'custom' });
      expectIssueAt(result, ['customWidth'], /required/);
      expectIssueAt(result, ['customHeight'], /required/);
    });

    it('requires custom dims for a custom resolution', () => {
      const result = VideoRequestSchema.safeParse({ ...buildVideoRequestInput(), resolution: 'custom', customWidth: 640 });
      expectIssueAt(result, ['customHeight']);
      expect(result.success).toBe(false);
    });

    it('requires even dims in [16, 8192]', () => {
      const base = { ...buildVideoRequestInput(), aspectRatio: 'custom' as const };
      expectSuccess(VideoRequestSchema.safeParse({ ...base, customWidth: 1000, customHeight: 500 }));
      expectSuccess(VideoRequestSchema.safeParse({ ...base, customWidth: 16, customHeight: 8192 }));
      expectIssueAt(VideoRequestSchema.safeParse({ ...base, customWidth: 1001, customHeight: 500 }), ['customWidth']);
      expectIssueAt(VideoRequestSchema.safeParse({ ...base, customWidth: 14, customHeight: 500 }), ['customWidth']);
      expectIssueAt(VideoRequestSchema.safeParse({ ...base, customWidth: 1000, customHeight: 8194 }), ['customHeight']);
    });

    it('does not require custom dims for preset sizes', () => {
      expectSuccess(VideoRequestSchema.safeParse(buildVideoRequestInput()));
    });
  });
});

// ---------------------------------------------------------------------------------------------
// LLM-facing artifacts
// ---------------------------------------------------------------------------------------------

const artifacts = buildDirectorArtifacts();
const firstScene = artifacts.storyboard.scenes[0];
const firstShots = artifacts.shotList.scenes[0];
const firstSegment = artifacts.script.chapters[0]?.segments[0];
if (!firstScene || !firstShots || !firstSegment) throw new Error('fixture');

interface LlmCase {
  name: string;
  schema: z.ZodType;
  valid: unknown;
  invalid: [string, unknown, (string | number)[]][];
}

const LLM_CASES: LlmCase[] = [
  {
    name: 'CreativeBriefSchema',
    schema: CreativeBriefSchema,
    valid: artifacts.brief,
    invalid: [
      ['missing nullable callToAction', { ...artifacts.brief, callToAction: undefined }, ['callToAction']],
      ['empty tone', { ...artifacts.brief, tone: [] }, ['tone']],
      ['7 tones', { ...artifacts.brief, tone: Array(7).fill('x') }, ['tone']],
      ['logline > 300', { ...artifacts.brief, logline: 'x'.repeat(301) }, ['logline']],
      [
        'palette of 1',
        { ...artifacts.brief, visualStyle: { ...artifacts.brief.visualStyle, palette: ['#000000'] } },
        ['visualStyle', 'palette'],
      ],
      [
        'palette of 9',
        { ...artifacts.brief, visualStyle: { ...artifacts.brief.visualStyle, palette: Array(9).fill('#000000') } },
        ['visualStyle', 'palette'],
      ],
      ['11 key messages', { ...artifacts.brief, keyMessages: Array(11).fill('x') }, ['keyMessages']],
      ['bad genre', { ...artifacts.brief, genre: 'western' }, ['genre']],
    ],
  },
  {
    name: 'ScriptOutlineSchema',
    schema: ScriptOutlineSchema,
    valid: artifacts.outline,
    invalid: [
      ['no chapters', { chapters: [] }, ['chapters']],
      [
        'zero duration',
        { chapters: [{ id: 'c1', title: 'A', summary: 'B', targetDurationSeconds: 0 }] },
        ['chapters', 0, 'targetDurationSeconds'],
      ],
    ],
  },
  {
    name: 'ChapterScriptSchema',
    schema: ChapterScriptSchema,
    valid: { chapterId: 'c1', segments: artifacts.script.chapters[0]?.segments },
    invalid: [
      ['no segments', { chapterId: 'c1', segments: [] }, ['segments']],
      ['missing voiceOver key', { chapterId: 'c1', segments: [{ ...firstSegment, voiceOver: undefined }] }, ['segments', 0, 'voiceOver']],
      ['bad id', { chapterId: 'c 1', segments: [firstSegment] }, ['chapterId']],
    ],
  },
  {
    name: 'StoryboardSceneSchema',
    schema: StoryboardSceneSchema,
    valid: firstScene,
    invalid: [
      ['zero duration', { ...firstScene, durationSeconds: 0 }, ['durationSeconds']],
      ['bad shot type', { ...firstScene, shotType: 'selfie' }, ['shotType']],
      ['bad transition', { ...firstScene, transitionIn: 'spin' }, ['transitionIn']],
      ['missing onScreenText', { ...firstScene, onScreenText: undefined }, ['onScreenText']],
    ],
  },
  {
    name: 'ChapterStoryboardSchema',
    schema: ChapterStoryboardSchema,
    valid: { chapterId: 'c1', scenes: artifacts.storyboard.scenes },
    invalid: [['scene invalid', { chapterId: 'c1', scenes: [{ ...firstScene, mood: '' }] }, ['scenes', 0, 'mood']]],
  },
  {
    name: 'StoryboardSchema',
    schema: StoryboardSchema,
    valid: artifacts.storyboard,
    invalid: [['not array', { scenes: {} }, ['scenes']]],
  },
  {
    name: 'ShotSchema',
    schema: ShotSchema,
    valid: firstShots.shots[0],
    invalid: [
      ['bad movement', { ...firstShots.shots[0], cameraMovement: 'barrel-roll' }, ['cameraMovement']],
      ['missing notes', { ...firstShots.shots[0], notes: undefined }, ['notes']],
    ],
  },
  {
    name: 'ChapterShotListSchema',
    schema: ChapterShotListSchema,
    valid: { chapterId: 'c1', scenes: artifacts.shotList.scenes },
    invalid: [
      ['no shots', { chapterId: 'c1', scenes: [{ sceneId: 'c1-s1', shots: [] }] }, ['scenes', 0, 'shots']],
      [
        '9 shots',
        { chapterId: 'c1', scenes: [{ sceneId: 'c1-s1', shots: Array(9).fill(firstShots.shots[0]) }] },
        ['scenes', 0, 'shots'],
      ],
    ],
  },
  {
    name: 'ShotListSchema',
    schema: ShotListSchema,
    valid: artifacts.shotList,
    invalid: [['missing scenes', {}, ['scenes']]],
  },
  {
    name: 'EngineChoiceSchema',
    schema: EngineChoiceSchema,
    valid: artifacts.engineSelection.choices[0],
    invalid: [
      ['bad engine', { ...artifacts.engineSelection.choices[0], engine: 'unreal' }, ['engine']],
      ['rationale > 500', { ...artifacts.engineSelection.choices[0], rationale: 'x'.repeat(501) }, ['rationale']],
      ['missing provider', { ...artifacts.engineSelection.choices[0], provider: undefined }, ['provider']],
    ],
  },
  {
    name: 'ChapterEngineSelectionSchema',
    schema: ChapterEngineSelectionSchema,
    valid: { chapterId: 'c1', choices: artifacts.engineSelection.choices },
    invalid: [['missing chapterId', { choices: [] }, ['chapterId']]],
  },
  {
    name: 'EngineSelectionSchema',
    schema: EngineSelectionSchema,
    valid: artifacts.engineSelection,
    invalid: [['bad choice', { choices: [{}] }, ['choices', 0, 'sceneId']]],
  },
];

describe('LLM-facing director schemas', () => {
  for (const c of LLM_CASES) {
    describe(c.name, () => {
      it('accepts a valid fixture', () => {
        expectSuccess(c.schema.safeParse(c.valid));
      });
      for (const [name, value, path] of c.invalid) {
        it(`rejects: ${name}`, () => {
          expectIssueAt(c.schema.safeParse(value), path);
        });
      }
      it('is structured-output safe (closed, all-required, no records/defaults/recursion)', () => {
        expect(llmSchemaIssues(c.schema)).toEqual([]);
        expect(jsonSchemaIssues(toJsonSchema(c.schema))).toEqual([]);
      });
    });
  }

  it('rejects unknown keys only by stripping them (objects are closed in JSON Schema)', () => {
    const parsed = CreativeBriefSchema.parse({ ...artifacts.brief, extra: 'x' });
    expect('extra' in parsed).toBe(false);
  });
});

describe('assembled artifacts', () => {
  it('ScriptSchema', () => {
    expectSuccess(ScriptSchema.safeParse(artifacts.script));
    expectIssueAt(ScriptSchema.safeParse({ ...artifacts.script, language: 'xx_YY' }), ['language']);
  });

  it('SceneSpecSchema / SceneSpecsSchema', () => {
    expectSuccess(SceneSpecsSchema.safeParse(artifacts.sceneSpecs));
    const spec = artifacts.sceneSpecs.scenes[0];
    expectIssueAt(SceneSpecSchema.safeParse({ ...spec, engine: 'footage' }), ['engine']);
    expectIssueAt(SceneSpecSchema.safeParse({ ...spec, cameraPreset: 'barrel-roll' }), ['cameraPreset']);
    expectIssueAt(SceneSpecSchema.safeParse({ ...spec, props: [1] }), ['props']);
    // Catalog membership is NOT checked here (the director does it).
    expectSuccess(SceneSpecSchema.safeParse({ ...spec, template: 'future-template' }));
  });

  it('DirectorArtifactsSchema', () => {
    expectSuccess(DirectorArtifactsSchema.safeParse(artifacts));
    expectIssueAt(DirectorArtifactsSchema.safeParse({ ...artifacts, brief: undefined }), ['brief']);
    expect(DirectorArtifactsSchema.parse(JSON.parse(JSON.stringify(artifacts)))).toEqual(artifacts);
  });
});

describe('usage schemas', () => {
  const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0 };
  const stage = {
    stage: 'brief',
    chunk: null,
    provider: 'mock',
    model: 'mock-director-v1',
    attempts: 1,
    cached: false,
    usage,
    estimatedCostUsd: 0,
    pricingKnown: true,
    latencyMs: 12,
  };

  it('TokenUsageSchema requires non-negative ints', () => {
    expectSuccess(TokenUsageSchema.safeParse(usage));
    expectIssueAt(TokenUsageSchema.safeParse({ ...usage, inputTokens: -1 }), ['inputTokens']);
    expectIssueAt(TokenUsageSchema.safeParse({ ...usage, outputTokens: 1.5 }), ['outputTokens']);
  });

  it('StageUsageSchema', () => {
    expectSuccess(StageUsageSchema.safeParse(stage));
    expectSuccess(StageUsageSchema.safeParse({ ...stage, stage: 'script', chunk: 'c1', cached: true }));
    expectIssueAt(StageUsageSchema.safeParse({ ...stage, attempts: 0 }), ['attempts']);
    expectIssueAt(StageUsageSchema.safeParse({ ...stage, stage: 'render' }), ['stage']);
    expectIssueAt(StageUsageSchema.safeParse({ ...stage, estimatedCostUsd: -0.01 }), ['estimatedCostUsd']);
  });

  it('UsageReportSchema', () => {
    const report = {
      stages: [stage],
      totals: { ...usage, estimatedCostUsd: 0, calls: 1, cachedCalls: 0 },
    };
    expectSuccess(UsageReportSchema.safeParse(report));
    expectIssueAt(UsageReportSchema.safeParse({ ...report, totals: { ...usage, estimatedCostUsd: 0, calls: 1 } }), [
      'totals',
      'cachedCalls',
    ]);
  });
});
