/**
 * Reusable, always-valid fixtures. Every builder returns a FRESH deep object, so tests can mutate it freely.
 */
import {
  CURRENT_TIMELINE_VERSION,
  expandCameraPreset,
  getTemplate,
  type AssetRef,
  type JsonObject,
  type DirectorArtifacts,
  type Timeline,
  type TemplatePropsContext,
  type VideoRequest,
  type VideoRequestInput,
} from '../src/index';

export const FPS = 30;
export const TOTAL_FRAMES = 300;

export const ASSETS = {
  image: 'img-1',
  video: 'vid-1',
  generatedVideo: 'vid-gen-1',
  audio: 'aud-1',
  music: 'aud-2',
  model: 'model-1',
} as const;

export function buildAssets(): AssetRef[] {
  return [
    {
      id: ASSETS.image,
      kind: 'image',
      uri: `asset://${ASSETS.image}`,
      mimeType: 'image/png',
      name: 'Logo',
      width: 512,
      height: 512,
      source: 'upload',
    },
    {
      id: ASSETS.video,
      kind: 'video',
      uri: 'https://cdn.example.com/media/clip.mp4',
      mimeType: 'video/mp4',
      durationInFrames: 900,
      source: 'stock',
      provider: 'example-stock',
      license: 'CC-BY-4.0',
    },
    {
      id: ASSETS.generatedVideo,
      kind: 'video',
      uri: `asset://${ASSETS.generatedVideo}`,
      mimeType: 'video/mp4',
      source: 'generated',
      provider: 'runway',
    },
    { id: ASSETS.audio, kind: 'audio', uri: `asset://${ASSETS.audio}`, mimeType: 'audio/mpeg', source: 'generated' },
    { id: ASSETS.music, kind: 'audio', uri: `asset://${ASSETS.music}`, mimeType: 'audio/mpeg', source: 'stock' },
    {
      id: ASSETS.model,
      kind: 'model3d',
      uri: `asset://${ASSETS.model}`,
      mimeType: 'model/gltf-binary',
      sizeBytes: 1_048_576,
      source: 'upload',
    },
  ];
}

export const SAMPLE_CONTEXT: TemplatePropsContext = {
  title: 'Launch Day',
  text: 'Our new app helps teams ship 42% faster.',
  bullets: ['Plan together', 'Ship faster', 'Measure results'],
  palette: ['#112233', '#FFAA00'],
  brandName: 'Acme',
};

function templateProps(id: string, ctx: TemplatePropsContext = SAMPLE_CONTEXT): JsonObject {
  const template = getTemplate(id);
  if (!template) throw new Error(`missing template ${id}`);
  return JSON.parse(JSON.stringify(template.buildProps(ctx))) as JsonObject;
}

/**
 * A rich valid timeline (30 fps, 300 frames, 2 chapters, 6 scenes covering every engine, 4 tracks of every kind).
 *
 * Layout:
 * - chapters: `ch-1` [0,150), `ch-2` [150,300)
 * - scenes: `s-1` motion2d [0,60) · `s-2` three [60,90) · `s-3` footage [90,150) · `s-4` image [150,210) ·
 *   `s-5` generated [210,250) · `s-6` screen [250,300)
 * - tracks: `t-vo` audio · `t-cap` caption · `t-ov` overlay · `t-vid` video
 */
export function buildValidTimeline(): Timeline {
  return {
    schemaVersion: CURRENT_TIMELINE_VERSION,
    id: 'tl-1',
    title: 'Fixture timeline',
    settings: {
      width: 1080,
      height: 1920,
      fps: FPS,
      backgroundColor: '#000000',
      sampleRate: 48000,
      videoCodec: 'h264',
      audioCodec: 'aac',
    },
    durationInFrames: TOTAL_FRAMES,
    brand: {
      name: 'Acme',
      colors: { primary: '#112233', secondary: '#334455', accent: '#FFAA00', background: '#000000', text: '#FFFFFF' },
      fonts: { heading: 'Inter', body: 'Inter' },
      logoAssetId: ASSETS.image,
    },
    assets: buildAssets(),
    chapters: [
      { id: 'ch-1', title: 'Intro', summary: 'Opening', startFrame: 0, durationInFrames: 150 },
      { id: 'ch-2', title: 'Details', startFrame: 150, durationInFrames: 150 },
    ],
    scenes: [
      {
        id: 's-1',
        chapterId: 'ch-1',
        title: 'Title',
        startFrame: 0,
        durationInFrames: 60,
        content: {
          engine: 'motion2d',
          template: 'title-card',
          props: templateProps('title-card'),
          layers: [
            {
              id: 'layer-text',
              type: 'text',
              startFrame: 0,
              durationInFrames: 30,
              enter: 'fade',
              exit: 'none',
              opacity: 1,
              text: 'Hello',
              x: 0.5,
              y: 0.5,
              maxWidth: 0.8,
              fontFamily: 'Inter',
              fontSize: 64,
              fontWeight: 700,
              color: '#FFFFFF',
              align: 'center',
            },
            {
              id: 'layer-shape',
              type: 'shape',
              startFrame: 10,
              durationInFrames: 50,
              enter: 'scale',
              exit: 'fade',
              opacity: 0.8,
              shape: 'rect',
              x: 0.5,
              y: 0.9,
              width: 0.6,
              height: 0.01,
              color: '#FFAA00',
              cornerRadius: 2,
            },
            {
              id: 'layer-image',
              type: 'image',
              startFrame: 0,
              durationInFrames: 60,
              enter: 'pop',
              exit: 'none',
              opacity: 1,
              assetId: ASSETS.image,
              x: 0.5,
              y: 0.2,
              width: 0.3,
              height: 0.3,
              fit: 'contain',
            },
          ],
        },
        camera: expandCameraPreset('push-in', '2d', 60),
        narration: { text: 'Welcome to launch day.', voiceId: 'voice-1', language: 'en' },
        notes: 'Opening shot',
        storyboardSceneId: 'c1-s1',
      },
      {
        id: 's-2',
        chapterId: 'ch-1',
        title: 'Product',
        startFrame: 60,
        durationInFrames: 30,
        content: {
          engine: 'three',
          template: 'product-turntable',
          props: templateProps('product-turntable'),
          modelAssetId: ASSETS.model,
          environment: 'studio',
          lighting: 'soft',
        },
        camera: expandCameraPreset('orbit-right', '3d', 30),
        transitionIn: { type: 'fade', durationInFrames: 10, easing: 'ease-in-out' },
      },
      {
        id: 's-3',
        chapterId: 'ch-1',
        title: 'Footage',
        startFrame: 90,
        durationInFrames: 60,
        content: {
          engine: 'footage',
          assetId: ASSETS.video,
          trimStartFrame: 0,
          playbackRate: 1,
          fit: 'cover',
          volume: 0.5,
          muted: false,
        },
        transitionIn: { type: 'slide', durationInFrames: 30, direction: 'left', easing: 'ease-out' },
      },
      {
        id: 's-4',
        chapterId: 'ch-2',
        title: 'Still',
        startFrame: 150,
        durationInFrames: 60,
        content: {
          engine: 'image',
          assetId: ASSETS.image,
          animation: 'ken-burns',
          fit: 'cover',
          focalPoint: { x: 0.5, y: 0.4 },
        },
        camera: expandCameraPreset('ken-burns', '2d', 60),
        transitionIn: { type: 'cut', durationInFrames: 0, easing: 'linear' },
      },
      {
        id: 's-5',
        chapterId: 'ch-2',
        title: 'Generated',
        startFrame: 210,
        durationInFrames: 40,
        content: {
          engine: 'generated',
          provider: 'runway',
          prompt: 'A drone shot over a city at dusk',
          negativePrompt: 'blurry',
          seed: 42,
          status: 'ready',
          assetId: ASSETS.generatedVideo,
          jobId: 'job-123',
        },
        transitionIn: { type: 'crossfade', durationInFrames: 12, easing: 'linear' },
      },
      {
        id: 's-6',
        chapterId: 'ch-2',
        title: 'Screen',
        startFrame: 250,
        durationInFrames: 50,
        content: {
          engine: 'screen',
          assetId: ASSETS.video,
          trimStartFrame: 30,
          playbackRate: 1.5,
          zoomRegions: [{ startFrame: 5, durationInFrames: 20, x: 0.1, y: 0.1, width: 0.5, height: 0.5 }],
          highlightCursor: true,
        },
      },
    ],
    tracks: [
      {
        id: 't-vo',
        kind: 'audio',
        role: 'voiceover',
        name: 'Voice-over',
        muted: false,
        volume: 1,
        items: [
          {
            id: 'a-1',
            assetId: ASSETS.audio,
            startFrame: 0,
            durationInFrames: 150,
            trimStartFrame: 0,
            volume: 1,
            fadeInFrames: 10,
            fadeOutFrames: 10,
          },
          {
            id: 'a-2',
            assetId: ASSETS.music,
            startFrame: 150,
            durationInFrames: 150,
            trimStartFrame: 0,
            volume: 0.6,
            fadeInFrames: 0,
            fadeOutFrames: 30,
          },
        ],
      },
      {
        id: 't-cap',
        kind: 'caption',
        name: 'Captions',
        language: 'en',
        style: { preset: 'bold-center', position: 'bottom', fontFamily: 'Inter', fontSize: 48, color: '#FFFFFF' },
        items: [
          { id: 'cap-1', startFrame: 0, durationInFrames: 100, text: 'Welcome to launch day.', speaker: 'Narrator' },
          { id: 'cap-2', startFrame: 100, durationInFrames: 100, text: 'Ship faster.' },
        ],
      },
      {
        id: 't-ov',
        kind: 'overlay',
        name: 'Overlays',
        items: [
          {
            id: 'ov-1',
            startFrame: 30,
            durationInFrames: 60,
            content: {
              engine: 'motion2d',
              template: 'lower-third',
              props: templateProps('lower-third'),
              layers: [
                {
                  id: 'ov-layer-1',
                  type: 'text',
                  startFrame: 0,
                  durationInFrames: 60,
                  enter: 'slide-left',
                  exit: 'fade',
                  opacity: 1,
                  text: 'Jane Doe',
                  x: 0.2,
                  y: 0.85,
                  maxWidth: 0.4,
                  fontSize: 32,
                  fontWeight: 600,
                  color: '#FFFFFF',
                  align: 'left',
                },
              ],
            },
            opacity: 1,
            zIndex: 10,
          },
          {
            id: 'ov-2',
            startFrame: 200,
            durationInFrames: 60,
            content: {
              engine: 'image',
              assetId: ASSETS.image,
              animation: 'none',
              fit: 'contain',
              focalPoint: { x: 0.5, y: 0.5 },
            },
            opacity: 0.9,
            zIndex: 5,
          },
        ],
      },
      {
        id: 't-vid',
        kind: 'video',
        name: 'B-roll',
        items: [
          {
            id: 'v-1',
            assetId: ASSETS.video,
            startFrame: 0,
            durationInFrames: 100,
            trimStartFrame: 0,
            playbackRate: 1,
            opacity: 1,
            volume: 0,
            muted: true,
          },
        ],
      },
    ],
    metadata: {
      generator: { name: 'vc-ai-director', version: '0.1.0', promptVersion: 'm1.0' },
      language: 'en',
      createdAt: '2026-10-09T08:00:00.000Z',
    },
  };
}

/** Smallest valid timeline: one chapter, one motion2d scene, no tracks/assets. */
export function buildMinimalTimeline(durationInFrames = 90): Timeline {
  return {
    schemaVersion: CURRENT_TIMELINE_VERSION,
    id: 'tl-min',
    title: 'Minimal',
    settings: {
      width: 1920,
      height: 1080,
      fps: FPS,
      backgroundColor: '#101010',
      sampleRate: 44100,
      videoCodec: 'h264',
      audioCodec: 'aac',
    },
    durationInFrames,
    assets: [],
    chapters: [{ id: 'ch-1', title: 'Only', startFrame: 0, durationInFrames }],
    scenes: [
      {
        id: 's-1',
        chapterId: 'ch-1',
        title: 'Only scene',
        startFrame: 0,
        durationInFrames,
        content: { engine: 'motion2d', template: 'title-card', props: templateProps('title-card'), layers: [] },
      },
    ],
    tracks: [],
    metadata: { generator: { name: 'test', version: '1' } },
  };
}

/** A valid video request INPUT (defaults not applied). */
export function buildVideoRequestInput(): VideoRequestInput {
  return {
    title: 'Launch video',
    prompt: 'A 30 second promo for our new productivity app.',
    genre: 'promo',
    durationSeconds: 30,
    aspectRatio: '9:16',
    resolution: '1080p',
    voiceOver: { enabled: true, style: 'warm', gender: 'female' },
    music: { enabled: true, mood: 'upbeat' },
  };
}

/** A fully-populated, parsed video request. */
export function buildVideoRequest(): VideoRequest {
  return {
    title: 'Launch video',
    prompt: 'A 30 second promo for our new productivity app.',
    genre: 'promo',
    styleNotes: 'Bold and bright',
    durationSeconds: 30,
    aspectRatio: '9:16',
    resolution: '1080p',
    fps: 30,
    language: 'en',
    brand: { name: 'Acme', colors: ['#112233', '#FFAA00'], fontHeading: 'Inter', fontBody: 'Inter' },
    voiceOver: { enabled: true, style: 'warm', gender: 'female' },
    music: { enabled: true, mood: 'upbeat' },
    referenceAssetIds: [],
  };
}

/** Valid director artifacts for a one-chapter, two-scene video. */
export function buildDirectorArtifacts(): DirectorArtifacts {
  return {
    brief: {
      title: 'Launch video',
      logline: 'Teams ship faster with Acme.',
      objective: 'Drive sign-ups for the new app.',
      targetAudience: 'Product teams at startups',
      tone: ['energetic', 'confident'],
      genre: 'promo',
      visualStyle: {
        description: 'Bold flat colors with kinetic type',
        palette: ['#112233', '#FFAA00'],
        typography: 'Geometric sans, heavy headings',
        motionLanguage: 'Snappy slides and pops',
      },
      keyMessages: ['Ship faster', 'Plan together'],
      callToAction: 'Start free today',
      referenceInfluence: null,
      brandConsistencyNotes: 'Use Acme orange as the accent.',
    },
    outline: {
      chapters: [{ id: 'c1', title: 'Launch', summary: 'Hook and CTA', targetDurationSeconds: 30 }],
    },
    script: {
      language: 'en',
      chapters: [
        {
          id: 'c1',
          title: 'Launch',
          summary: 'Hook and CTA',
          targetDurationSeconds: 30,
          segments: [
            {
              id: 'c1-seg1',
              voiceOver: 'Meet the fastest way to ship.',
              onScreenText: 'Ship faster',
              visualIntent: 'Big kinetic headline',
              targetDurationSeconds: 15,
            },
            {
              id: 'c1-seg2',
              voiceOver: null,
              onScreenText: 'Start free today',
              visualIntent: 'End card with CTA',
              targetDurationSeconds: 15,
            },
          ],
        },
      ],
    },
    storyboard: {
      scenes: [
        {
          id: 'c1-s1',
          chapterId: 'c1',
          segmentIds: ['c1-seg1'],
          title: 'Hook',
          visualDescription: 'Headline slams in over orange gradient',
          voiceOver: 'Meet the fastest way to ship.',
          onScreenText: 'Ship faster',
          durationSeconds: 15,
          mood: 'energetic',
          shotType: 'wide',
          transitionIn: 'cut',
        },
        {
          id: 'c1-s2',
          chapterId: 'c1',
          segmentIds: ['c1-seg2'],
          title: 'CTA',
          visualDescription: 'End card with button',
          voiceOver: null,
          onScreenText: 'Start free today',
          durationSeconds: 15,
          mood: 'confident',
          shotType: 'medium',
          transitionIn: 'fade',
        },
      ],
    },
    shotList: {
      scenes: [
        {
          sceneId: 'c1-s1',
          shots: [
            {
              id: 'c1-s1-sh1',
              shotType: 'wide',
              cameraMovement: 'push-in',
              subject: 'Headline',
              durationSeconds: 15,
              notes: null,
            },
          ],
        },
        {
          sceneId: 'c1-s2',
          shots: [
            {
              id: 'c1-s2-sh1',
              shotType: 'medium',
              cameraMovement: 'static',
              subject: 'CTA button',
              durationSeconds: 15,
              notes: 'Hold on the button',
            },
          ],
        },
      ],
    },
    engineSelection: {
      choices: [
        { sceneId: 'c1-s1', engine: 'motion2d', template: 'kinetic-text', provider: null, rationale: 'Type-driven hook' },
        { sceneId: 'c1-s2', engine: 'motion2d', template: 'cta-end-card', provider: null, rationale: 'Closing CTA' },
      ],
    },
    sceneSpecs: {
      scenes: [
        {
          sceneId: 'c1-s1',
          engine: 'motion2d',
          template: 'kinetic-text',
          props: templateProps('kinetic-text'),
          cameraPreset: 'push-in',
        },
        {
          sceneId: 'c1-s2',
          engine: 'motion2d',
          template: 'cta-end-card',
          props: templateProps('cta-end-card'),
          cameraPreset: null,
        },
      ],
    },
  };
}

/** Deep clone helper for JSON-compatible fixtures. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}
