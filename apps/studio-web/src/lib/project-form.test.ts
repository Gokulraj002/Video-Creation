import { DEFAULT_RESOURCE_LIMITS, VideoRequestSchema } from '@vc/schema';
import { describe, expect, it } from 'vitest';
import {
  SCHEMA_PROMPT_MAX,
  apiErrorDetailsToFieldErrors,
  aspectRatioMismatch,
  formToVideoRequestInput,
  issuePathToErrorKey,
  normalizeBrandColors,
  parseProjectForm,
  promptLengthError,
  promptMaxChars,
  summarizeFieldErrors,
  titleLengthError,
} from './project-form';

function makeForm(fields: Record<string, string | string[]>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) form.append(key, v);
  }
  return form;
}

const BASE = {
  title: '  Aurora launch  ',
  prompt: 'A 30 second launch film for a smart lamp.',
  genre: 'promo',
  durationValue: '30',
  durationUnit: 's',
  aspectRatio: '16:9',
  resolution: '1080p',
  fps: '30',
  language: 'en',
  voiceOverEnabled: 'on',
  musicEnabled: '',
};

describe('formToVideoRequestInput', () => {
  it('maps a minimal form onto a valid VideoRequest', () => {
    const { input, preErrors } = formToVideoRequestInput(makeForm(BASE));
    expect(preErrors).toEqual({});
    const parsed = VideoRequestSchema.parse(input);
    expect(parsed).toMatchObject({
      title: 'Aurora launch',
      genre: 'promo',
      durationSeconds: 30,
      aspectRatio: '16:9',
      resolution: '1080p',
      fps: 30,
      language: 'en',
      voiceOver: { enabled: true },
      music: { enabled: false },
      referenceAssetIds: [],
    });
    expect(parsed.brand).toBeUndefined();
    expect(parsed.styleNotes).toBeUndefined();
    expect(parsed.customWidth).toBeUndefined();
  });

  it('converts minutes and hours to seconds without a hardcoded maximum', () => {
    expect(formToVideoRequestInput(makeForm({ ...BASE, durationValue: '25', durationUnit: 'min' })).input.durationSeconds).toBe(1500);
    expect(formToVideoRequestInput(makeForm({ ...BASE, durationValue: '2', durationUnit: 'h' })).input.durationSeconds).toBe(7200);
    expect(formToVideoRequestInput(makeForm({ ...BASE, durationValue: '10', durationUnit: 'h' })).input.durationSeconds).toBe(36_000);
  });

  it('includes custom dimensions only for custom aspect ratio / resolution', () => {
    const custom = formToVideoRequestInput(
      makeForm({ ...BASE, aspectRatio: 'custom', customWidth: '1200', customHeight: '628' }),
    ).input;
    expect(custom.customWidth).toBe(1200);
    expect(custom.customHeight).toBe(628);
    const preset = formToVideoRequestInput(makeForm({ ...BASE, customWidth: '1200', customHeight: '628' })).input;
    expect(preset.customWidth).toBeUndefined();
  });

  it('builds the brand from name + colors and the audio settings', () => {
    const { input } = formToVideoRequestInput(
      makeForm({
        ...BASE,
        brandName: 'Aurora',
        brandColor: ['#FF0000', '#00ff00', 'not-a-color', '#ff0000'],
        voiceOverStyle: 'warm',
        voiceOverGender: 'female',
        musicEnabled: 'on',
        musicMood: 'uplifting',
        styleNotes: 'clean, minimal',
      }),
    );
    const parsed = VideoRequestSchema.parse(input);
    expect(parsed.brand).toEqual({ name: 'Aurora', colors: ['#ff0000', '#00ff00'] });
    expect(parsed.voiceOver).toEqual({ enabled: true, style: 'warm', gender: 'female' });
    expect(parsed.music).toEqual({ enabled: true, mood: 'uplifting' });
    expect(parsed.styleNotes).toBe('clean, minimal');
  });

  it('drops voice details when voice-over is disabled and maps "any" gender to undefined', () => {
    const off = formToVideoRequestInput(makeForm({ ...BASE, voiceOverEnabled: '', voiceOverStyle: 'warm' })).input;
    expect(off.voiceOver).toEqual({ enabled: false });
    const any = formToVideoRequestInput(makeForm({ ...BASE, voiceOverGender: 'any' })).input;
    expect(any.voiceOver).toEqual({ enabled: true });
  });

  it('defaults fps to 30 and language to en when empty', () => {
    const { input } = formToVideoRequestInput(makeForm({ ...BASE, fps: '', language: '' }));
    expect(input.fps).toBe(30);
    expect(input.language).toBe('en');
  });

  it('reports unparsable durations as pre-errors', () => {
    const { preErrors } = formToVideoRequestInput(makeForm({ ...BASE, durationValue: 'abc' }));
    expect(preErrors.duration).toBeDefined();
  });
});

describe('normalizeBrandColors', () => {
  it('keeps valid unique hex colors, at most five', () => {
    expect(normalizeBrandColors(['#AABBCC', '#aabbcc', '#123', '#11223344', '#000000', '#111111', '#222222', '#333333'])).toEqual([
      '#aabbcc',
      '#11223344',
      '#000000',
      '#111111',
      '#222222',
    ]);
  });
});

describe('parseProjectForm', () => {
  it('returns a typed request on success', () => {
    const result = parseProjectForm(makeForm(BASE), DEFAULT_RESOURCE_LIMITS);
    expect(result.success).toBe(true);
    if (result.success) expect(result.request.durationSeconds).toBe(30);
  });

  it('maps schema issues onto form fields', () => {
    const result = parseProjectForm(makeForm({ ...BASE, title: '', prompt: '', language: 'English!', fps: '0' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(Object.keys(result.fieldErrors).sort()).toEqual(['fps', 'language', 'prompt', 'title']);
      expect(result.formError).toBeTruthy();
    }
  });

  it('requires even custom dimensions', () => {
    const result = parseProjectForm(makeForm({ ...BASE, resolution: 'custom', customWidth: '1001', customHeight: '' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.fieldErrors.customWidth).toBeDefined();
      expect(result.fieldErrors.customHeight).toBeDefined();
    }
  });

  it('applies configured limits when provided', () => {
    const limits = { ...DEFAULT_RESOURCE_LIMITS, maxDurationSeconds: 600, maxFps: 30 };
    const result = parseProjectForm(makeForm({ ...BASE, durationValue: '20', durationUnit: 'min', fps: '60' }), limits);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.fieldErrors.duration).toMatch(/limit of 600/);
      expect(result.fieldErrors.fps).toMatch(/limit of 30/);
    }
    // Without limits the same request is valid (the API applies limits authoritatively).
    expect(parseProjectForm(makeForm({ ...BASE, durationValue: '20', durationUnit: 'min', fps: '60' })).success).toBe(true);
  });
});

describe('error mapping', () => {
  it('maps issue paths to form slots', () => {
    expect(issuePathToErrorKey(['durationSeconds'])).toBe('duration');
    expect(issuePathToErrorKey(['brand', 'colors', 2])).toBe('brandColors');
    expect(issuePathToErrorKey(['brand', 'name'])).toBe('brandName');
    expect(issuePathToErrorKey(['voiceOver', 'gender'])).toBe('voiceOverGender');
    expect(issuePathToErrorKey(['music', 'mood'])).toBe('musicMood');
    expect(issuePathToErrorKey(['referenceAssetIds', 0])).toBeNull();
  });

  it('maps API validation issues and limit violations', () => {
    expect(
      apiErrorDetailsToFieldErrors({
        issues: [{ path: ['title'], message: 'Too long' }],
        violations: [{ code: 'MAX_DURATION_SECONDS', message: 'Too long a video', limit: 7200, actual: 9000 }],
      }),
    ).toEqual({ title: 'Too long', duration: 'Too long a video' });
    expect(apiErrorDetailsToFieldErrors([{ path: ['fps'], message: 'bad fps' }])).toEqual({ fps: 'bad fps' });
    // studio-api sends dot-joined string paths: [{path: 'brand.colors.0', message, code}]
    expect(
      apiErrorDetailsToFieldErrors([
        { path: 'brand.colors.0', message: 'Invalid hex color', code: 'invalid_format' },
        { path: 'durationSeconds', message: 'Too small', code: 'too_small' },
      ]),
    ).toEqual({ brandColors: 'Invalid hex color', duration: 'Too small' });
    expect(apiErrorDetailsToFieldErrors('nope')).toEqual({});
    expect(apiErrorDetailsToFieldErrors(undefined)).toEqual({});
  });
});

describe('prompt limit', () => {
  it('uses the lower of the configured limit and the schema cap', () => {
    expect(SCHEMA_PROMPT_MAX).toBe(20_000);
    expect(promptMaxChars(null)).toBe(SCHEMA_PROMPT_MAX);
    expect(promptMaxChars({ maxPromptChars: 5000 })).toBe(5000);
    // A configured limit above the schema cap can never be reached: the schema rejects first.
    expect(promptMaxChars({ maxPromptChars: 50_000 })).toBe(SCHEMA_PROMPT_MAX);
  });

  it('distinguishes empty from too long', () => {
    expect(promptLengthError(0, 100)).toBe('Describe the video you want');
    expect(promptLengthError(150, 100)).toBe('The prompt is too long: 150 characters (limit 100)');
    expect(promptLengthError(100, 100)).toBeNull();
    expect(titleLengthError(0)).toBe('Give the project a title');
    expect(titleLengthError(201)).toMatch(/too long: 201 characters \(limit 200\)/);
  });

  it('reports the precise message for the effective limit', () => {
    const limits = { ...DEFAULT_RESOURCE_LIMITS, maxPromptChars: 50 };
    const tooLong = parseProjectForm(makeForm({ ...BASE, prompt: 'x'.repeat(60) }), limits);
    expect(tooLong.success).toBe(false);
    if (!tooLong.success) expect(tooLong.fieldErrors.prompt).toBe('The prompt is too long: 60 characters (limit 50)');

    const empty = parseProjectForm(makeForm({ ...BASE, prompt: '   ', title: '' }), limits);
    expect(empty.success).toBe(false);
    if (!empty.success) {
      expect(empty.fieldErrors.prompt).toBe('Describe the video you want');
      expect(empty.fieldErrors.title).toBe('Give the project a title');
    }

    const schemaCap = parseProjectForm(makeForm({ ...BASE, prompt: 'x'.repeat(20_001) }));
    expect(schemaCap.success).toBe(false);
    if (!schemaCap.success) expect(schemaCap.fieldErrors.prompt).toBe('The prompt is too long: 20,001 characters (limit 20,000)');
  });
});

describe('custom dimensions vs aspect ratio', () => {
  it('accepts dimensions that match the preset ratio within ±1 px per side (same rule as the schema)', () => {
    expect(aspectRatioMismatch('16:9', 1920, 1080)).toBeNull();
    expect(aspectRatioMismatch('9:16', 1080, 1920)).toBeNull();
    expect(aspectRatioMismatch('4:5', 1080, 1350)).toBeNull();
    expect(aspectRatioMismatch('1:1', 512, 512)).toBeNull();
    // 1000 × 9/16 = 562.5 → both even neighbours 562 and 564 are within rounding.
    expect(aspectRatioMismatch('16:9', 1000, 562)).toBeNull();
    expect(aspectRatioMismatch('16:9', 1000, 564)).toBeNull();
    expect(aspectRatioMismatch('16:9', 1000, 566)).not.toBeNull();
    expect(aspectRatioMismatch('custom', 1000, 1000)).toBeNull();
  });

  it('rejects mismatching dimensions with a suggestion', () => {
    const mismatch = aspectRatioMismatch('16:9', 1000, 1000);
    expect(mismatch?.expectedHeight).toBe(562);
    expect(mismatch?.message).toMatch(/1000 × 1000 is not 16:9\. Use 1000 × 562/);
    expect(mismatch?.message).toMatch(/Custom W × H/);
  });

  it('enforces the rule when the resolution is custom and the aspect ratio is a preset', () => {
    const bad = parseProjectForm(makeForm({ ...BASE, resolution: 'custom', customWidth: '1000', customHeight: '1000' }));
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.fieldErrors.customWidth).toMatch(/not 16:9/);
    // Reported together with unrelated errors (the schema refinement alone would only run once the rest is valid).
    const both = parseProjectForm(makeForm({ ...BASE, title: '', resolution: 'custom', customWidth: '1000', customHeight: '1000' }));
    expect(both.success).toBe(false);
    if (!both.success) expect(Object.keys(both.fieldErrors).sort()).toEqual(['customWidth', 'title']);

    expect(
      parseProjectForm(makeForm({ ...BASE, resolution: 'custom', customWidth: '1280', customHeight: '720' })).success,
    ).toBe(true);
    // A custom aspect ratio accepts any valid W × H, and the (ignored) preset resolution is normalized to custom.
    const custom = parseProjectForm(makeForm({ ...BASE, aspectRatio: 'custom', resolution: '1080p', customWidth: '1000', customHeight: '1000' }));
    expect(custom.success).toBe(true);
    if (custom.success) expect(custom.request.resolution).toBe('custom');
  });
});

describe('summarizeFieldErrors', () => {
  it('lists invalid fields in on-screen order', () => {
    expect(summarizeFieldErrors({})).toBeNull();
    expect(summarizeFieldErrors({ fps: 'x' })).toBe('1 field needs attention: Frame rate.');
    expect(summarizeFieldErrors({ fps: 'x', title: 'y', prompt: 'z' })).toBe('3 fields need attention: Title, Prompt, Frame rate.');
  });
});
