import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CreativeBriefSchema } from '@vc/schema';
import { ChapterSceneSpecsLlmSchema, sanitizeJsonSchema, toStructuredOutputSchema } from '../src';

const UNSUPPORTED = [
  '$schema',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'pattern',
  'oneOf',
  'propertyNames',
];

function walk(node: unknown, visit: (n: Record<string, unknown>, path: string) => void, path = '$'): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => walk(n, visit, `${path}[${i}]`));
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const rec = node as Record<string, unknown>;
  visit(rec, path);
  for (const [k, v] of Object.entries(rec)) walk(v, visit, `${path}.${k}`);
}

function isSchemaObjectNode(n: Record<string, unknown>): boolean {
  return n.type === 'object';
}

describe('toStructuredOutputSchema', () => {
  it('strips unsupported keywords and closes every object (brief)', () => {
    const schema = toStructuredOutputSchema(CreativeBriefSchema);
    const found: string[] = [];
    let objects = 0;
    walk(schema, (n, path) => {
      // Property maps are keyed by user field names; only inspect schema nodes.
      if (path.endsWith('.properties')) return;
      for (const key of UNSUPPORTED) if (key in n) found.push(`${path}.${key}`);
      if (isSchemaObjectNode(n)) {
        objects++;
        expect(n.additionalProperties, path).toBe(false);
        const props = Object.keys((n.properties ?? {}) as Record<string, unknown>);
        expect(new Set(n.required as string[]), path).toEqual(new Set(props));
      }
    });
    expect(found).toEqual([]);
    expect(objects).toBeGreaterThanOrEqual(2);
    // Constraints survive as human-readable hints.
    const logline = (schema.properties as Record<string, Record<string, unknown>>).logline;
    expect(String(logline?.description)).toContain('maxLength 300');
  });

  it('converts oneOf (discriminated unions) to anyOf and closes every variant', () => {
    const schema = toStructuredOutputSchema(ChapterSceneSpecsLlmSchema);
    const text = JSON.stringify(schema);
    expect(text).not.toContain('"oneOf"');
    expect(text).toContain('"anyOf"');
    walk(schema, (n, path) => {
      if (path.endsWith('.properties')) return;
      if (isSchemaObjectNode(n)) expect(n.additionalProperties, path).toBe(false);
      expect('maxLength' in n || 'minimum' in n || 'maximum' in n || 'pattern' in n, path).toBe(false);
    });
  });

  it('keeps only supported string formats', () => {
    const schema = toStructuredOutputSchema(z.object({ a: z.email(), b: z.cuid(), c: z.iso.datetime(), d: z.uuid() }));
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.a?.format).toBe('email');
    expect(props.b?.format).toBeUndefined();
    expect(props.c?.format).toBe('date-time');
    expect(props.d?.format).toBe('uuid');
    expect(JSON.stringify(schema)).not.toContain('"pattern"');
  });

  it('is memoized per schema instance', () => {
    expect(toStructuredOutputSchema(CreativeBriefSchema)).toBe(toStructuredOutputSchema(CreativeBriefSchema));
  });
});

describe('sanitizeJsonSchema', () => {
  it('forces additionalProperties false, drops unknown keywords and rewrites oneOf', () => {
    const out = sanitizeJsonSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: true,
      properties: {
        n: { type: 'integer', minimum: 1, maximum: 9007199254740991 },
        tags: { type: 'array', items: { type: 'string', maxLength: 5 }, minItems: 1, uniqueItems: true },
        choice: {
          oneOf: [
            { type: 'object', properties: { k: { const: 'a' } }, required: ['k'] },
            { type: 'object', properties: { k: { const: 'b' } }, required: ['k'], additionalProperties: { type: 'string' } },
          ],
        },
        neg: { not: { type: 'null' }, type: 'string', format: 'regex' },
      },
      required: ['n', 'tags', 'choice', 'neg'],
    }) as Record<string, unknown>;
    expect(out.$schema).toBeUndefined();
    expect(out.additionalProperties).toBe(false);
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.n).toEqual({ type: 'integer', description: '(constraints: minimum 1)' });
    expect(props.tags?.minItems).toBeUndefined();
    expect(props.tags?.uniqueItems).toBeUndefined();
    expect((props.tags?.items as Record<string, unknown>).maxLength).toBeUndefined();
    const variants = props.choice?.anyOf as Record<string, unknown>[];
    expect(variants).toHaveLength(2);
    for (const v of variants) expect(v.additionalProperties).toBe(false);
    expect(props.choice?.oneOf).toBeUndefined();
    expect(props.neg?.not).toBeUndefined();
    expect(props.neg?.format).toBeUndefined();
  });
});
