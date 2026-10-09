import {
  ASPECT_RATIO_VALUES,
  AspectRatioSchema,
  HexColorSchema,
  LimitViolationSchema,
  VideoRequestSchema,
  checkVideoRequestLimits,
  type AspectRatio,
  type LimitViolation,
  type ResourceLimits,
  type VideoRequest,
} from '@vc/schema';
import { z } from 'zod';
import { parseDurationInput } from './duration';
import { formatNumber } from './format';

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

/** Field labels in on-screen (DOM) order — used for the single error summary announced on submit. */
export const FORM_ERROR_LABELS: readonly (readonly [FormErrorKey, string])[] = [
  ['title', 'Title'],
  ['prompt', 'Prompt'],
  ['genre', 'Genre'],
  ['language', 'Language'],
  ['styleNotes', 'Style notes'],
  ['brandName', 'Brand name'],
  ['brandColors', 'Brand colors'],
  ['duration', 'Duration'],
  ['aspectRatio', 'Aspect ratio'],
  ['resolution', 'Resolution'],
  ['customWidth', 'Width'],
  ['customHeight', 'Height'],
  ['fps', 'Frame rate'],
  ['voiceOverStyle', 'Voice style'],
  ['voiceOverGender', 'Voice'],
  ['musicMood', 'Music mood'],
];

/** One-sentence summary of the invalid fields, e.g. `2 fields need attention: Title, Prompt.` (null when none). */
export function summarizeFieldErrors(errors: FieldErrors): string | null {
  const labels = FORM_ERROR_LABELS.filter(([key]) => errors[key] !== undefined).map(([, label]) => label);
  if (labels.length === 0) return null;
  return `${labels.length} field${labels.length === 1 ? ' needs' : 's need'} attention: ${labels.join(', ')}.`;
}

/** Anything with FormData's read API (FormData itself, or a test double). */
export interface FormLike {
  get(name: string): FormDataEntryValue | null;
  getAll(name: string): FormDataEntryValue[];
}

export const MAX_BRAND_COLORS = 5;

/** Hard caps baked into `VideoRequestSchema` (the API's configured limits may be lower, never higher). */
export const SCHEMA_TITLE_MAX = VideoRequestSchema.shape.title.maxLength ?? 200;
export const SCHEMA_PROMPT_MAX = VideoRequestSchema.shape.prompt.maxLength ?? 20_000;

/**
 * Effective prompt maximum: the configured `maxPromptChars` capped by the schema maximum (whichever is lower).
 * Without limits (API offline) the schema cap applies.
 */
export function promptMaxChars(limits: Pick<ResourceLimits, 'maxPromptChars'> | null | undefined): number {
  const configured = limits?.maxPromptChars;
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? Math.min(Math.trunc(configured), SCHEMA_PROMPT_MAX)
    : SCHEMA_PROMPT_MAX;
}

/** Precise prompt message: empty vs. too long (with the actual length and the effective limit). */
export function promptLengthError(length: number, max: number): string | null {
  if (length <= 0) return 'Describe the video you want';
  if (length > max) {
    return `The prompt is too long: ${formatNumber(length)} characters (limit ${formatNumber(max)})`;
  }
  return null;
}

/** Precise title message: empty vs. too long. */
export function titleLengthError(length: number, max: number = SCHEMA_TITLE_MAX): string | null {
  if (length <= 0) return 'Give the project a title';
  if (length > max) return `The title is too long: ${formatNumber(length)} characters (limit ${formatNumber(max)})`;
  return null;
}

/**
 * Custom W × H vs. a preset aspect ratio — client-side mirror of the `VideoRequestSchema` refinement
 * (`dimensionsMatchAspectRatio` in @vc/schema): with `resolution: 'custom'` and a preset `aspectRatio`, the custom
 * size must match that ratio up to rounding, i.e. some exact-ratio size (t·w, t·h) lies within ±1 px of each side.
 * Otherwise the user must pick `aspectRatio: 'custom'` for a free size.
 * Returns `null` when the size matches (or the rule does not apply), otherwise a suggested height + message.
 */
export function aspectRatioMismatch(
  aspectRatio: AspectRatio,
  width: number,
  height: number,
): { expectedHeight: number; message: string } | null {
  if (aspectRatio === 'custom') return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const { w, h } = ASPECT_RATIO_VALUES[aspectRatio];
  const low = Math.max((width - 1) / w, (height - 1) / h);
  const high = Math.min((width + 1) / w, (height + 1) / h);
  if (low <= high) return null;
  const expectedHeight = Math.max(2, Math.round((width * h) / w / 2) * 2);
  return {
    expectedHeight,
    message: `${width} × ${height} is not ${aspectRatio}. Use ${width} × ${expectedHeight}, or set the aspect ratio to “Custom W × H” for a free size.`,
  };
}

/** Even integer in the schema's dimension range (only then is the ratio rule meaningful). */
function isValidDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value % 2 === 0 && value >= 16 && value <= 8192;
}

/** Applies `aspectRatioMismatch` to the raw request input (independently of other fields' validity). */
function ratioError(input: Record<string, unknown>): string | null {
  const aspectRatio = AspectRatioSchema.safeParse(input.aspectRatio);
  if (!aspectRatio.success || input.resolution !== 'custom') return null;
  const { customWidth, customHeight } = input;
  if (!isValidDimension(customWidth) || !isValidDimension(customHeight)) return null;
  return aspectRatioMismatch(aspectRatio.data, customWidth, customHeight)?.message ?? null;
}

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
  // A custom aspect ratio always uses the custom W × H, so a preset resolution would be ignored (and misleading
  // in the stored request): normalize it to `custom`.
  const resolution = aspectRatio === 'custom' ? 'custom' : text(form, FORM_FIELDS.resolution);
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
  genre: 'Pick a genre',
  aspectRatio: 'Pick an aspect ratio',
  resolution: 'Pick a resolution',
  language: 'Use a BCP-47 language tag such as "en" or "pt-BR"',
};

function stringLength(value: unknown): number {
  return typeof value === 'string' ? value.length : 0;
}

/** Display message for a schema issue on `key` (precise empty / too-long copy for title and prompt). */
function messageFor(key: FormErrorKey, input: Record<string, unknown>, issueMessage: string, promptMax: number): string {
  if (key === 'title') return titleLengthError(stringLength(input.title)) ?? issueMessage;
  if (key === 'prompt') return promptLengthError(stringLength(input.prompt), promptMax) ?? issueMessage;
  return FRIENDLY_MESSAGES[key] ?? issueMessage;
}

/** `formError` when every problem is attached to a field (the UI shows the field summary instead). */
export const GENERIC_FORM_ERROR = 'Please fix the highlighted fields.';

export type ParseProjectFormResult =
  | { success: true; request: VideoRequest }
  | { success: false; fieldErrors: FieldErrors; formError: string | null };

/**
 * Full form → `VideoRequest` pipeline: raw parsing, `VideoRequestSchema.safeParse`, the custom-dimensions vs.
 * aspect-ratio rule (mirrors the schema refinement), and (when limits are known) `checkVideoRequestLimits`.
 * Returns per-field messages suitable for display.
 */
export function parseProjectForm(form: FormLike, limits?: ResourceLimits | null): ParseProjectFormResult {
  const { input, preErrors } = formToVideoRequestInput(form);
  const fieldErrors: FieldErrors = { ...preErrors };
  const unplaced: string[] = [];
  const promptMax = promptMaxChars(limits);

  // Checked on the raw input so it shows together with other field errors (the schema refinement only runs once
  // the rest of the object is valid) and with UI wording instead of the API's.
  const mismatch = ratioError(input);
  if (mismatch) fieldErrors.customWidth = mismatch;

  const parsed = VideoRequestSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issuePathToErrorKey(issue.path);
      if (key === null) {
        unplaced.push(issue.message);
        continue;
      }
      if (fieldErrors[key] === undefined) {
        fieldErrors[key] = messageFor(key, input, issue.message, promptMax);
      }
    }
  }

  if (parsed.success && fieldErrors.prompt === undefined) {
    const promptError = promptLengthError(parsed.data.prompt.length, promptMax);
    if (promptError) fieldErrors.prompt = promptError;
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
    formError: unplaced.length > 0 ? unplaced.join(' · ') : GENERIC_FORM_ERROR,
  };
}

/** API validation issue: `path` is either an array of keys or a dot-joined string (`brand.colors.0`). */
const ApiIssueSchema = z.object({
  path: z.union([
    z.array(z.union([z.string(), z.number()])),
    z.string().transform((p) => (p === '' ? [] : p.split('.'))),
  ]),
  message: z.string(),
});

/**
 * Best-effort mapping of API error `details` (400 VALIDATION_ERROR issues or 422 LIMIT_EXCEEDED violations) onto
 * form fields. Accepts `[...]`, `{issues: [...]}` and `{violations: [...]}` shapes (issue paths as arrays or
 * dot-joined strings); unknown shapes map to nothing.
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
