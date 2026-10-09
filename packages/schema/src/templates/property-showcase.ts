import { z } from 'zod';
import { HexColorSchema } from '../common';
import { colorsOf, itemsOf, textOr } from './helpers';
import { defineTemplate } from './types';

export const PropertyShowcasePropsSchema = z.object({
  propertyName: z.string().min(1).max(120),
  location: z.string().min(1).max(160),
  price: z.string().min(1).max(40).nullable(),
  features: z.array(z.string().min(1).max(120)).min(1).max(6),
  accentColor: HexColorSchema,
  backgroundColor: HexColorSchema,
});
export type PropertyShowcaseProps = z.infer<typeof PropertyShowcasePropsSchema>;

const PRICE = /(?:[$€£₹]\s?\d[\d,.]*\s?(?:k|m|million|lakh|crore)?|\d[\d,.]*\s?(?:USD|EUR|GBP|INR))/i;

export const propertyShowcaseTemplate = defineTemplate({
  id: 'property-showcase',
  engine: 'motion2d',
  name: 'Property showcase',
  description:
    'Real-estate listing card: property name, location pin, optional price tag and up to 6 feature chips ' +
    '(beds, baths, area, amenities). Use for property tours and listings.',
  genres: ['real-estate'],
  propsSchema: PropertyShowcasePropsSchema,
  minDurationSeconds: 4,
  buildProps(ctx) {
    const c = colorsOf(ctx);
    const price = PRICE.exec([ctx.text ?? '', ...ctx.bullets].join(' '));
    return {
      propertyName: textOr(ctx.title, 'Featured property', 120),
      location: textOr(ctx.brandName, 'Prime location', 160),
      price: price ? price[0].trim().slice(0, 40) : null,
      features: itemsOf(ctx, 6, 120),
      accentColor: c.accent,
      backgroundColor: c.background,
    };
  },
});
