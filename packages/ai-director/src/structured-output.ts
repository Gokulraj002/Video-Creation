import { z } from 'zod';
import { isRecord } from './util/json';

/** String formats accepted by Claude structured outputs (others are dropped). */
export const SUPPORTED_STRING_FORMATS: ReadonlySet<string> = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

/**
 * Keywords structured outputs do not support. They are removed from the wire schema and summarized in the
 * node's `description` so the model still sees the intent (Zod re-validates everything client-side).
 */
const CONSTRAINT_KEYWORDS: ReadonlySet<string> = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'minContains',
  'maxContains',
]);

/** Keywords kept as-is (children sanitized where they hold schemas). */
const PASSTHROUGH_KEYWORDS: ReadonlySet<string> = new Set(['type', 'enum', 'const', 'required', 'description', 'title', 'default', '$ref']);

const MAX_HINT_PATTERN_LENGTH = 120;

export type JsonSchemaObject = Record<string, unknown>;

function constraintHint(key: string, value: unknown, node: Record<string, unknown>): string | null {
  if (typeof value === 'number' && Math.abs(value) >= Number.MAX_SAFE_INTEGER) return null;
  if (key === 'pattern') {
    // Formats already express the intent; huge generated patterns only add noise.
    if (typeof node.format === 'string' || typeof value !== 'string' || value.length > MAX_HINT_PATTERN_LENGTH) return null;
    return `pattern ${value}`;
  }
  return `${key} ${JSON.stringify(value)}`;
}

function sanitizeMap(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(value)) return out;
  for (const [k, v] of Object.entries(value)) out[k] = sanitizeJsonSchema(v);
  return out;
}

function sanitizeList(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map((v) => sanitizeJsonSchema(v)) : [];
}

function isObjectNode(node: Record<string, unknown>): boolean {
  const t = node.type;
  return t === 'object' || (Array.isArray(t) && t.includes('object')) || isRecord(node.properties);
}

/**
 * Recursively rewrites a JSON Schema into the subset accepted by Claude structured outputs:
 * strips `$schema` and unsupported keywords (numeric/string/array constraints, unknown keywords),
 * converts `oneOf` to `anyOf`, forces `additionalProperties: false` on every object and keeps `format`
 * only when it is a supported string format.
 */
export function sanitizeJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((n) => sanitizeJsonSchema(n));
  if (!isRecord(node)) return node;

  const out: Record<string, unknown> = {};
  const hints: string[] = [];
  const anyOf: unknown[] = [];
  const allOf: unknown[] = [];

  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema' || key === '$id' || key === 'additionalProperties') continue;
    if (CONSTRAINT_KEYWORDS.has(key)) {
      const hint = constraintHint(key, value, node);
      if (hint) hints.push(hint);
      continue;
    }
    switch (key) {
      case 'properties':
      case '$defs':
      case 'definitions':
        out[key] = sanitizeMap(value);
        break;
      case 'items':
        out.items = Array.isArray(value) ? { anyOf: sanitizeList(value) } : sanitizeJsonSchema(value);
        break;
      case 'prefixItems':
        // Tuples are not supported: degrade to an array of any of the positional schemas.
        if (out.items === undefined) out.items = { anyOf: sanitizeList(value) };
        break;
      case 'anyOf':
        anyOf.push(...sanitizeList(value));
        break;
      case 'oneOf':
        // `oneOf` is unsupported; `anyOf` is equivalent for the disjoint (discriminated) unions we emit.
        if (anyOf.length > 0) allOf.push({ anyOf: sanitizeList(value) });
        else anyOf.push(...sanitizeList(value));
        break;
      case 'allOf':
        allOf.push(...sanitizeList(value));
        break;
      case 'format':
        if (typeof value === 'string' && SUPPORTED_STRING_FORMATS.has(value)) out.format = value;
        break;
      default:
        if (PASSTHROUGH_KEYWORDS.has(key)) out[key] = value;
      // Any other keyword (not, if/then/else, propertyNames, patternProperties, contentEncoding, ...) is dropped.
    }
  }

  if (anyOf.length > 0) out.anyOf = anyOf;
  if (allOf.length > 0) out.allOf = allOf;
  if (isObjectNode(out)) {
    if (!isRecord(out.properties)) out.properties = {};
    out.additionalProperties = false;
  }
  if (hints.length > 0) {
    const prefix = typeof out.description === 'string' && out.description.length > 0 ? `${out.description} ` : '';
    out.description = `${prefix}(constraints: ${hints.join('; ')})`;
  }
  return out;
}

const SCHEMA_CACHE = new WeakMap<z.ZodType, JsonSchemaObject>();

/**
 * Zod schema → JSON Schema accepted by Claude structured outputs (`output_config.format.schema`).
 * Uses `z.toJSONSchema(schema, { io: 'output' })` then {@link sanitizeJsonSchema}. Memoized per schema instance.
 */
export function toStructuredOutputSchema(schema: z.ZodType): JsonSchemaObject {
  const cached = SCHEMA_CACHE.get(schema);
  if (cached) return cached;
  const raw: unknown = z.toJSONSchema(schema, { io: 'output' });
  const sanitized = sanitizeJsonSchema(raw);
  if (!isRecord(sanitized)) throw new TypeError('Structured output schema must be a JSON object');
  SCHEMA_CACHE.set(schema, sanitized);
  return sanitized;
}

/** Plain JSON Schema (constraints kept) for showing a schema to the model inside a prompt. */
export function toPromptJsonSchema(schema: z.ZodType): JsonSchemaObject {
  const raw: unknown = z.toJSONSchema(schema, { io: 'output' });
  if (!isRecord(raw)) throw new TypeError('JSON schema must be an object');
  const { $schema: _ignored, ...rest } = raw;
  void _ignored;
  return rest;
}
