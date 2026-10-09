import { describe, expect, it } from 'vitest';
import {
  CURRENT_TIMELINE_VERSION,
  DEFAULT_RESOURCE_LIMITS,
  LimitViolationSchema,
  ResourceLimitsSchema,
  TIMELINE_MIGRATIONS,
  TimelineMigrationError,
  TimelineSchema,
  VideoRequestSchema,
  checkTimelineLimits,
  checkVideoRequestLimits,
  migrateTimeline,
  type ResourceLimits,
  type TimelineMigrations,
} from '../src/index';
import { buildValidTimeline, buildVideoRequest } from './fixtures';

function expectMigrationError(fn: () => unknown, code: TimelineMigrationError['code']): TimelineMigrationError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(TimelineMigrationError);
    if (err instanceof TimelineMigrationError) {
      expect(err.code).toBe(code);
      return err;
    }
  }
  throw new Error(`expected TimelineMigrationError ${code}`);
}

/** A v0 document: same as v1 but with `name` instead of `title` and no `schemaVersion: 1`. */
function buildV0Document(): Record<string, unknown> {
  const { title, ...rest } = buildValidTimeline();
  return { ...rest, schemaVersion: 0, name: title };
}

const fakeV0ToV1: TimelineMigrations = {
  0: (doc) => {
    const { name, ...rest } = doc;
    return { ...rest, title: name, schemaVersion: 1 };
  },
};

describe('migrateTimeline', () => {
  it('TIMELINE_MIGRATIONS is empty in v1', () => {
    expect(Object.keys(TIMELINE_MIGRATIONS)).toEqual([]);
    expect(CURRENT_TIMELINE_VERSION).toBe(1);
  });

  it('returns current-version documents unchanged', () => {
    const t = buildValidTimeline();
    expect(migrateTimeline(t)).toEqual(t);
  });

  it('applies an injected v0 → v1 migration, producing a valid timeline', () => {
    const migrated = migrateTimeline(buildV0Document(), fakeV0ToV1);
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.title).toBe('Fixture timeline');
    expect('name' in migrated).toBe(false);
    expect(TimelineSchema.safeParse(migrated).success).toBe(true);
  });

  it('applies migrations sequentially up to the target version', () => {
    const calls: number[] = [];
    const chain: TimelineMigrations = {
      0: (doc) => {
        calls.push(0);
        return { ...doc, schemaVersion: 1, step0: true };
      },
      1: (doc) => {
        calls.push(1);
        return { ...doc, schemaVersion: 2, step1: true };
      },
    };
    const out = migrateTimeline({ schemaVersion: 0 }, chain, 2);
    expect(calls).toEqual([0, 1]);
    expect(out).toEqual({ schemaVersion: 2, step0: true, step1: true });
    expect(migrateTimeline({ schemaVersion: 1 }, chain, 2)).toEqual({ schemaVersion: 2, step1: true });
  });

  it('errors when schemaVersion is missing', () => {
    const { schemaVersion: _omit, ...doc } = buildValidTimeline();
    void _omit;
    expectMigrationError(() => migrateTimeline(doc), 'MISSING_VERSION');
    expectMigrationError(() => migrateTimeline({ schemaVersion: undefined }), 'MISSING_VERSION');
  });

  it('errors on versions newer than current', () => {
    const err = expectMigrationError(() => migrateTimeline({ ...buildValidTimeline(), schemaVersion: 2 }), 'UNSUPPORTED_VERSION');
    expect(err.version).toBe(2);
    expect(err.message).toMatch(/newer/);
  });

  it('errors on invalid versions and documents', () => {
    expectMigrationError(() => migrateTimeline({ schemaVersion: '1' }), 'INVALID_VERSION');
    expectMigrationError(() => migrateTimeline({ schemaVersion: 0.5 }), 'INVALID_VERSION');
    expectMigrationError(() => migrateTimeline({ schemaVersion: -1 }), 'INVALID_VERSION');
    expectMigrationError(() => migrateTimeline(null), 'INVALID_DOCUMENT');
    expectMigrationError(() => migrateTimeline([]), 'INVALID_DOCUMENT');
    expectMigrationError(() => migrateTimeline('x'), 'INVALID_DOCUMENT');
  });

  it('errors when a migration step is missing (e.g. v0 with the empty v1 registry)', () => {
    const err = expectMigrationError(() => migrateTimeline(buildV0Document()), 'MISSING_MIGRATION');
    expect(err.version).toBe(0);
  });

  it('errors when a migration returns the wrong version', () => {
    const broken: TimelineMigrations = { 0: (doc) => ({ ...doc, schemaVersion: 0 }) };
    expectMigrationError(() => migrateTimeline({ schemaVersion: 0 }, broken), 'MIGRATION_FAILED');
  });
});

describe('resource limits', () => {
  it('DEFAULT_RESOURCE_LIMITS match the spec and validate', () => {
    expect(DEFAULT_RESOURCE_LIMITS).toEqual({
      maxDurationSeconds: 7200,
      maxWidth: 3840,
      maxHeight: 3840,
      maxFps: 60,
      maxScenes: 2000,
      maxChapters: 200,
      maxTracks: 50,
      maxAssets: 500,
      maxPromptChars: 20000,
    });
    expect(ResourceLimitsSchema.safeParse(DEFAULT_RESOURCE_LIMITS).success).toBe(true);
  });

  it('ResourceLimitsSchema requires positive ints', () => {
    expect(ResourceLimitsSchema.safeParse({ ...DEFAULT_RESOURCE_LIMITS, maxFps: 0 }).success).toBe(false);
    expect(ResourceLimitsSchema.safeParse({ ...DEFAULT_RESOURCE_LIMITS, maxScenes: 1.5 }).success).toBe(false);
    expect(ResourceLimitsSchema.safeParse({ ...DEFAULT_RESOURCE_LIMITS, maxAssets: undefined }).success).toBe(false);
  });

  it('checkTimelineLimits returns [] within limits', () => {
    expect(checkTimelineLimits(buildValidTimeline(), DEFAULT_RESOURCE_LIMITS)).toEqual([]);
  });

  it('checkTimelineLimits reports every exceeded limit', () => {
    const tight: ResourceLimits = {
      maxDurationSeconds: 5,
      maxWidth: 1000,
      maxHeight: 1000,
      maxFps: 24,
      maxScenes: 5,
      maxChapters: 1,
      maxTracks: 3,
      maxAssets: 5,
      maxPromptChars: 10,
    };
    const violations = checkTimelineLimits(buildValidTimeline(), tight);
    for (const v of violations) expect(LimitViolationSchema.safeParse(v).success).toBe(true);
    const byCode = Object.fromEntries(violations.map((v) => [v.code, v]));
    expect(byCode.MAX_DURATION_SECONDS).toMatchObject({ limit: 5, actual: 10 });
    expect(byCode.MAX_WIDTH).toMatchObject({ limit: 1000, actual: 1080 });
    expect(byCode.MAX_HEIGHT).toMatchObject({ limit: 1000, actual: 1920 });
    expect(byCode.MAX_FPS).toMatchObject({ limit: 24, actual: 30 });
    expect(byCode.MAX_SCENES).toMatchObject({ limit: 5, actual: 6 });
    expect(byCode.MAX_CHAPTERS).toMatchObject({ limit: 1, actual: 2 });
    expect(byCode.MAX_TRACKS).toMatchObject({ limit: 3, actual: 4 });
    expect(byCode.MAX_ASSETS).toMatchObject({ limit: 5, actual: 6 });
    expect(byCode.MAX_PROMPT_CHARS?.actual).toBeGreaterThan(10);
    expect(byCode.MAX_DURATION_SECONDS?.message).toMatch(/exceeds/);
  });

  it('limits are inclusive (equal to the limit is allowed)', () => {
    const t = buildValidTimeline();
    const exact: ResourceLimits = {
      maxDurationSeconds: 10,
      maxWidth: 1080,
      maxHeight: 1920,
      maxFps: 30,
      maxScenes: 6,
      maxChapters: 2,
      maxTracks: 4,
      maxAssets: 6,
      maxPromptChars: 32,
    };
    expect(checkTimelineLimits(t, exact)).toEqual([]);
  });

  it('checkVideoRequestLimits', () => {
    const request = buildVideoRequest();
    expect(checkVideoRequestLimits(request, DEFAULT_RESOURCE_LIMITS)).toEqual([]);

    const long = { ...request, durationSeconds: 7201 };
    expect(checkVideoRequestLimits(long, DEFAULT_RESOURCE_LIMITS).map((v) => v.code)).toEqual(['MAX_DURATION_SECONDS']);

    // Limits are configurable: 3 hours is fine when the app raises the limit.
    expect(checkVideoRequestLimits({ ...request, durationSeconds: 3 * 3600 }, { ...DEFAULT_RESOURCE_LIMITS, maxDurationSeconds: 4 * 3600 })).toEqual([]);

    const big = VideoRequestSchema.parse({ ...request, aspectRatio: '9:16', resolution: '2160p', fps: 120 });
    // 9:16 at 2160p is 2160 × 3840: exactly at the default height limit, above a lowered one.
    expect(checkVideoRequestLimits(big, DEFAULT_RESOURCE_LIMITS).map((v) => v.code)).toEqual(['MAX_FPS']);
    const codes = checkVideoRequestLimits(big, { ...DEFAULT_RESOURCE_LIMITS, maxHeight: 3000 }).map((v) => v.code);
    expect(codes).toEqual(['MAX_HEIGHT', 'MAX_FPS']);
  });

  it('checkVideoRequestLimits reports prompt length, reference count and dimensions', () => {
    const request = buildVideoRequest();
    const limits = { ...DEFAULT_RESOURCE_LIMITS, maxPromptChars: 10, maxAssets: 1, maxWidth: 1000 };
    const violations = checkVideoRequestLimits({ ...request, referenceAssetIds: ['r1', 'r2'] }, limits);
    const codes = violations.map((v) => v.code);
    expect(codes).toContain('MAX_PROMPT_CHARS');
    expect(codes).toContain('MAX_ASSETS');
    expect(codes).toContain('MAX_WIDTH');

    const custom = { ...request, aspectRatio: 'custom' as const, customWidth: 4000, customHeight: 400 };
    expect(checkVideoRequestLimits(custom, DEFAULT_RESOURCE_LIMITS).map((v) => v.code)).toEqual(['MAX_WIDTH']);

    const missingDims = { ...request, aspectRatio: 'custom' as const };
    expect(checkVideoRequestLimits(missingDims, DEFAULT_RESOURCE_LIMITS).map((v) => v.code)).toEqual(['INVALID_DIMENSIONS']);
  });
});
