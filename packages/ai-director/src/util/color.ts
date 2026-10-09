const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function isHexColor(value: string): boolean {
  return HEX.test(value);
}

/** Upper-cased valid hex colors without duplicates (first occurrence wins). */
export function uniqueHexColors(colors: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of colors) {
    if (!isHexColor(c)) continue;
    const key = c.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Relative luminance (0..1) of a #RRGGBB[AA] color. */
export function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Readable text color for a background. */
export function readableOn(background: string): string {
  return luminance(background) > 0.45 ? '#0F172A' : '#FFFFFF';
}
