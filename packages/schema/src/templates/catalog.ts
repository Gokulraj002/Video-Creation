import { z } from 'zod';
import type { AssetKind } from '../assets';
import { formatZodIssues, JsonObjectSchema, type JsonObject } from '../common';
import { VideoGenreSchema, type VideoGenre } from '../director';
import { bulletListTemplate } from './bullet-list';
import { cartoonSceneTemplate } from './cartoon-scene';
import { ctaEndCardTemplate } from './cta-end-card';
import { floatingShapesTemplate } from './floating-shapes';
import { kineticTextTemplate } from './kinetic-text';
import { logoReveal3DTemplate } from './logo-reveal-3d';
import { lowerThirdTemplate } from './lower-third';
import { productTurntableTemplate } from './product-turntable';
import { propertyShowcaseTemplate } from './property-showcase';
import { quoteTemplate } from './quote';
import { splitFeatureTemplate } from './split-feature';
import { statCounterTemplate } from './stat-counter';
import { stepInstructionTemplate } from './step-instruction';
import { titleCardTemplate } from './title-card';
import type { AnyTemplateDefinition, TemplateEngine } from './types';

/** All M1 template ids, in catalog order. */
export const TEMPLATE_IDS = [
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
  'product-turntable',
  'logo-reveal-3d',
  'floating-shapes',
] as const;
export type CatalogTemplateId = (typeof TEMPLATE_IDS)[number];

/** The fixed template catalog the director maps LLM output onto (never executes LLM code). */
export const TEMPLATE_CATALOG: readonly [AnyTemplateDefinition, ...AnyTemplateDefinition[]] = [
  titleCardTemplate,
  kineticTextTemplate,
  bulletListTemplate,
  quoteTemplate,
  statCounterTemplate,
  stepInstructionTemplate,
  splitFeatureTemplate,
  ctaEndCardTemplate,
  cartoonSceneTemplate,
  propertyShowcaseTemplate,
  lowerThirdTemplate,
  productTurntableTemplate,
  logoReveal3DTemplate,
  floatingShapesTemplate,
];

const BY_ID: ReadonlyMap<string, AnyTemplateDefinition> = new Map(TEMPLATE_CATALOG.map((t) => [t.id, t]));

export function getTemplate(id: string): AnyTemplateDefinition | undefined {
  return BY_ID.get(id);
}

export function isCatalogTemplateId(id: string): id is CatalogTemplateId {
  return BY_ID.has(id);
}

export interface TemplateAssetRefProp {
  prop: string;
  kind: AssetKind;
}

/** Asset-reference props of a catalog template (`[]` for unknown templates, so future templates never fail). */
export function getTemplateAssetRefProps(id: string): readonly TemplateAssetRefProp[] {
  const refs = getTemplate(id)?.assetRefProps;
  return refs ? Object.entries(refs).map(([prop, kind]) => ({ prop, kind })) : [];
}

export interface ListTemplatesFilter {
  engine?: TemplateEngine | undefined;
  genre?: VideoGenre | undefined;
}

export function listTemplates(filter: ListTemplatesFilter = {}): AnyTemplateDefinition[] {
  return TEMPLATE_CATALOG.filter(
    (t) =>
      (filter.engine === undefined || t.engine === filter.engine) &&
      (filter.genre === undefined || t.genres.includes(filter.genre)),
  );
}

export type ValidateTemplatePropsResult = { success: true; data: JsonObject } | { success: false; issues: string[] };

/** Validates props against a catalog template's `propsSchema`. Unknown template ids fail with an issue. */
export function validateTemplateProps(id: string, props: unknown): ValidateTemplatePropsResult {
  const template = getTemplate(id);
  if (!template) {
    return { success: false, issues: [`Unknown template "${id}"`] };
  }
  const result = template.propsSchema.safeParse(props);
  if (!result.success) {
    return { success: false, issues: formatZodIssues(result.error) };
  }
  const json = JsonObjectSchema.safeParse(result.data);
  if (!json.success) {
    return { success: false, issues: formatZodIssues(json.error) };
  }
  return { success: true, data: json.data };
}

export const TemplateSummarySchema = z.object({
  id: z.string(),
  engine: z.enum(['motion2d', 'three']),
  name: z.string(),
  description: z.string(),
  genres: z.array(VideoGenreSchema),
  minDurationSeconds: z.number().min(0),
});
export type TemplateSummary = z.infer<typeof TemplateSummarySchema>;

/** Serializable catalog summary (no Zod objects) for APIs and UIs. */
export function templateCatalogSummary(): TemplateSummary[] {
  return TEMPLATE_CATALOG.map((t) => ({
    id: t.id,
    engine: t.engine,
    name: t.name,
    description: t.description,
    genres: [...t.genres],
    minDurationSeconds: t.minDurationSeconds,
  }));
}
