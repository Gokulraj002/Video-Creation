import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CameraPresetSchema,
  JsonObjectSchema,
  TEMPLATE_CATALOG,
  TEMPLATE_IDS,
  TemplateSummarySchema,
  VideoGenreSchema,
  getTemplate,
  isCatalogTemplateId,
  listTemplates,
  llmSchemaIssues,
  templateCatalogSummary,
  validateTemplateProps,
  type AnyTemplateDefinition,
  type TemplatePropsContext,
} from '../src/index';
import { SAMPLE_CONTEXT } from './fixtures';
import { jsonSchemaIssues, toJsonSchema } from './helpers';

const EXPECTED_MOTION2D = [
  'title-card',
  'kinetic-text',
  'bullet-list',
  'quote',
  'stat-counter',
  'step-instruction',
  'split-feature',
  'cta-end-card',
  'cartoon-scene',
  'property-showcase',
  'lower-third',
];
const EXPECTED_THREE = ['product-turntable', 'logo-reveal-3d', 'floating-shapes'];

const CONTEXTS: Record<string, TemplatePropsContext> = {
  sample: SAMPLE_CONTEXT,
  empty: { title: '', text: null, bullets: [], palette: [], brandName: null },
  whitespace: { title: '   ', text: '  \n ', bullets: ['  ', ''], palette: ['nope', '#12'], brandName: '  ' },
  long: {
    title: 'An extraordinarily long title '.repeat(20),
    text: 'Sentence number one is long. '.repeat(200),
    bullets: Array.from({ length: 20 }, (_, i) => `Bullet ${i} `.repeat(40)),
    palette: ['#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#123456', '#654321', '#ABCDEF', '#FEDCBA'],
    brandName: 'Brand '.repeat(60),
  },
  numbers: {
    title: 'Revenue grew 1,250% in 2025',
    text: 'We served 3.14159 million customers for $499 each at 123 Main St.',
    bullets: ['3 beds', '2 baths', 'Caution: never skip the safety check', '$1,200,000'],
    palette: ['#0A0A0A', '#F5F5F5', '#E11D48'],
    brandName: 'Acme Realty',
  },
  unicode: {
    title: '🚀 Lanzamiento — día uno',
    text: '日本語のテキスト。Ünïcödé text! Emoji 🎉🎉',
    bullets: ['• Primero', '✓ Segundo'],
    palette: ['#11223344', '#AABBCCDD'],
    brandName: 'Ñandú',
  },
  phone: {
    title: 'Meet the new phone',
    text: 'A smartphone with a stunning display.',
    bullets: [],
    palette: ['#1E3A8A', '#F59E0B'],
    brandName: null,
  },
};

describe('template catalog', () => {
  it('contains exactly the M1 templates with the right engines', () => {
    expect(TEMPLATE_CATALOG.map((t) => t.id)).toEqual([...TEMPLATE_IDS]);
    expect(listTemplates({ engine: 'motion2d' }).map((t) => t.id)).toEqual(EXPECTED_MOTION2D);
    expect(listTemplates({ engine: 'three' }).map((t) => t.id)).toEqual(EXPECTED_THREE);
    expect(listTemplates()).toHaveLength(14);
    expect(new Set(TEMPLATE_CATALOG.map((t) => t.id)).size).toBe(14);
  });

  it('getTemplate / isCatalogTemplateId look up by id', () => {
    for (const id of TEMPLATE_IDS) {
      expect(getTemplate(id)?.id).toBe(id);
      expect(isCatalogTemplateId(id)).toBe(true);
    }
    expect(getTemplate('nope')).toBeUndefined();
    expect(isCatalogTemplateId('nope')).toBe(false);
  });

  it('listTemplates filters by genre and engine', () => {
    const realEstate = listTemplates({ genre: 'real-estate' }).map((t) => t.id);
    expect(realEstate).toContain('property-showcase');
    expect(realEstate).toContain('title-card');
    expect(listTemplates({ genre: 'comedy' }).map((t) => t.id)).toContain('cartoon-scene');
    expect(listTemplates({ genre: 'sop-training' }).map((t) => t.id)).toContain('step-instruction');
    const product3d = listTemplates({ engine: 'three', genre: 'product-3d' }).map((t) => t.id);
    expect(product3d).toContain('product-turntable');
    expect(product3d.every((id) => EXPECTED_THREE.includes(id))).toBe(true);
    expect(listTemplates({ engine: 'three', genre: 'sop-training' })).toEqual([]);
  });

  it('every genre has at least one motion2d template', () => {
    for (const genre of VideoGenreSchema.options) {
      expect(listTemplates({ engine: 'motion2d', genre }).length, genre).toBeGreaterThan(0);
    }
  });

  it('definitions are well-formed', () => {
    for (const t of TEMPLATE_CATALOG) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.genres.length).toBeGreaterThan(0);
      for (const g of t.genres) expect(VideoGenreSchema.safeParse(g).success).toBe(true);
      expect(t.minDurationSeconds).toBeGreaterThan(0);
      expect(['motion2d', 'three']).toContain(t.engine);
    }
  });

  it('templateCatalogSummary is serializable and has no Zod objects', () => {
    const summary = templateCatalogSummary();
    expect(summary).toHaveLength(14);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
    for (const entry of summary) {
      expect(Object.keys(entry).sort()).toEqual(['description', 'engine', 'genres', 'id', 'minDurationSeconds', 'name']);
      expect(TemplateSummarySchema.safeParse(entry).success).toBe(true);
    }
  });
});

describe('buildProps', () => {
  for (const template of TEMPLATE_CATALOG) {
    describe(template.id, () => {
      for (const [name, ctx] of Object.entries(CONTEXTS)) {
        it(`produces valid props for the "${name}" context`, () => {
          const props = template.buildProps(ctx);
          const result = template.propsSchema.safeParse(props);
          if (!result.success) throw new Error(JSON.stringify(result.error.issues));
          expect(validateTemplateProps(template.id, props).success).toBe(true);
          // Props are plain JSON (storable in a timeline).
          expect(JsonObjectSchema.safeParse(props).success).toBe(true);
          expect(JSON.parse(JSON.stringify(props))).toEqual(props);
        });
      }

      it('is deterministic', () => {
        for (const ctx of Object.values(CONTEXTS)) {
          expect(template.buildProps(ctx)).toEqual(template.buildProps(structuredClone(ctx)));
        }
      });
    });
  }

  it('derives content from the context', () => {
    const title = getTemplate('title-card')?.buildProps(SAMPLE_CONTEXT);
    expect(title).toMatchObject({ headline: 'Launch Day' });
    const bullets = getTemplate('bullet-list')?.buildProps(SAMPLE_CONTEXT);
    expect(bullets).toMatchObject({ bullets: SAMPLE_CONTEXT.bullets });
    const stat = getTemplate('stat-counter')?.buildProps(SAMPLE_CONTEXT);
    expect(stat).toMatchObject({ value: 42, suffix: '%' });
    const turntable = getTemplate('product-turntable')?.buildProps(CONTEXTS.phone ?? SAMPLE_CONTEXT);
    expect(turntable).toMatchObject({ primitive: 'phone' });
    const property = getTemplate('property-showcase')?.buildProps(CONTEXTS.numbers ?? SAMPLE_CONTEXT);
    expect(property).toMatchObject({ price: '$499' });
  });
});

describe('validateTemplateProps', () => {
  it('returns the parsed props on success', () => {
    const props = getTemplate('quote')?.buildProps(SAMPLE_CONTEXT);
    const result = validateTemplateProps('quote', props);
    expect(result).toEqual({ success: true, data: props });
  });

  it('fails for unknown templates', () => {
    const result = validateTemplateProps('does-not-exist', {});
    expect(result.success).toBe(false);
    if (!result.success) expect(result.issues[0]).toMatch(/Unknown template/);
  });

  it('reports precise issues for invalid props', () => {
    const result = validateTemplateProps('title-card', {
      headline: '',
      subheadline: null,
      align: 'right',
      background: { style: 'solid', colors: [] },
      accentColor: 'red',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const joined = result.issues.join('\n');
    expect(joined).toMatch(/^headline: /m);
    expect(joined).toMatch(/^align: /m);
    expect(joined).toMatch(/^background\.colors: /m);
    expect(joined).toMatch(/^accentColor: /m);
  });

  it('rejects missing nullable keys (all keys required)', () => {
    const props = { ...getTemplate('lower-third')?.buildProps(SAMPLE_CONTEXT) } as Record<string, unknown>;
    delete props.role;
    const result = validateTemplateProps('lower-third', props);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.issues.join('\n')).toMatch(/^role: /m);
  });

  it('enforces template-specific bounds', () => {
    const base = getTemplate('floating-shapes')?.buildProps(SAMPLE_CONTEXT);
    expect(validateTemplateProps('floating-shapes', { ...base, count: 2 }).success).toBe(false);
    expect(validateTemplateProps('floating-shapes', { ...base, count: 41 }).success).toBe(false);
    expect(validateTemplateProps('floating-shapes', { ...base, palette: ['#000000'] }).success).toBe(false);
    const step = getTemplate('step-instruction')?.buildProps(SAMPLE_CONTEXT);
    expect(validateTemplateProps('step-instruction', { ...step, stepNumber: 5, totalSteps: 3 }).success).toBe(false);
    const stat = getTemplate('stat-counter')?.buildProps(SAMPLE_CONTEXT);
    expect(validateTemplateProps('stat-counter', { ...stat, decimals: 4 }).success).toBe(false);
    const turntable = getTemplate('product-turntable')?.buildProps(SAMPLE_CONTEXT);
    expect(validateTemplateProps('product-turntable', { ...turntable, rotationTurns: 5 }).success).toBe(false);
    expect(validateTemplateProps('product-turntable', { ...turntable, metalness: 1.1 }).success).toBe(false);
    const logo = getTemplate('logo-reveal-3d')?.buildProps(SAMPLE_CONTEXT);
    expect(validateTemplateProps('logo-reveal-3d', { ...logo, depth: 0.01 }).success).toBe(false);
    const kinetic = getTemplate('kinetic-text')?.buildProps(SAMPLE_CONTEXT);
    expect(validateTemplateProps('kinetic-text', { ...kinetic, lines: [] }).success).toBe(false);
    expect(validateTemplateProps('kinetic-text', { ...kinetic, lines: Array(7).fill('x') }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// LLM safety
// ---------------------------------------------------------------------------------------------

const FORBIDDEN_TYPES = new Set([
  'optional',
  'default',
  'prefault',
  'catch',
  'record',
  'map',
  'set',
  'lazy',
  'any',
  'unknown',
  'custom',
  'transform',
  'pipe',
  'promise',
  'function',
  'tuple',
  'undefined',
  'void',
  'never',
  'date',
  'bigint',
  'symbol',
]);

/** Independent walker: no forbidden wrapper/collection types anywhere, closed objects. */
function forbiddenTypesIn(schema: z.core.$ZodType, path = '(root)'): string[] {
  const def = schema._zod.def;
  if (FORBIDDEN_TYPES.has(def.type)) return [`${path}: ${def.type}`];
  if (schema instanceof z.ZodObject) {
    const issues: string[] = [];
    const catchall = schema._zod.def.catchall;
    if (catchall && catchall._zod.def.type !== 'never') issues.push(`${path}: catchall`);
    for (const [key, child] of Object.entries(schema.shape)) issues.push(...forbiddenTypesIn(child, `${path}.${key}`));
    return issues;
  }
  if (schema instanceof z.ZodArray) return forbiddenTypesIn(schema.element, `${path}[]`);
  if (schema instanceof z.ZodNullable) return forbiddenTypesIn(schema.unwrap(), path);
  if (schema instanceof z.ZodUnion) {
    return schema.options.flatMap((o, i) => forbiddenTypesIn(o as z.core.$ZodType, `${path}|${i}`));
  }
  return [];
}

describe('propsSchema LLM safety', () => {
  for (const template of TEMPLATE_CATALOG) {
    it(`${template.id}: closed, all-required, no records/optionals/defaults/recursion`, () => {
      expect(template.propsSchema).toBeInstanceOf(z.ZodObject);
      expect(llmSchemaIssues(template.propsSchema)).toEqual([]);
      expect(forbiddenTypesIn(template.propsSchema)).toEqual([]);
      const json = toJsonSchema(template.propsSchema);
      expect(jsonSchemaIssues(json)).toEqual([]);
      expect(Object.keys(json.properties ?? {}).length).toBeGreaterThan(0);
    });
  }

  it('llmSchemaIssues flags unsafe constructs', () => {
    expect(llmSchemaIssues(z.object({ a: z.string().optional() }))).toHaveLength(1);
    expect(llmSchemaIssues(z.object({ a: z.string().default('x') }))).toHaveLength(1);
    expect(llmSchemaIssues(z.object({ a: z.record(z.string(), z.string()) }))).toHaveLength(1);
    expect(llmSchemaIssues(z.object({ a: z.array(z.object({ b: z.unknown() })) }))).toHaveLength(1);
    expect(llmSchemaIssues(z.object({ a: z.looseObject({ b: z.string() }) }))).toHaveLength(1);
    expect(llmSchemaIssues(z.object({ a: z.string().transform((s) => s.length) }))).toHaveLength(1);
    expect(llmSchemaIssues(z.object({ a: z.string().nullable(), b: z.enum(['x']), c: z.literal('y') }))).toEqual([]);
  });

  it('the director scene-spec union over the whole catalog is LLM-safe and JSON-Schema convertible', () => {
    const options = TEMPLATE_CATALOG.map((t: AnyTemplateDefinition) =>
      z.object({
        sceneId: z.string(),
        engine: z.literal(t.engine),
        template: z.literal(t.id),
        props: t.propsSchema,
        cameraPreset: CameraPresetSchema.nullable(),
      }),
    );
    const [first, ...rest] = options;
    if (!first) throw new Error('empty catalog');
    const union = z.discriminatedUnion('template', [first, ...rest]);
    const schema = z.object({ chapterId: z.string(), scenes: z.array(union) });
    expect(llmSchemaIssues(schema)).toEqual([]);
    expect(jsonSchemaIssues(toJsonSchema(schema))).toEqual([]);

    const titleProps = getTemplate('title-card')?.buildProps(SAMPLE_CONTEXT);
    const ok = schema.safeParse({
      chapterId: 'c1',
      scenes: [{ sceneId: 's1', engine: 'motion2d', template: 'title-card', props: titleProps, cameraPreset: null }],
    });
    expect(ok.success).toBe(true);
    const wrongProps = schema.safeParse({
      chapterId: 'c1',
      scenes: [{ sceneId: 's1', engine: 'motion2d', template: 'quote', props: titleProps, cameraPreset: null }],
    });
    expect(wrongProps.success).toBe(false);
  });
});
