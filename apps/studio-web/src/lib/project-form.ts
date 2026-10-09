import {
  HexColorSchema,
  LimitViolationSchema,
  VideoRequestSchema,
  checkVideoRequestLimits,
  type LimitViolation,
  type ResourceLimits,
  type VideoRequest,
} from '@vc/schema';
import { z } from 'zod';
import { parseDurationInput } from './duration';

/**
 * Pure mapping from the "New project" form to a `VideoRequest` (validated with `VideoRequestSchema`).
 * Used client-side for instant feedback and again inside the Server Action (the API re-validates too).
 */

/** Field names used by the form inputs (and as keys of `fieldErrors`). */
export const FORM_FIELDS = {
  title: 'title',
  prompt: 'prompt',
  genre: 'genre',
  styleNotes: 'styleNotes',
  durationValue: 'durationValue',
  durationUnit: 'durationUnit',
  aspectRatio: 'aspectRatio',
  resolution: 'resolution',
  customWidth: 'customWidth',
  customHeight: 'customHeight',
  fps: 'fps',
  language: 'language',
  brandName: 'brandName',
  brandColor: 'brandColor',
  voiceOverEnabled: 'voiceOverEnabled',
  voiceOverStyle: 'voiceOverStyle',
  voiceOverGender: 'voiceOverGender',
  musicEnabled: 'musicEnabled',
  musicMood: 'musicMood',
} as const;

export type FormFieldName = (typeof FORM_FIELDS)[keyof typeof FORM_FIELDS];

/** Logical error slots shown in the form (duration errors attach to the value input, brand colors to the group). */
export type FormErrorKey =
  | 'title'
  | 'prompt'
  | 'genre'
  | 'styleNotes'
  | 'duration'
  | 'aspectRatio'
  | 'resolution'
  | 'customWidth'
  | 'customHeight'
  | 'fps'
  | 'language'
  | 'brandName'
  | 'brandColors'
  | 'voiceOverStyle'
  | 'voiceOverGender'
  | 'musicMood';

export type FieldErrors = Partial<Record<FormErrorKey, string>>;

/** Anything with FormData's read API (FormData itself, or a test double). */
export interface FormLike {
  get(name: string): FormDataEntryValue | null;
  getAll(name: string): FormDataEntryValue[];
}

export const MAX_BRAND_COLORS = 5;

function text(form: FormLike, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optionalText(form: FormLike, name: string): string | undefined {
  const value = text(form, name);
  return value === '' ? undefined : value;
}

function checkbox(form: FormLike, name: string): boolean {
  const value = text(form, name).toLowerCase();
  return value === 'on' || value === 'true' || value === '1' || value === 'yes';
}

/** Integer parse that keeps invalid input visible to Zod (NaN fails `int()`), and maps empty to undefined. */
function optionalInt(form: FormLike, name: string): number | undefined {
  const value = text(form, name);
  if (value === '') return undefined;
  return /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
}

/** Normalizes brand colors: valid hex only, lower-cased, de-duplicated, at most `MAX_BRAND_COLORS`. */
export function normalizeBrandColors(values: readonly FormDataEntryValue[]): string[] {
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const color = raw.trim().toLowerCase();
    if (!HexColorSchema.safeParse(color).success || out.includes(color)) continue;
    out.push(color);
    if (out.length >= MAX_BRAND_COLORS) break;
  }
  return out;
}

export interface FormToRequestResult {
  /** Plain object handed to `VideoRequestSchema` (may be invalid). */
  input: Record<string, unknown>;
  /** Errors detected while reading raw inputs (e.g. an unparsable duration). */
  preErrors: FieldErrors;
}

/** Reads the raw form into a `VideoRequest`-shaped object (no validation beyond input parsing). */
export function formToVideoRequestInput(form: FormLike): FormToRequestResult {
  const preErrors: FieldErrors = {};

  const duration = parseDurationInput(text(form, FORM_FIELDS.durationValue), text(form, FORM_FIELDS.durationUnit) || 's');
  if (!duration.ok) preErrors.duration = duration.error;

  const aspectRatio = text(form, FORM_FIELDS.aspectRatio);
  const resolution = text(form, FORM_FIELDS.resolution);
  const isCustom = aspectRatio === 'custom' || resolution === 'custom';

  const fpsRaw = text(form, FORM_FIELDS.fps);
  const fps = fpsRaw === '' ? 30 : /^\d+$/.test(fpsRaw) ? Number(fpsRaw) : Number.NaN;

  const brandName = optionalText(form, FORM_FIELDS.brandName);
  const brandColors = normalizeBrandColors(form.getAll(FORM_FIELDS.brandColor));
  const voiceOverEnabled = checkbox(form, FORM_FIELDS.voiceOverEnabled);
  const musicEnabled = checkbox(form, FORM_FIELDS.musicEnabled);
  const gender = text(form, FORM_FIELDS.voiceOverGender);

  const input: Record<string, unknown> = {
    title: text(form, FORM_FIELDS.title),
    prompt: text(form, FORM_FIELDS.prompt),
    genre: text(form, FORM_FIELDS.genre),
    durationSeconds: duration.ok ? duration.seconds : Number.NaN,
    aspectRatio,
    resolution,
    fps,
    language: optionalText(form, FORM_FIELDS.language) ?? 'en',
    voiceOver: {
      enabled: voiceOverEnabled,
      ...(voiceOverEnabled && optionalText(form, FORM_FIELDS.voiceOverStyle)
        ? { style: optionalText(form, FORM_FIELDS.voiceOverStyle) }
        : {}),
      ...(voiceOverEnabled && gender !== '' && gender !== 'any' ? { gender } : {}),
    },
    music: {
      enabled: musicEnabled,
      ...(musicEnabled && optionalText(form, FORM_FIELDS.musicMood) ? { mood: optionalText(form, FORM_FIELDS.musicMood) } : {}),
    },
    referenceAssetIds: [],
  };

  const styleNotes = optionalText(form, FORM_FIELDS.styleNotes);
  if (styleNotes !== undefined) input.styleNotes = styleNotes;

  if (isCustom) {
    input.customWidth = optionalInt(form, FORM_FIELDS.customWidth);
    input.customHeight = optionalInt(form, FORM_FIELDS.customHeight);
  }

  if (brandName !== undefined || brandColors.length > 0) {
    input.brand = { ...(brandName !== undefined ? { name: brandName } : {}), colors: brandColors };
  }

  return { input, preErrors };
}

/** Maps a Zod issue path on `VideoRequest` to the form error slot that should display it. */
export function issuePathToErrorKey(path: readonly PropertyKey[]): FormErrorKey | null {
  const [head, second] = path;
  switch (head) {
    case 'title':
    case 'prompt':
    case 'genre':
    case 'styleNotes':
    case 'aspectRatio':
    case 'resolution':
    case 'customWidth':
    case 'customHeight':
    case 'fps':
    case 'language':
      return head;
    case 'durationSeconds':
      return 'duration';
    case 'brand':
      return second === 'name' ? 'brandName' : 'brandColors';
    case 'voiceOver':
      return second === 'gender' ? 'voiceOverGender' : 'voiceOverStyle';
    case 'music':
      return 'musicMood';
    default:
      return null;
  }
}

/** Maps a resource-limit violation to the form error slot that should display it. */
export function limitViolationToErrorKey(violation: LimitViolation): FormErrorKey | null {
  switch (violation.code) {
    case 'MAX_DURATION_SECONDS':
      return 'duration';
    case 'MAX_WIDTH':
    case 'MAX_HEIGHT':
    case 'INVALID_DIMENSIONS':
      return 'resolution';
    case 'MAX_FPS':
      return 'fps';
    case 'MAX_PROMPT_CHARS':
      return 'prompt';
    default:
      return null;
  }
}

const FRIENDLY_MESSAGES: Partial<Record<FormErrorKey, string>> = {
  title: 'Give the project a title (up to 200 characters)',
  prompt: 'Describe the video you want (up to 20,000 characters)',
  genre: 'Pick a genre',
  aspectRatio: 'Pick an aspect ratio',
  resolution: 'Pick a resolution',
  language: 'Use a BCP-47 language tag such as "en" or "pt-BR"',
};

export type ParseProjectFormResult =
  | { success: true; request: VideoRequest }
  | { success: false; fieldErrors: FieldErrors; formError: string | null };

/**
 * Full form → `VideoRequest` pipeline: raw parsing, `VideoRequestSchema.safeParse`, and (when limits are known)
 * `checkVideoRequestLimits`. Returns per-field messages suitable for display.
 */
export function parseProjectForm(form: FormLike, limits?: ResourceLimits | null): ParseProjectFormResult {
  const { input, preErrors } = formToVideoRequestInput(form);
  const fieldErrors: FieldErrors = { ...preErrors };
  const unplaced: string[] = [];

  const parsed = VideoRequestSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issuePathToErrorKey(issue.path);
      if (key === null) {
        unplaced.push(issue.message);
        continue;
      }
      if (fieldErrors[key] === undefined) {
        fieldErrors[key] = FRIENDLY_MESSAGES[key] ?? issue.message;
      }
    }
  }

  if (parsed.success && Object.keys(fieldErrors).length === 0 && limits) {
    for (const violation of checkVideoRequestLimits(parsed.data, limits)) {
      const key = limitViolationToErrorKey(violation);
      if (key === null) unplaced.push(violation.message);
      else if (fieldErrors[key] === undefined) fieldErrors[key] = violation.message;
    }
  }

  if (parsed.success && Object.keys(fieldErrors).length === 0 && unplaced.length === 0) {
    return { success: true, request: parsed.data };
  }
  return {
    success: false,
    fieldErrors,
    formError: unplaced.length > 0 ? unplaced.join(' · ') : 'Please fix the highlighted fields.',
  };
}

const ApiIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});

/**
 * Best-effort mapping of API error `details` (400 VALIDATION_ERROR issues or 422 LIMIT_EXCEEDED violations) onto
 * form fields. Accepts `[...]`, `{issues: [...]}` and `{violations: [...]}` shapes; unknown shapes map to nothing.
 */
export function apiErrorDetailsToFieldErrors(details: unknown): FieldErrors {
  const out: FieldErrors = {};
  const candidates: unknown[] = Array.isArray(details)
    ? details
    : details && typeof details === 'object'
      ? [
          ...(Array.isArray((details as { issues?: unknown }).issues) ? (details as { issues: unknown[] }).issues : []),
          ...(Array.isArray((details as { violations?: unknown }).violations)
            ? (details as { violations: unknown[] }).violations
            : []),
        ]
      : [];
  for (const candidate of candidates) {
    const issue = ApiIssueSchema.safeParse(candidate);
    if (issue.success) {
      const key = issuePathToErrorKey(issue.data.path);
      if (key && out[key] === undefined) out[key] = issue.data.message;
      continue;
    }
    const violation = LimitViolationSchema.safeParse(candidate);
    if (violation.success) {
      const key = limitViolationToErrorKey(violation.data);
      if (key && out[key] === undefined) out[key] = violation.data.message;
    }
  }
  return out;
}
