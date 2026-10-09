import {
  CURRENT_TIMELINE_VERSION,
  DirectorArtifactsSchema,
  TimelineSchema,
  getTemplate,
  type DirectorArtifacts,
  type JsonObject,
  type TemplatePropsContext,
  type Timeline,
} from '@vc/schema';

/** Small, always-valid fixtures for unit tests (validated with the real @vc/schema schemas). */

const CTX: TemplatePropsContext = {
  title: 'Aurora',
  text: 'Light that adapts to you',
  bullets: ['Adaptive brightness', 'Voice control', 'All-day battery'],
  palette: ['#112233', '#ffaa00'],
  brandName: 'Aurora',
};

export function templateProps(id: string, ctx: TemplatePropsContext = CTX): JsonObject {
  const template = getTemplate(id);
  if (!template) throw new Error(`Unknown template ${id}`);
  return JSON.parse(JSON.stringify(template.buildProps(ctx))) as JsonObject;
}

/** 30 fps, 300 frames: s1 title-card [0,90) · s2 product-turntable [90,180) crossfade · s3 bullet-list [180,300) slide. */
export function buildTimeline(): Timeline {
  return TimelineSchema.parse({
    schemaVersion: CURRENT_TIMELINE_VERSION,
    id: 'tl-web',
    title: 'Aurora launch',
    settings: {
      width: 1920,
      height: 1080,
      fps: 30,
      backgroundColor: '#000000',
      sampleRate: 48000,
      videoCodec: 'h264',
      audioCodec: 'aac',
    },
    durationInFrames: 300,
    brand: {
      name: 'Aurora',
      colors: { primary: '#112233', secondary: '#334455', accent: '#ffaa00', background: '#0a0a0a', text: '#ffffff' },
      fonts: { heading: 'Inter', body: 'Inter' },
    },
    assets: [],
    chapters: [
      { id: 'c1', title: 'Hook', startFrame: 0, durationInFrames: 180 },
      { id: 'c2', title: 'Features', summary: 'What it does', startFrame: 180, durationInFrames: 120 },
    ],
    scenes: [
      {
        id: 'c1-s1',
        chapterId: 'c1',
        title: 'Opening title',
        startFrame: 0,
        durationInFrames: 90,
        content: { engine: 'motion2d', template: 'title-card', props: templateProps('title-card'), layers: [] },
        narration: { text: 'Meet Aurora, the lamp that adapts to you.' },
        storyboardSceneId: 'c1-s1',
      },
      {
        id: 'c1-s2',
        chapterId: 'c1',
        title: 'Product reveal',
        startFrame: 90,
        durationInFrames: 90,
        content: {
          engine: 'three',
          template: 'product-turntable',
          props: templateProps('product-turntable'),
          environment: 'studio',
          lighting: 'soft',
        },
        transitionIn: { type: 'crossfade', durationInFrames: 15, easing: 'ease-in-out' },
        storyboardSceneId: 'c1-s2',
      },
      {
        id: 'c2-s1',
        chapterId: 'c2',
        title: 'Feature list',
        startFrame: 180,
        durationInFrames: 120,
        content: { engine: 'motion2d', template: 'bullet-list', props: templateProps('bullet-list'), layers: [] },
        transitionIn: { type: 'slide', durationInFrames: 10, direction: 'left', easing: 'ease-out' },
        storyboardSceneId: 'c2-s1',
      },
    ],
    tracks: [
      {
        id: 'cap',
        kind: 'caption',
        name: 'Captions',
        language: 'en',
        style: { preset: 'bold-center', position: 'bottom', color: '#ffffff' },
        items: [
          { id: 'cue-1', startFrame: 0, durationInFrames: 45, text: 'Meet Aurora,' },
          { id: 'cue-2', startFrame: 45, durationInFrames: 45, text: 'the lamp that adapts to you.' },
        ],
      },
    ],
    metadata: { generator: { name: 'test', version: '0.0.0' } },
  });
}

export function buildArtifacts(): DirectorArtifacts {
  const scene = (id: string, chapterId: string, title: string, durationSeconds: number) => ({
    id,
    chapterId,
    segmentIds: [`${id}-seg`],
    title,
    visualDescription: `${title} visual`,
    voiceOver: id === 'c1-s1' ? 'Meet Aurora, the lamp that adapts to you.' : null,
    onScreenText: title,
    durationSeconds,
    mood: 'confident',
    shotType: 'medium' as const,
    transitionIn: 'cut' as const,
  });
  return DirectorArtifactsSchema.parse({
    brief: {
      title: 'Aurora launch',
      logline: 'A lamp that adapts to you.',
      objective: 'Drive pre-orders',
      targetAudience: 'Design-minded professionals',
      tone: ['confident'],
      genre: 'promo',
      visualStyle: { description: 'Warm minimal', palette: ['#112233', '#ffaa00'], typography: 'Inter', motionLanguage: 'Smooth' },
      keyMessages: ['Adaptive light'],
      callToAction: 'Pre-order now',
      referenceInfluence: null,
      brandConsistencyNotes: '',
    },
    outline: {
      chapters: [
        { id: 'c1', title: 'Hook', summary: 'Open strong', targetDurationSeconds: 6 },
        { id: 'c2', title: 'Features', summary: 'What it does', targetDurationSeconds: 4 },
      ],
    },
    script: {
      language: 'en',
      chapters: [
        {
          id: 'c1',
          title: 'Hook',
          summary: 'Open strong',
          targetDurationSeconds: 6,
          segments: [
            { id: 'c1-s1-seg', voiceOver: 'Meet Aurora.', onScreenText: 'Aurora', visualIntent: 'Title', targetDurationSeconds: 3 },
            { id: 'c1-s2-seg', voiceOver: null, onScreenText: null, visualIntent: 'Reveal', targetDurationSeconds: 3 },
          ],
        },
        {
          id: 'c2',
          title: 'Features',
          summary: 'What it does',
          targetDurationSeconds: 4,
          segments: [{ id: 'c2-s1-seg', voiceOver: null, onScreenText: 'Features', visualIntent: 'List', targetDurationSeconds: 4 }],
        },
      ],
    },
    storyboard: {
      scenes: [
        scene('c1-s1', 'c1', 'Opening title', 3),
        scene('c1-s2', 'c1', 'Product reveal', 3),
        scene('c2-s1', 'c2', 'Feature list', 4),
      ],
    },
    shotList: {
      scenes: [
        { sceneId: 'c1-s1', shots: [{ id: 'sh1', shotType: 'wide', cameraMovement: 'push-in', subject: 'Logo', durationSeconds: 3, notes: null }] },
        { sceneId: 'c1-s2', shots: [{ id: 'sh2', shotType: 'close-up', cameraMovement: 'orbit', subject: 'Lamp', durationSeconds: 3, notes: 'slow' }] },
        { sceneId: 'c2-s1', shots: [{ id: 'sh3', shotType: 'medium', cameraMovement: 'static', subject: 'Bullets', durationSeconds: 4, notes: null }] },
      ],
    },
    engineSelection: {
      choices: [
        { sceneId: 'c1-s1', engine: 'motion2d', template: 'title-card', provider: null, rationale: 'Strong open' },
        { sceneId: 'c1-s2', engine: 'three', template: 'product-turntable', provider: null, rationale: 'Show the product' },
        { sceneId: 'c2-s1', engine: 'motion2d', template: 'bullet-list', provider: null, rationale: 'Clear list' },
      ],
    },
    sceneSpecs: {
      scenes: [
        { sceneId: 'c1-s1', engine: 'motion2d', template: 'title-card', props: templateProps('title-card'), cameraPreset: 'push-in' },
        { sceneId: 'c1-s2', engine: 'three', template: 'product-turntable', props: templateProps('product-turntable'), cameraPreset: null },
        { sceneId: 'c2-s1', engine: 'motion2d', template: 'bullet-list', props: templateProps('bullet-list'), cameraPreset: 'static' },
      ],
    },
  });
}
