import { z } from 'zod';

/** Identifier used for every entity in the timeline (scenes, chapters, assets, tracks, items, layers). */
export const IdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'Invalid id: 1-64 chars of [A-Za-z0-9_-], starting with a letter or digit');
export type Id = z.infer<typeof IdSchema>;

/**
 * Template identifier. Catalog membership is checked by the director, NOT by the timeline schema,
 * so future templates never break old timelines.
 */
export const TemplateIdSchema = IdSchema;
export type TemplateId = z.infer<typeof TemplateIdSchema>;

export const HexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'Invalid hex color: expected #RRGGBB or #RRGGBBAA');
export type HexColor = z.infer<typeof HexColorSchema>;

/** Absolute or relative frame index (int >= 0). */
export const FrameSchema = z.number().int().min(0);
export type Frame = z.infer<typeof FrameSchema>;

/** Duration in frames (int >= 1). */
export const DurationFramesSchema = z.number().int().min(1);
export type DurationFrames = z.infer<typeof DurationFramesSchema>;

export const EasingSchema = z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'spring']);
export type Easing = z.infer<typeof EasingSchema>;

/** Normalized coordinate / size in [0, 1]. */
export const NormalizedSchema = z.number().min(0).max(1);
export type Normalized = z.infer<typeof NormalizedSchema>;

export const FontFamilySchema = z
  .string()
  .regex(/^[A-Za-z0-9 \-]{1,64}$/, 'Invalid font family: 1-64 chars of letters, digits, spaces and hyphens');
export type FontFamily = z.infer<typeof FontFamilySchema>;

/** BCP-47-ish language tag, e.g. `en`, `en-US`, `pt-BR`, `zh-Hant`. */
export const LanguageTagSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Invalid language tag (BCP-47), e.g. "en" or "en-US"');
export type LanguageTag = z.infer<typeof LanguageTagSchema>;

/** ISO-8601 date-time string (UTC `Z` or explicit offset). */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

// ---------------------------------------------------------------------------------------------
// JSON values
// ---------------------------------------------------------------------------------------------

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const JSON_LIMITS = {
  maxStringLength: 10_000,
  maxArrayLength: 500,
  maxObjectKeys: 200,
  /** Maximum number of nested containers (arrays/objects). */
  maxDepth: 8,
} as const;

function tooManyKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > JSON_LIMITS.maxObjectKeys;
}

function jsonPrimitiveOptions() {
  return [z.string().max(JSON_LIMITS.maxStringLength), z.number(), z.boolean(), z.null()] as const;
}

/**
 * Builds the JSON value schema for a value enclosed by `depth` containers.
 * Containers are only allowed while `depth < maxDepth`, so at most `maxDepth` containers nest.
 * Non-recursive (each level references the next), so it also converts to JSON Schema.
 */
function jsonValueAtDepth(depth: number): z.ZodType<JsonValue> {
  if (depth >= JSON_LIMITS.maxDepth) {
    return z.union(jsonPrimitiveOptions());
  }
  const child = jsonValueAtDepth(depth + 1);
  return z.union([
    ...jsonPrimitiveOptions(),
    z.array(child).max(JSON_LIMITS.maxArrayLength),
    z
      .record(z.string(), child)
      .refine((v) => !tooManyKeys(v), { message: `JSON objects may have at most ${JSON_LIMITS.maxObjectKeys} keys` }),
  ]);
}

/**
 * Recursive JSON value: strings <= 10 000 chars, finite numbers, booleans, null, arrays <= 500 items,
 * objects <= 200 keys, at most 8 nested containers. Never sent to the LLM.
 */
export const JsonValueSchema: z.ZodType<JsonValue> = jsonValueAtDepth(0);

/** Object whose values are JSON values (template props). The object itself counts as one level. */
export const JsonObjectSchema: z.ZodType<JsonObject> = z
  .record(z.string(), jsonValueAtDepth(1))
  .refine((v) => !tooManyKeys(v), { message: `JSON objects may have at most ${JSON_LIMITS.maxObjectKeys} keys` });

// ---------------------------------------------------------------------------------------------
// Safe URIs
// ---------------------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;
const ALLOWED_PROTOCOLS = new Set(['asset:', 'https:']);

/**
 * URI safe to hand to renderers: `asset://<assetId>` (internal storage reference) or `https://...`.
 * Rejects other protocols (`http:`, `file:`, `data:`, `javascript:` ...), credentials, control characters
 * and whitespace.
 */
export const SafeUriSchema = z
  .string()
  .min(1)
  .max(2048)
  .superRefine((value, ctx) => {
    if (CONTROL_CHARS.test(value) || /\s/.test(value)) {
      ctx.addIssue({ code: 'custom', message: 'URI must not contain control characters or whitespace' });
      return;
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'URI must be an absolute URL' });
      return;
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      ctx.addIssue({ code: 'custom', message: `URI protocol "${url.protocol}" is not allowed (use asset: or https:)` });
      return;
    }
    if (url.username !== '' || url.password !== '') {
      ctx.addIssue({ code: 'custom', message: 'URI must not contain credentials' });
      return;
    }
    if (url.host === '') {
      ctx.addIssue({ code: 'custom', message: 'URI must have a host (asset://<assetId> or https://host/...)' });
    }
  });
export type SafeUri = z.infer<typeof SafeUriSchema>;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Formats Zod issues as `path: message` strings (path `(root)` for top-level issues). */
export function formatZodIssues(error: z.ZodError, maxIssues = 50): string[] {
  return error.issues.slice(0, maxIssues).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map((p) => String(p)).join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}
