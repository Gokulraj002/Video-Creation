import { z } from 'zod';
import { FontFamilySchema, HexColorSchema, IdSchema } from './common';

export const BrandColorsSchema = z.object({
  primary: HexColorSchema,
  secondary: HexColorSchema,
  accent: HexColorSchema,
  background: HexColorSchema,
  text: HexColorSchema,
});
export type BrandColors = z.infer<typeof BrandColorsSchema>;

export const BrandFontsSchema = z.object({
  heading: FontFamilySchema,
  body: FontFamilySchema,
});
export type BrandFonts = z.infer<typeof BrandFontsSchema>;

export const BrandKitSchema = z.object({
  name: z.string().max(120).optional(),
  colors: BrandColorsSchema,
  fonts: BrandFontsSchema,
  logoAssetId: IdSchema.optional(),
});
export type BrandKit = z.infer<typeof BrandKitSchema>;
