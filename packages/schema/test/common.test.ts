import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AssetRefSchema,
  DurationFramesSchema,
  EasingSchema,
  FontFamilySchema,
  FrameSchema,
  HexColorSchema,
  IdSchema,
  JSON_LIMITS,
  JsonObjectSchema,
  JsonValueSchema,
  LanguageTagSchema,
  SafeUriSchema,
  TemplateIdSchema,
  formatZodIssues,
  type JsonValue,
} from '../src/index';

describe('IdSchema / TemplateIdSchema', () => {
  it.each(['a', 'A1', 'scene-1', 'c1_s2', '0abc', 'x'.repeat(64)])('accepts %s', (id) => {
    expect(IdSchema.safeParse(id).success).toBe(true);
    expect(TemplateIdSchema.safeParse(id).success).toBe(true);
  });
  it.each(['', '-a', '_a', 'a b', 'a/b', 'a.b', 'é', 'x'.repeat(65), 'a\n'])('rejects %j', (id) => {
    expect(IdSchema.safeParse(id).success).toBe(false);
  });
  it('TemplateIdSchema does not check catalog membership', () => {
    expect(TemplateIdSchema.safeParse('future-template-v9').success).toBe(true);
  });
});

describe('HexColorSchema', () => {
  it.each(['#000000', '#ffffff', '#A1B2C3', '#A1B2C3D4'])('accepts %s', (c) => {
    expect(HexColorSchema.safeParse(c).success).toBe(true);
  });
  it.each(['000000', '#fff', '#12345', '#1234567', '#GGGGGG', 'red', '#123456789'])('rejects %s', (c) => {
    expect(HexColorSchema.safeParse(c).success).toBe(false);
  });
});

describe('frame and easing primitives', () => {
  it('FrameSchema is an int >= 0, DurationFramesSchema an int >= 1', () => {
    expect(FrameSchema.safeParse(0).success).toBe(true);
    expect(FrameSchema.safeParse(-1).success).toBe(false);
    expect(FrameSchema.safeParse(1.5).success).toBe(false);
    expect(DurationFramesSchema.safeParse(1).success).toBe(true);
    expect(DurationFramesSchema.safeParse(0).success).toBe(false);
    expect(DurationFramesSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });
  it('EasingSchema options', () => {
    expect(EasingSchema.options).toEqual(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'spring']);
  });
});

describe('FontFamilySchema', () => {
  it.each(['Inter', 'Open Sans', 'Noto Sans-JP', 'A'])('accepts %s', (f) => {
    expect(FontFamilySchema.safeParse(f).success).toBe(true);
  });
  it.each(['', 'Inter;', "Inter'", 'url(x)', 'x'.repeat(65), 'Inter\n'])('rejects %j', (f) => {
    expect(FontFamilySchema.safeParse(f).success).toBe(false);
  });
});

describe('LanguageTagSchema', () => {
  it.each(['en', 'en-US', 'pt-BR', 'zh-Hant', 'yue'])('accepts %s', (l) => {
    expect(LanguageTagSchema.safeParse(l).success).toBe(true);
  });
  it.each(['EN', 'english', 'en_US', 'e', ''])('rejects %j', (l) => {
    expect(LanguageTagSchema.safeParse(l).success).toBe(false);
  });
});

describe('SafeUriSchema', () => {
  const accepted = [
    'asset://img-1',
    'asset://abc123/variant.png',
    'https://cdn.example.com/a.mp4',
    'https://example.com/path?query=1#frag',
    'https://example.com:8443/x',
    'HTTPS://EXAMPLE.COM/upper',
  ];
  const rejected: [string, string][] = [
    ['http', 'http://example.com/a.mp4'],
    ['file', 'file:///etc/passwd'],
    ['data', 'data:image/png;base64,AAAA'],
    ['javascript', 'javascript:alert(1)'],
    ['javascript upper', 'JavaScript:alert(1)'],
    ['ftp', 'ftp://example.com/a'],
    ['blob', 'blob:https://example.com/uuid'],
    ['username', 'https://user@example.com/a'],
    ['username+password', 'https://user:pass@example.com/a'],
    ['asset credentials', 'asset://user:pass@img-1'],
    ['relative', '/assets/a.png'],
    ['no scheme', 'example.com/a.png'],
    ['empty', ''],
    ['control char', 'https://example.com/\u0000a'],
    ['newline', 'https://example.com/a\nb'],
    ['tab', 'https://exa\tmple.com/'],
    ['DEL', 'https://example.com/\u007F'],
    ['C1 control', 'https://example.com/\u0085'],
    ['space', 'https://example.com/a b'],
    ['asset without host', 'asset:img-1'],
    ['too long', `https://example.com/${'a'.repeat(2048)}`],
  ];

  it.each(accepted)('accepts %s', (uri) => {
    expect(SafeUriSchema.safeParse(uri).success).toBe(true);
  });

  it.each(rejected)('rejects %s', (_name, uri) => {
    expect(SafeUriSchema.safeParse(uri).success).toBe(false);
  });

  it('accepts a URI of exactly 2048 characters', () => {
    const base = 'https://example.com/';
    const uri = base + 'a'.repeat(2048 - base.length);
    expect(uri).toHaveLength(2048);
    expect(SafeUriSchema.safeParse(uri).success).toBe(true);
  });

  it('is enforced on AssetRef.uri', () => {
    const asset = { id: 'a1', kind: 'image', uri: 'http://x.com/a.png', mimeType: 'image/png', source: 'upload' };
    expect(AssetRefSchema.safeParse(asset).success).toBe(false);
    expect(AssetRefSchema.safeParse({ ...asset, uri: 'asset://a1' }).success).toBe(true);
    expect(AssetRefSchema.safeParse({ ...asset, uri: 'asset://a1', mimeType: 'image png' }).success).toBe(false);
  });
});

function nestArrays(depth: number): JsonValue {
  let value: JsonValue = 1;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

function nestObjects(depth: number): JsonValue {
  let value: JsonValue = 'leaf';
  for (let i = 0; i < depth; i++) value = { k: value };
  return value;
}

describe('JsonValueSchema', () => {
  it('accepts primitives, arrays and objects', () => {
    for (const v of ['x', 0, -1.5, true, false, null, [], {}, [1, 'a', null, { b: [true] }], { a: { b: { c: 1 } } }]) {
      expect(JsonValueSchema.safeParse(v).success).toBe(true);
    }
  });

  it('rejects non-JSON values', () => {
    for (const v of [undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, () => 1, new Date(), 10n]) {
      expect(JsonValueSchema.safeParse(v).success, String(v)).toBe(false);
    }
    expect(JsonValueSchema.safeParse({ a: undefined }).success).toBe(false);
    expect(JsonValueSchema.safeParse([Number.NaN]).success).toBe(false);
  });

  it('bounds string length at 10 000 chars', () => {
    expect(JSON_LIMITS.maxStringLength).toBe(10_000);
    expect(JsonValueSchema.safeParse('a'.repeat(10_000)).success).toBe(true);
    expect(JsonValueSchema.safeParse('a'.repeat(10_001)).success).toBe(false);
    expect(JsonValueSchema.safeParse({ k: ['a'.repeat(10_001)] }).success).toBe(false);
  });

  it('bounds arrays at 500 items', () => {
    expect(JsonValueSchema.safeParse(new Array<number>(500).fill(1)).success).toBe(true);
    expect(JsonValueSchema.safeParse(new Array<number>(501).fill(1)).success).toBe(false);
  });

  it('bounds objects at 200 keys', () => {
    const make = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    expect(JsonValueSchema.safeParse(make(200)).success).toBe(true);
    expect(JsonValueSchema.safeParse(make(201)).success).toBe(false);
    expect(JsonValueSchema.safeParse([make(201)]).success).toBe(false);
  });

  it('bounds nesting at depth 8', () => {
    expect(JSON_LIMITS.maxDepth).toBe(8);
    expect(JsonValueSchema.safeParse(nestArrays(8)).success).toBe(true);
    expect(JsonValueSchema.safeParse(nestArrays(9)).success).toBe(false);
    expect(JsonValueSchema.safeParse(nestObjects(8)).success).toBe(true);
    expect(JsonValueSchema.safeParse(nestObjects(9)).success).toBe(false);
  });

  it('JsonObjectSchema (template props) counts itself as one level', () => {
    expect(JsonObjectSchema.safeParse({ a: 1, b: 'x', c: [1, 2], d: { e: null } }).success).toBe(true);
    expect(JsonObjectSchema.safeParse({ deep: nestObjects(7) }).success).toBe(true);
    expect(JsonObjectSchema.safeParse({ deep: nestObjects(8) }).success).toBe(false);
    expect(JsonObjectSchema.safeParse([1]).success).toBe(false);
    expect(JsonObjectSchema.safeParse('x').success).toBe(false);
    const tooMany = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, i]));
    expect(JsonObjectSchema.safeParse(tooMany).success).toBe(false);
  });

  it('converts to JSON Schema (non-recursive)', () => {
    expect(() => z.toJSONSchema(JsonValueSchema)).not.toThrow();
  });
});

describe('formatZodIssues', () => {
  it('formats paths and caps the issue count', () => {
    const schema = z.object({ a: z.string(), b: z.object({ c: z.number() }) });
    const result = schema.safeParse({ a: 1, b: { c: 'x' } });
    if (result.success) throw new Error('expected failure');
    const issues = formatZodIssues(result.error);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/^a: /);
    expect(issues[1]).toMatch(/^b\.c: /);
    expect(formatZodIssues(result.error, 1)).toHaveLength(1);
    const root = z.string().safeParse(1);
    if (root.success) throw new Error('expected failure');
    expect(formatZodIssues(root.error)[0]).toMatch(/^\(root\): /);
  });
});
