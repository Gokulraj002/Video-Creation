import { describe, expect, it } from 'vitest';
import { availableTabs, paginate, parsePage, projectHref, resolveTab } from './project-tabs';

describe('project tabs', () => {
  it('offers artifact tabs only when a version exists', () => {
    expect(availableTabs(true)).toEqual(['storyboard', 'preview', 'brief', 'script', 'shots', 'timeline', 'usage', 'request']);
    expect(availableTabs(false)).toEqual(['usage', 'request']);
  });

  it('resolves the ?tab= param against the available tabs', () => {
    expect(resolveTab('script', availableTabs(true))).toBe('script');
    expect(resolveTab('script', availableTabs(false))).toBe('usage');
    expect(resolveTab(null, availableTabs(true))).toBe('storyboard');
    expect(resolveTab('<script>', availableTabs(true))).toBe('storyboard');
  });

  it('builds canonical links', () => {
    const base = '/projects/p1';
    expect(projectHref(base, { tab: 'storyboard', defaultTab: 'storyboard' })).toBe(base);
    expect(projectHref(base, { tab: 'preview', defaultTab: 'storyboard' })).toBe(`${base}?tab=preview`);
    expect(projectHref(base, { version: 2, tab: 'shots', defaultTab: 'storyboard', page: 3 })).toBe(
      `${base}?version=2&tab=shots&page=3`,
    );
    expect(projectHref(base, { version: null, tab: 'shots', page: 1 })).toBe(`${base}?tab=shots`);
  });

  it('parses page numbers defensively', () => {
    expect(parsePage(null)).toBe(1);
    expect(parsePage('0')).toBe(1);
    expect(parsePage('7')).toBe(7);
    expect(parsePage('-2')).toBe(1);
    expect(parsePage('1e9')).toBe(1);
  });

  it('paginates and clamps out-of-range pages', () => {
    const items = Array.from({ length: 450 }, (_, i) => i);
    expect(paginate(items, 1, 200)).toMatchObject({ page: 1, pageCount: 3, start: 0, total: 450 });
    expect(paginate(items, 3, 200).items).toHaveLength(50);
    expect(paginate(items, 99, 200)).toMatchObject({ page: 3, start: 400 });
    expect(paginate([], 5, 200)).toMatchObject({ page: 1, pageCount: 1, items: [] });
  });
});
