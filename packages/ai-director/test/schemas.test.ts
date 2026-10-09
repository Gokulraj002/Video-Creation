import { describe, expect, it } from 'vitest';
import {
  ChapterEngineSelectionSchema,
  ChapterScriptSchema,
  ChapterShotListSchema,
  ChapterStoryboardSchema,
  CreativeBriefSchema,
  llmSchemaIssues,
  ScriptOutlineSchema,
  type CreativeBrief,
} from '@vc/schema';
import {
  ChapterSceneSpecsLlmSchema,
  LLM_STAGES,
  STAGE_OUTPUT_SCHEMAS,
  STAGE_SCHEMA_NAMES,
  toStructuredOutputSchema,
} from '../src';

const brief: CreativeBrief = {
  title: 'Aurora',
  logline: 'A bottle that reminds you to drink.',
  objective: 'Sell the bottle.',
  targetAudience: 'Busy professionals',
  tone: ['upbeat'],
  genre: 'promo',
  visualStyle: { description: 'Bright', palette: ['#000000', '#FFFFFF'], typography: 'Sans', motionLanguage: 'Snappy' },
  keyMessages: ['Stay hydrated'],
  callToAction: null,
  referenceInfluence: null,
  brandConsistencyNotes: '',
};

describe('LLM-facing stage schemas', () => {
  it.each(LLM_STAGES)('%s schema is structured-output safe and converts to JSON Schema', (stage) => {
    const schema = STAGE_OUTPUT_SCHEMAS[stage];
    expect(llmSchemaIssues(schema)).toEqual([]);
    expect(STAGE_SCHEMA_NAMES[stage]).toMatch(/^[a-z_]+$/);
    const json = toStructuredOutputSchema(schema);
    expect(json.type).toBe('object');
    expect(json.additionalProperties).toBe(false);
  });

  it('CreativeBrief: accepts a valid brief and rejects invalid ones', () => {
    expect(CreativeBriefSchema.safeParse(brief).success).toBe(true);
    expect(CreativeBriefSchema.safeParse({ ...brief, visualStyle: { ...brief.visualStyle, palette: ['#000000'] } }).success).toBe(false);
    expect(CreativeBriefSchema.safeParse({ ...brief, tone: [] }).success).toBe(false);
    expect(CreativeBriefSchema.safeParse({ ...brief, genre: 'opera' }).success).toBe(false);
    const { callToAction: _omit, ...missingNullable } = brief;
    void _omit;
    expect(CreativeBriefSchema.safeParse(missingNullable).success).toBe(false); // nullable ≠ optional
    expect(CreativeBriefSchema.safeParse({ ...brief, logline: 'x'.repeat(301) }).success).toBe(false);
  });

  it('ScriptOutline: valid and invalid fixtures', () => {
    const valid = { chapters: [{ id: 'c1', title: 'Intro', summary: 'Start.', targetDurationSeconds: 30 }] };
    expect(ScriptOutlineSchema.safeParse(valid).success).toBe(true);
    expect(ScriptOutlineSchema.safeParse({ chapters: [] }).success).toBe(false);
    expect(ScriptOutlineSchema.safeParse({ chapters: [{ ...valid.chapters[0], targetDurationSeconds: 0 }] }).success).toBe(false);
    expect(ScriptOutlineSchema.safeParse({ chapters: [{ ...valid.chapters[0], id: 'bad id!' }] }).success).toBe(false);
  });

  it('ChapterScript: requires explicit nulls and positive durations', () => {
    const segment = { id: 'g1', voiceOver: null, onScreenText: 'Hi', visualIntent: 'A wave', targetDurationSeconds: 3 };
    expect(ChapterScriptSchema.safeParse({ chapterId: 'c1', segments: [segment] }).success).toBe(true);
    const { voiceOver: _vo, ...noVo } = segment;
    void _vo;
    expect(ChapterScriptSchema.safeParse({ chapterId: 'c1', segments: [noVo] }).success).toBe(false);
    expect(ChapterScriptSchema.safeParse({ chapterId: 'c1', segments: [] }).success).toBe(false);
    expect(ChapterScriptSchema.safeParse({ chapterId: 'c1', segments: [{ ...segment, targetDurationSeconds: -1 }] }).success).toBe(false);
  });

  it('ChapterStoryboard: validates enums', () => {
    const scene = {
      id: 's1',
      chapterId: 'c1',
      segmentIds: ['g1'],
      title: 'Open',
      visualDescription: 'Logo on black',
      voiceOver: null,
      onScreenText: null,
      durationSeconds: 3,
      mood: 'bold',
      shotType: 'wide',
      transitionIn: 'cut',
    };
    expect(ChapterStoryboardSchema.safeParse({ chapterId: 'c1', scenes: [scene] }).success).toBe(true);
    expect(ChapterStoryboardSchema.safeParse({ chapterId: 'c1', scenes: [{ ...scene, shotType: 'drone' }] }).success).toBe(false);
    expect(ChapterStoryboardSchema.safeParse({ chapterId: 'c1', scenes: [{ ...scene, transitionIn: 'spin' }] }).success).toBe(false);
  });

  it('ChapterShotList: 1..8 shots per scene', () => {
    const shot = { id: 'sh1', shotType: 'close-up', cameraMovement: 'push-in', subject: 'Bottle', durationSeconds: 2, notes: null };
    expect(ChapterShotListSchema.safeParse({ chapterId: 'c1', scenes: [{ sceneId: 's1', shots: [shot] }] }).success).toBe(true);
    expect(ChapterShotListSchema.safeParse({ chapterId: 'c1', scenes: [{ sceneId: 's1', shots: [] }] }).success).toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...shot, id: `sh${i}` }));
    expect(ChapterShotListSchema.safeParse({ chapterId: 'c1', scenes: [{ sceneId: 's1', shots: nine }] }).success).toBe(false);
    expect(ChapterShotListSchema.safeParse({ chapterId: 'c1', scenes: [{ sceneId: 's1', shots: [{ ...shot, cameraMovement: 'barrel-roll' }] }] }).success).toBe(false);
  });

  it('ChapterEngineSelection: engine enum', () => {
    const choice = { sceneId: 's1', engine: 'motion2d', template: 'title-card', provider: null, rationale: 'Opener' };
    expect(ChapterEngineSelectionSchema.safeParse({ chapterId: 'c1', choices: [choice] }).success).toBe(true);
    expect(ChapterEngineSelectionSchema.safeParse({ chapterId: 'c1', choices: [{ ...choice, engine: 'flash' }] }).success).toBe(false);
  });

  it('ChapterSceneSpecs (LLM): template-discriminated props', () => {
    const spec = {
      sceneId: 's1',
      engine: 'motion2d',
      template: 'title-card',
      props: {
        headline: 'Hello',
        subheadline: null,
        align: 'center',
        background: { style: 'solid', colors: ['#000000'] },
        accentColor: '#FFFFFF',
      },
      cameraPreset: null,
    };
    expect(ChapterSceneSpecsLlmSchema.safeParse({ chapterId: 'c1', scenes: [spec] }).success).toBe(true);
    expect(ChapterSceneSpecsLlmSchema.safeParse({ chapterId: 'c1', scenes: [{ ...spec, engine: 'three' }] }).success).toBe(false);
    expect(ChapterSceneSpecsLlmSchema.safeParse({ chapterId: 'c1', scenes: [{ ...spec, template: 'hologram' }] }).success).toBe(false);
    expect(
      ChapterSceneSpecsLlmSchema.safeParse({ chapterId: 'c1', scenes: [{ ...spec, props: { ...spec.props, headline: 'x'.repeat(121) } }] }).success,
    ).toBe(false);
    expect(ChapterSceneSpecsLlmSchema.safeParse({ chapterId: 'c1', scenes: [{ ...spec, cameraPreset: 'zoom-zoom' }] }).success).toBe(false);
    const turntable = {
      sceneId: 's2',
      engine: 'three',
      template: 'product-turntable',
      props: { primitive: 'bottle', color: '#0EA5E9', metalness: 0.4, roughness: 0.3, headline: null, rotationTurns: 1 },
      cameraPreset: 'orbit-right',
    };
    expect(ChapterSceneSpecsLlmSchema.safeParse({ chapterId: 'c1', scenes: [spec, turntable] }).success).toBe(true);
    expect(ChapterSceneSpecsLlmSchema.safeParse({ chapterId: 'c1', scenes: [{ ...turntable, props: { ...turntable.props, rotationTurns: 9 } }] }).success).toBe(false);
  });
});
