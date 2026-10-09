import { formatNumber } from './format';

/**
 * "Projects" stat card. Uses the API's optional `total` (count over all pages) when the response has it; otherwise
 * the honest lower bound from the first page: `10+` when more pages exist.
 */
export function projectCountStat(
  page: { items: readonly unknown[]; nextCursor: string | null; total?: number | undefined },
  directing: number,
): { value: string; hint: string } {
  const exact = typeof page.total === 'number' && Number.isFinite(page.total) && page.total >= 0;
  const value = exact ? formatNumber(page.total ?? 0) : `${formatNumber(page.items.length)}${page.nextCursor ? '+' : ''}`;
  const hint =
    directing > 0
      ? `${directing} directing now`
      : exact || !page.nextCursor
        ? 'All projects'
        : `More than ${formatNumber(page.items.length)} — see all projects`;
  return { value, hint };
}
