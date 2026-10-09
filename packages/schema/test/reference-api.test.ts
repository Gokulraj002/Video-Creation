import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ApiErrorSchema,
  CreateDirectorRunRequestSchema,
  CreateProjectRequestSchema,
  DEFAULT_RESOURCE_LIMITS,
  DirectorRunDTOSchema,
  DirectorRunStatusSchema,
  MeDTOSchema,
  ProjectDetailDTOSchema,
  ProjectStatusSchema,
  ProjectSummaryDTOSchema,
  ProjectSummaryPageSchema,
  ProjectVersionDTOSchema,
  ProjectVersionSummaryDTOSchema,
  ReferenceProfileSchema,
  SystemConfigDTOSchema,
  UsageSummaryDTOSchema,
  UsageWindowSchema,
  VideoRequestSchema,
  paginated,
  templateCatalogSummary,
  type DirectorRunDTO,
  type ProjectSummaryDTO,
  type ReferenceProfile,
} from '../src/index';
import { buildDirectorArtifacts, buildValidTimeline, buildVideoRequest, buildVideoRequestInput } from './fixtures';
import { expectIssueAt, expectSuccess } from './helpers';

function buildReferenceProfile(): ReferenceProfile {
  return {
    schemaVersion: 1,
    id: 'ref-1',
    assetId: 'vid-1',
    kind: 'video',
    createdAt: '2026-10-09T08:00:00Z',
    metadata: {
      durationSeconds: 30,
      width: 1920,
      height: 1080,
      fps: 29.97,
      videoCodec: 'h264',
      audioCodec: 'aac',
      hasAudio: true,
      sizeBytes: 12_345_678,
    },
    scenes: [
      {
        index: 0,
        startSeconds: 0,
        endSeconds: 2.5,
        keyframeAssetIds: ['kf-1', 'kf-2'],
        shotType: 'wide',
        cameraMovement: 'dolly-in',
        description: 'City skyline at dusk',
        dominantColors: ['#112233', '#FFAA00'],
      },
      { index: 1, startSeconds: 2.5, endSeconds: 5, keyframeAssetIds: [], dominantColors: [] },
    ],
    palette: [
      { hex: '#112233', weight: 0.6 },
      { hex: '#FFAA00', weight: 0.4 },
    ],
    typography: { fontsDetected: ['Inter'], styleNotes: 'Bold sans headlines' },
    transitions: [
      { type: 'cut', count: 10 },
      { type: 'crossfade', count: 2 },
    ],
    pacing: { averageShotSeconds: 2.5, cutsPerMinute: 24 },
    transcript: {
      language: 'en-US',
      segments: [{ startSeconds: 0, endSeconds: 2, text: 'Hello world', speaker: 'Narrator' }],
    },
    audio: { hasMusic: true, hasVoice: true, tempoBpm: 120, loudnessLufs: -14 },
    styleSummary: 'Fast-paced urban promo',
    moodTags: ['energetic', 'urban'],
    warnings: [],
  };
}

describe('ReferenceProfileSchema', () => {
  it('accepts a full profile and a minimal profile', () => {
    expectSuccess(ReferenceProfileSchema.safeParse(buildReferenceProfile()));
    expectSuccess(
      ReferenceProfileSchema.safeParse({
        schemaVersion: 1,
        id: 'ref-2',
        assetId: 'doc-1',
        kind: 'document',
        createdAt: '2026-10-09T08:00:00+02:00',
        metadata: { pageCount: 12 },
        scenes: [],
        palette: [],
        transitions: [],
        moodTags: [],
        warnings: ['No visual content'],
      }),
    );
  });

  it.each([
    ['schemaVersion', (p: ReferenceProfile) => ({ ...p, schemaVersion: 2 })],
    ['kind', (p: ReferenceProfile) => ({ ...p, kind: 'website' })],
    ['createdAt', (p: ReferenceProfile) => ({ ...p, createdAt: 'yesterday' })],
    ['palette', (p: ReferenceProfile) => ({ ...p, palette: Array(17).fill({ hex: '#000000', weight: 0.1 }) })],
    ['palette.0.weight', (p: ReferenceProfile) => ({ ...p, palette: [{ hex: '#000000', weight: 1.5 }] })],
    ['moodTags', (p: ReferenceProfile) => ({ ...p, moodTags: Array.from({ length: 21 }, (_, i) => `m${i}`) })],
    ['scenes.0.endSeconds', (p: ReferenceProfile) => ({ ...p, scenes: [{ ...p.scenes[0], endSeconds: -1 }] })],
    ['scenes.0.shotType', (p: ReferenceProfile) => ({ ...p, scenes: [{ ...p.scenes[0], shotType: 'selfie' }] })],
    ['scenes.0.cameraMovement', (p: ReferenceProfile) => ({ ...p, scenes: [{ ...p.scenes[0], cameraMovement: 'warp' }] })],
    ['scenes.0.description', (p: ReferenceProfile) => ({ ...p, scenes: [{ ...p.scenes[0], description: 'x'.repeat(1001) }] })],
    ['scenes.0.keyframeAssetIds.0', (p: ReferenceProfile) => ({ ...p, scenes: [{ ...p.scenes[0], keyframeAssetIds: ['bad id'] }] })],
    ['transitions.0.type', (p: ReferenceProfile) => ({ ...p, transitions: [{ type: 'spin', count: 1 }] })],
    ['styleSummary', (p: ReferenceProfile) => ({ ...p, styleSummary: 'x'.repeat(2001) })],
    [
      'transcript.segments.0.text',
      (p: ReferenceProfile) => ({ ...p, transcript: { language: 'en', segments: [{ startSeconds: 0, endSeconds: 1, text: 'x'.repeat(2001) }] } }),
    ],
    ['pacing.averageShotSeconds', (p: ReferenceProfile) => ({ ...p, pacing: { averageShotSeconds: 0, cutsPerMinute: 1 } })],
  ])('rejects invalid %s', (path, mutate) => {
    const result = ReferenceProfileSchema.safeParse(mutate(buildReferenceProfile()));
    expectIssueAt(
      result,
      path.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)),
    );
  });

  it('rejects a reference scene that ends before it starts', () => {
    const p = buildReferenceProfile();
    const result = ReferenceProfileSchema.safeParse({ ...p, scenes: [{ ...p.scenes[0], startSeconds: 3, endSeconds: 2 }] });
    expectIssueAt(result, ['scenes', 0, 'endSeconds']);
  });
});

// ---------------------------------------------------------------------------------------------
// API DTOs
// ---------------------------------------------------------------------------------------------

const NOW = '2026-10-09T08:00:00.000Z';

function buildRun(): DirectorRunDTO {
  return {
    id: 'clrun0000000000000000000',
    projectId: 'clproj000000000000000000',
    status: 'running',
    provider: 'mock',
    model: 'mock-director-v1',
    progress: { completedSteps: 3, totalSteps: 8, currentStage: 'storyboard', message: 'Chapter 1 storyboard' },
    usage: null,
    error: null,
    versionNumber: null,
    createdAt: NOW,
    startedAt: NOW,
    finishedAt: null,
  };
}

function buildSummary(): ProjectSummaryDTO {
  return {
    id: 'clproj000000000000000000',
    title: 'Launch video',
    status: 'directing',
    genre: 'promo',
    durationSeconds: 30,
    aspectRatio: '9:16',
    createdAt: NOW,
    updatedAt: NOW,
    currentVersion: null,
  };
}

describe('API DTOs', () => {
  it('CreateProjectRequestSchema is the VideoRequestSchema', () => {
    expect(CreateProjectRequestSchema).toBe(VideoRequestSchema);
    expectSuccess(CreateProjectRequestSchema.safeParse(buildVideoRequestInput()));
  });

  it('CreateDirectorRunRequestSchema accepts an empty object', () => {
    expect(CreateDirectorRunRequestSchema.parse({})).toEqual({});
    expect(CreateDirectorRunRequestSchema.safeParse(null).success).toBe(false);
  });

  it('status enums', () => {
    expect(ProjectStatusSchema.options).toEqual(['draft', 'directing', 'ready', 'failed']);
    expect(DirectorRunStatusSchema.options).toEqual(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
  });

  it('ProjectSummaryDTOSchema', () => {
    expectSuccess(ProjectSummaryDTOSchema.safeParse(buildSummary()));
    expectSuccess(ProjectSummaryDTOSchema.safeParse({ ...buildSummary(), status: 'ready', currentVersion: 2 }));
    expectIssueAt(ProjectSummaryDTOSchema.safeParse({ ...buildSummary(), status: 'DRAFT' }), ['status']);
    expectIssueAt(ProjectSummaryDTOSchema.safeParse({ ...buildSummary(), createdAt: '2026-10-09' }), ['createdAt']);
    expectIssueAt(ProjectSummaryDTOSchema.safeParse({ ...buildSummary(), currentVersion: 1.5 }), ['currentVersion']);
    expectIssueAt(ProjectSummaryDTOSchema.safeParse({ ...buildSummary(), currentVersion: undefined }), ['currentVersion']);
  });

  it('DirectorRunDTOSchema', () => {
    expectSuccess(DirectorRunDTOSchema.safeParse(buildRun()));
    const finished: DirectorRunDTO = {
      ...buildRun(),
      status: 'succeeded',
      progress: { completedSteps: 8, totalSteps: 8, currentStage: null, message: null },
      usage: {
        stages: [],
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCostUsd: 0,
          calls: 0,
          cachedCalls: 0,
        },
      },
      versionNumber: 1,
      finishedAt: NOW,
    };
    expectSuccess(DirectorRunDTOSchema.safeParse(finished));
    expectSuccess(
      DirectorRunDTOSchema.safeParse({ ...buildRun(), status: 'failed', error: { code: 'VALIDATION_FAILED', message: 'bad' } }),
    );
    expectIssueAt(DirectorRunDTOSchema.safeParse({ ...buildRun(), status: 'done' }), ['status']);
    expectIssueAt(
      DirectorRunDTOSchema.safeParse({ ...buildRun(), progress: { ...buildRun().progress, currentStage: 'render' } }),
      ['progress', 'currentStage'],
    );
    expectIssueAt(DirectorRunDTOSchema.safeParse({ ...buildRun(), error: { message: 'x' } }), ['error', 'code']);
    expectIssueAt(DirectorRunDTOSchema.safeParse({ ...buildRun(), startedAt: undefined }), ['startedAt']);
  });

  it('ProjectDetailDTOSchema', () => {
    const detail = { ...buildSummary(), request: buildVideoRequest(), latestRun: buildRun() };
    expectSuccess(ProjectDetailDTOSchema.safeParse(detail));
    expectSuccess(ProjectDetailDTOSchema.safeParse({ ...detail, latestRun: null }));
    expectIssueAt(ProjectDetailDTOSchema.safeParse({ ...detail, request: { ...buildVideoRequest(), genre: 'x' } }), [
      'request',
      'genre',
    ]);
  });

  it('ProjectVersionSummaryDTOSchema / ProjectVersionDTOSchema', () => {
    const timeline = buildValidTimeline();
    const summary = {
      id: 'clver0000000000000000000',
      projectId: 'clproj000000000000000000',
      version: 1,
      schemaVersion: 1,
      createdAt: NOW,
      sceneCount: timeline.scenes.length,
      durationInFrames: timeline.durationInFrames,
      fps: timeline.settings.fps,
    };
    expectSuccess(ProjectVersionSummaryDTOSchema.safeParse(summary));
    expectIssueAt(ProjectVersionSummaryDTOSchema.safeParse({ ...summary, version: 0 }), ['version']);
    const full = { ...summary, artifacts: buildDirectorArtifacts(), timeline };
    expectSuccess(ProjectVersionDTOSchema.safeParse(full));
    // The embedded timeline is validated with all invariants.
    const broken = structuredClone(full);
    const s0 = broken.timeline.scenes[0];
    if (s0) s0.startFrame = 3;
    expectIssueAt(ProjectVersionDTOSchema.safeParse(broken), ['timeline', 'scenes', 0, 'startFrame']);
  });

  it('SystemConfigDTOSchema', () => {
    const config = {
      aiProvider: { name: 'mock', model: 'mock-director-v1', mode: 'mock', configured: true },
      queueDriver: 'inline',
      limits: DEFAULT_RESOURCE_LIMITS,
      engines: [
        { engine: 'motion2d', available: true, reason: null },
        { engine: 'generated', available: false, reason: 'no video generation provider configured' },
      ],
      templates: templateCatalogSummary(),
      promptVersion: 'm1.0',
    };
    expectSuccess(SystemConfigDTOSchema.safeParse(config));
    expectSuccess(SystemConfigDTOSchema.safeParse(JSON.parse(JSON.stringify(config))));
    expectIssueAt(SystemConfigDTOSchema.safeParse({ ...config, queueDriver: 'sqs' }), ['queueDriver']);
    expectIssueAt(
      SystemConfigDTOSchema.safeParse({ ...config, aiProvider: { ...config.aiProvider, mode: 'prod' } }),
      ['aiProvider', 'mode'],
    );
    expectIssueAt(SystemConfigDTOSchema.safeParse({ ...config, engines: [{ engine: 'unreal', available: true, reason: null }] }), [
      'engines',
      0,
      'engine',
    ]);
    expectIssueAt(SystemConfigDTOSchema.safeParse({ ...config, limits: { ...DEFAULT_RESOURCE_LIMITS, maxFps: 0 } }), [
      'limits',
      'maxFps',
    ]);
  });

  it('UsageSummaryDTOSchema / UsageWindowSchema', () => {
    const w = { runs: 2, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 50, estimatedCostUsd: 0.0125 };
    expectSuccess(UsageWindowSchema.safeParse(w));
    expectSuccess(UsageSummaryDTOSchema.safeParse({ today: w, month: w }));
    expectIssueAt(UsageSummaryDTOSchema.safeParse({ today: { ...w, runs: -1 }, month: w }), ['today', 'runs']);
    expectIssueAt(UsageSummaryDTOSchema.safeParse({ today: w }), ['month']);
  });

  it('MeDTOSchema', () => {
    expectSuccess(MeDTOSchema.safeParse({ id: 'u1', email: 'dev@localhost', name: null }));
    expectSuccess(MeDTOSchema.safeParse({ id: 'u1', email: 'a@b.co', name: 'Ada' }));
    expectIssueAt(MeDTOSchema.safeParse({ id: 'u1', email: 'a@b.co' }), ['name']);
  });

  it('ApiErrorSchema', () => {
    expectSuccess(ApiErrorSchema.safeParse({ error: { code: 'NOT_FOUND', message: 'Project not found' } }));
    expectSuccess(
      ApiErrorSchema.safeParse({ error: { code: 'VALIDATION_ERROR', message: 'Invalid body', details: [{ path: 'title' }] } }),
    );
    expectIssueAt(ApiErrorSchema.safeParse({ error: { message: 'x' } }), ['error', 'code']);
    expectIssueAt(ApiErrorSchema.safeParse({ code: 'X', message: 'x' }), ['error']);
  });

  it('paginated(item)', () => {
    const Page = paginated(z.object({ id: z.string() }));
    expect(Page.parse({ items: [{ id: 'a' }], nextCursor: 'a' })).toEqual({ items: [{ id: 'a' }], nextCursor: 'a' });
    expectSuccess(Page.safeParse({ items: [], nextCursor: null }));
    expectIssueAt(Page.safeParse({ items: [{ id: 1 }], nextCursor: null }), ['items', 0, 'id']);
    expectIssueAt(Page.safeParse({ items: [] }), ['nextCursor']);
    expectSuccess(ProjectSummaryPageSchema.safeParse({ items: [buildSummary()], nextCursor: null }));
  });
});
