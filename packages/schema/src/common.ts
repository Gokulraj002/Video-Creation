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
// Well-formed text (UTF-16)
// ---------------------------------------------------------------------------------------------

/** A high surrogate not followed by a low one, or a low surrogate not preceded by a high one (code-unit regex). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Issue message used for strings that contain lone surrogates. */
export const ILL_FORMED_TEXT_MESSAGE =
  'Text must be well-formed UTF-16 (it contains a lone surrogate, e.g. half of an emoji cut by truncation)';

/**
 * `true` when the string has no lone surrogates (same result as `String.prototype.isWellFormed`, implemented with a
 * regex so it also works on runtimes and TS `lib` targets without ES2024). PostgreSQL `jsonb` rejects lone surrogates.
 */
export function isWellFormedText(value: string): boolean {
  return !LONE_SURROGATE.test(value);
}

/** Replaces every lone surrogate with U+FFFD (same result as `String.prototype.toWellFormed`). */
export function toWellFormedText(value: string): string {
  return isWellFormedText(value) ? value : value.replace(LONE_SURROGATES, '\uFFFD');
}

/**
 * Walks a (structurally valid, acyclic) value and calls `report(path)` for every ill-formed string.
 * Object keys listed in `skipKeys` are not descended into (e.g. `props`, which `JsonObjectSchema` already checks).
 */
export function findIllFormedStrings(
  value: unknown,
  report: (path: (string | number)[]) => void,
  skipKeys: ReadonlySet<string> = new Set(),
): void {
  const stack: { value: unknown; path: (string | number)[] }[] = [{ value, path: [] }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const v = item.value;
    if (typeof v === 'string') {
      if (!isWellFormedText(v)) report(item.path);
    } else if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push({ value: v[i], path: [...item.path, i] });
    } else if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v);
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry && !skipKeys.has(entry[0])) stack.push({ value: entry[1], path: [...item.path, entry[0]] });
      }
    }
  }
}

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
  /** Maximum number of values in one JSON value: every container and primitive, the root included. */
  maxNodes: 10_000,
} as const;

/** Object keys rejected in JSON values (prototype-pollution vectors; `__proto__` would otherwise be silently dropped). */
export const RESERVED_JSON_KEYS: readonly string[] = Object.freeze(['__proto__', 'constructor', 'prototype']);
const RESERVED_JSON_KEY_SET: ReadonlySet<string> = new Set(RESERVED_JSON_KEYS);

function tooManyKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > JSON_LIMITS.maxObjectKeys;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Pre-pass run BEFORE the structural JSON validation: enforces the node budget (so oversized values are rejected in
 * O(maxNodes) without validating them), rejects reserved keys and ill-formed strings, each with a precise path.
 * Depth / length / key-count / type errors are left to the structural schema.
 */
function inspectJson(root: unknown, ctx: z.RefinementCtx): void {
  let nodes = 1;
  const tooLarge = () =>
    ctx.addIssue({
      code: 'custom',
      path: [],
      message: `JSON value is too large: more than ${JSON_LIMITS.maxNodes} nodes (arrays, objects and primitives, nested ones included)`,
    });
  const stack: { value: unknown; path: (string | number)[]; depth: number }[] = [{ value: root, path: [], depth: 0 }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { value, path, depth } = item;
    if (typeof value === 'string') {
      if (!isWellFormedText(value)) ctx.addIssue({ code: 'custom', path, message: ILL_FORMED_TEXT_MESSAGE });
      continue;
    }
    // Containers nested deeper than allowed are reported by the structural schema; do not descend further.
    if (depth >= JSON_LIMITS.maxDepth) continue;
    let children: { value: unknown; key: string | number }[];
    if (Array.isArray(value)) {
      if (nodes + value.length > JSON_LIMITS.maxNodes) {
        tooLarge();
        return;
      }
      children = value.map((v, i) => ({ value: v, key: i }));
    } else if (isPlainObject(value)) {
      children = [];
      for (const [key, v] of Object.entries(value)) {
        if (RESERVED_JSON_KEY_SET.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, key],
            message: `Key "${key}" is not allowed in JSON objects (reserved: ${RESERVED_JSON_KEYS.join(', ')})`,
          });
        } else {
          children.push({ value: v, key });
        }
      }
    } else {
      continue;
    }
    nodes += children.length;
    if (nodes > JSON_LIMITS.maxNodes) {
      tooLarge();
      return;
    }
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child) stack.push({ value: child.value, path: [...path, child.key], depth: depth + 1 });
    }
  }
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

/** Runs `inspectJson` first; the structural schema only runs when the pre-pass found no issue. */
function withJsonPrePass<T>(schema: z.ZodType<T>): z.ZodType<T> {
  return z.unknown().superRefine(inspectJson).pipe(schema);
}

/**
 * Recursive JSON value: strings <= 10 000 chars (well-formed UTF-16), finite numbers, booleans, null, arrays <= 500
 * items, objects <= 200 keys (no `__proto__` / `constructor` / `prototype` keys), at most 8 nested containers and at
 * most 10 000 nodes in total (`JSON_LIMITS`). Never sent to the LLM.
 */
export const JsonValueSchema: z.ZodType<JsonValue> = withJsonPrePass(jsonValueAtDepth(0));

/** Object whose values are JSON values (template props). The object itself counts as one level (and one node). */
export const JsonObjectSchema: z.ZodType<JsonObject> = withJsonPrePass(
  z
    .record(z.string(), jsonValueAtDepth(1))
    .refine((v) => !tooManyKeys(v), { message: `JSON objects may have at most ${JSON_LIMITS.maxObjectKeys} keys` }),
);

// ---------------------------------------------------------------------------------------------
// Safe URIs
// ---------------------------------------------------------------------------------------------

export const MAX_URI_LENGTH = 2048;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;
/** Unicode format characters: zero-width spaces/joiners, bidi overrides (e.g. U+202E), BOM, soft hyphen... */
const FORMAT_CHARS = /\p{Cf}/u;
/** Literal scheme + `//` prefix (scheme case-insensitive). Rejects `https:host`, `https:/host`, `https:\\host`. */
const URI_PREFIX = /^(https|asset):\/\//i;
/** Percent-encoded C0 controls and DEL (`%00`–`%1F`, `%7F`). */
const PERCENT_ENCODED_CONTROL = /%(?:[01][0-9a-f]|7f)/i;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** One `asset://` path segment: 1–255 chars of `[A-Za-z0-9._-]`, not starting with a dot. */
const ASSET_PATH_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,254}$/;
const DNS_LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const LOCAL_HOST_NAMES = new Set(['localhost']);
const LOCAL_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'] as const;

/** Decodes only `%2e` (dot), `%2f` (slash) and `%5c` (backslash) so encoded traversal is caught by the segment check. */
function decodeTraversalChars(path: string): string {
  return path.replace(/%2e/gi, '.').replace(/%2f/gi, '/').replace(/%5c/gi, '\\');
}

function hasDotSegment(path: string): boolean {
  return decodeTraversalChars(path)
    .split(/[/\\]/)
    .some((segment) => segment === '.' || segment === '..');
}

type UriCheck = { ok: true; url: URL } | { ok: false; message: string };

/** Every rule of `SafeUriSchema`; returns the parsed URL (whose `href` is the normalized output) or the first failure. */
function checkSafeUri(value: string): UriCheck {
  const fail = (message: string): UriCheck => ({ ok: false, message });
  if (CONTROL_CHARS.test(value) || /\s/.test(value) || FORMAT_CHARS.test(value)) {
    return fail('URI must not contain control characters, whitespace or invisible formatting characters');
  }
  if (value.includes('\\')) return fail('URI must not contain backslashes');
  if (value.includes('@')) return fail('URI must not contain "@" (credentials / user-info are not allowed)');
  const prefix = URI_PREFIX.exec(value);
  if (!prefix || prefix[1] === undefined) {
    return fail('URI must start with "https://" or "asset://" (other protocols and relative URIs are not allowed)');
  }
  if (PERCENT_ENCODED_CONTROL.test(value)) return fail('URI must not contain percent-encoded control characters');
  const scheme = prefix[1].toLowerCase();
  const rest = value.slice(prefix[0].length);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const afterAuthority = authorityEnd === -1 ? '' : rest.slice(authorityEnd);
  const queryStart = afterAuthority.search(/[?#]/);
  const rawPath = queryStart === -1 ? afterAuthority : afterAuthority.slice(0, queryStart);
  if (hasDotSegment(rawPath)) {
    return fail('URI path must not contain dot segments ("." or ".."), including percent-encoded ones');
  }
  if (scheme === 'asset') {
    if (!ID_PATTERN.test(authority)) {
      return fail('asset:// URIs must be asset://<assetId>[/<segment>...] where assetId is a valid id ([A-Za-z0-9_-], ≤ 64)');
    }
    if (queryStart !== -1) return fail('asset:// URIs must not have a query or fragment');
    const segments = rawPath === '' ? [] : rawPath.slice(1).split('/');
    if (!segments.every((segment) => ASSET_PATH_SEGMENT.test(segment))) {
      return fail('asset:// path segments must be 1-255 chars of [A-Za-z0-9._-], not starting with "."');
    }
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('URI must be an absolute URL');
  }
  if (url.protocol !== `${scheme}:`) return fail(`URI protocol "${url.protocol}" is not allowed (use asset: or https:)`);
  if (url.username !== '' || url.password !== '') return fail('URI must not contain credentials');
  if (url.host === '') return fail('URI must have a host (asset://<assetId> or https://host/...)');
  if (scheme === 'https') {
    const host = url.hostname;
    if (host.startsWith('[') || IPV4_HOST.test(host)) {
      return fail('https:// URIs must use a DNS host name, not an IP address literal');
    }
    const labels = host.split('.');
    if (host.length > 253 || labels.length < 2 || !labels.every((label) => DNS_LABEL.test(label))) {
      return fail('https:// URIs must use a fully-qualified DNS host name (e.g. cdn.example.com, no trailing dot)');
    }
    if (LOCAL_HOST_NAMES.has(host) || LOCAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      return fail(`https:// URIs must not point to local or internal host names ("${host}")`);
    }
  }
  if (hasDotSegment(url.pathname)) return fail('URI path must not contain dot segments ("." or "..")');
  if (url.href.length > MAX_URI_LENGTH) return fail(`Normalized URI must be at most ${MAX_URI_LENGTH} characters`);
  return { ok: true, url };
}

/**
 * URI safe to hand to renderers: `asset://<assetId>[/<segment>...]` (internal storage reference) or `https://<host>/...`.
 *
 * - The literal prefix `https://` or `asset://` is required (scheme case-insensitive); every other protocol,
 *   `https:host`, `https:/host` and relative URIs are rejected.
 * - Rejected anywhere: control characters, whitespace, Unicode format characters (`\p{Cf}`: zero-width, bidi
 *   overrides...), backslashes, `@` (credentials / user-info), percent-encoded controls, and dot segments
 *   (`.`, `..`, also percent-encoded as `%2e`, or hidden behind `%2f` / `%5c`).
 * - `asset://`: the host must be a valid `Id`, path segments are `[A-Za-z0-9._-]` (no leading dot), no query/fragment.
 * - `https://`: the host must be a fully-qualified DNS name; IP literals (IPv4 in any notation, IPv6) and local names
 *   (`localhost`, `*.localhost`, `*.local`, `*.internal`, `*.localdomain`, `*.home.arpa`) are rejected.
 * - Output is the normalized `URL.href` (lower-case scheme/host, punycode host, percent-encoded path).
 *
 * This is a SHAPE check only: it does not resolve DNS. A public host name can still resolve to a private / link-local /
 * metadata address, so every server-side fetcher (M2+ renderers, M3 ingest) MUST re-check the resolved IP at fetch time.
 */
let lastUriCheck: { value: string; result: UriCheck } | undefined;
/** `checkSafeUri` with a one-entry memo: the refinement and the normalizing overwrite see the same value. */
function checkSafeUriMemo(value: string): UriCheck {
  if (lastUriCheck?.value !== value) lastUriCheck = { value, result: checkSafeUri(value) };
  return lastUriCheck.result;
}

export const SafeUriSchema = z
  .string()
  .min(1)
  .max(MAX_URI_LENGTH)
  .superRefine((value, ctx) => {
    const result = checkSafeUriMemo(value);
    if (!result.ok) ctx.addIssue({ code: 'custom', message: result.message });
  })
  .overwrite((value) => {
    const result = checkSafeUriMemo(value);
    return result.ok ? result.url.href : value;
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
