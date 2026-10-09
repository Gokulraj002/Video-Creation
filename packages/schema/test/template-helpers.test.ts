import { describe, expect, it } from 'vitest';
import {
  clip,
  colorsOf,
  firstNumber,
  firstText,
  firstTextOrNull,
  itemsOf,
  paletteOf,
  readableOn,
  textOr,
  textOrNull,
} from '../src/templates/helpers';
import { SAMPLE_CONTEXT } from './fixtures';

describe('template helpers', () => {
  it('clip collapses whitespace and truncates with an ellipsis', () => {
    expect(clip('  a   b \n c ', 10)).toBe('a b c');
    expect(clip('abcdefghij', 5)).toBe('abcd…');
    expect(clip('abcdefghij', 5)).toHaveLength(5);
    expect(clip('abc', 1)).toBe('a');
  });

  it('firstText/textOr never return an empty string', () => {
    expect(firstText(['  ', null, undefined, 'x'], 'fb', 10)).toBe('x');
    expect(firstText(['  ', null], 'fb', 10)).toBe('fb');
    expect(firstText([], '   ', 10)).toBe('Untitled');
    expect(textOr('', '', 3)).toHaveLength(3);
    expect(textOr('hello', 'fb', 10)).toBe('hello');
  });

  it('firstTextOrNull/textOrNull return null for blank input', () => {
    expect(firstTextOrNull([' ', null, 'y'], 10)).toBe('y');
    expect(firstTextOrNull([' ', null], 10)).toBeNull();
    expect(textOrNull('\n', 10)).toBeNull();
    expect(textOrNull('ok', 10)).toBe('ok');
  });

  it('paletteOf keeps valid colors and fills with defaults', () => {
    expect(paletteOf({ ...SAMPLE_CONTEXT, palette: ['bad', '#123456'] })).toHaveLength(5);
    expect(paletteOf({ ...SAMPLE_CONTEXT, palette: ['bad', '#123456'] })[0]).toBe('#123456');
    expect(paletteOf({ ...SAMPLE_CONTEXT, palette: [] }, 2)).toHaveLength(2);
  });

  it('colorsOf picks readable text colors', () => {
    const c = colorsOf({ ...SAMPLE_CONTEXT, palette: ['#FFFFFF', '#FF0000', '#000000', '#EEEEEE'] });
    expect(c.background).toBe('#000000');
    expect(c.text).toBe('#FFFFFF');
    expect(readableOn('#FFFFFF')).toBe('#0F172A');
  });

  it('itemsOf prefers bullets, then sentences, then the title', () => {
    expect(itemsOf(SAMPLE_CONTEXT, 2, 50)).toEqual(['Plan together', 'Ship faster']);
    expect(itemsOf({ ...SAMPLE_CONTEXT, bullets: [], text: 'One. Two! Three?' }, 6, 50)).toEqual(['One.', 'Two!', 'Three?']);
    expect(itemsOf({ ...SAMPLE_CONTEXT, bullets: [], text: null }, 6, 50)).toEqual(['Launch Day']);
  });

  it('firstNumber parses decimals, thousands separators and suffixes', () => {
    expect(firstNumber('Grew 42.5% in 2025')).toEqual({ value: 42.5, decimals: 1, suffix: '%' });
    expect(firstNumber('1,250 users')).toEqual({ value: 1250, decimals: 0, suffix: null });
    expect(firstNumber('$1,200,000.50 raised')).toEqual({ value: 1200000.5, decimals: 2, suffix: null });
    expect(firstNumber('3,5x faster')).toEqual({ value: 3.5, decimals: 1, suffix: 'x' });
    expect(firstNumber('10k downloads')).toEqual({ value: 10, decimals: 0, suffix: 'k' });
    expect(firstNumber('123 Main St')).toEqual({ value: 123, decimals: 0, suffix: null });
    expect(firstNumber('3 million')).toEqual({ value: 3, decimals: 0, suffix: null });
    expect(firstNumber('no digits')).toBeNull();
  });
});
