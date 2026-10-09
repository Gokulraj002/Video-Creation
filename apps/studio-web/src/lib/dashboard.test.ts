import { describe, expect, it } from 'vitest';
import { projectCountStat } from './dashboard';

const ten = Array.from({ length: 10 }, (_, i) => i);

describe('projectCountStat', () => {
  it('uses the total when the API provides it', () => {
    expect(projectCountStat({ items: ten, nextCursor: 'c', total: 1234 }, 0)).toEqual({ value: '1,234', hint: 'All projects' });
    expect(projectCountStat({ items: [], nextCursor: null, total: 0 }, 0).value).toBe('0');
  });

  it('falls back to an honest lower bound without a total', () => {
    expect(projectCountStat({ items: ten, nextCursor: 'c' }, 0)).toEqual({
      value: '10+',
      hint: 'More than 10 — see all projects',
    });
    expect(projectCountStat({ items: ten.slice(0, 3), nextCursor: null }, 0)).toEqual({ value: '3', hint: 'All projects' });
  });

  it('mentions running directors first', () => {
    expect(projectCountStat({ items: ten, nextCursor: 'c' }, 2).hint).toBe('2 directing now');
  });
});
