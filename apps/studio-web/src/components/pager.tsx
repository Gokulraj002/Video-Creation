import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { formatNumber } from '@/lib/format';

/** Server-rendered pagination for long lists (links carry `?page=`, so pages are deep-linkable). */
export function Pager({
  label,
  noun,
  page,
  pageCount,
  start,
  shown,
  total,
  hrefFor,
}: {
  /** Accessible name of the navigation landmark, e.g. "Shot list pages". */
  label: string;
  /** Plural item noun, e.g. "shots". */
  noun: string;
  page: number;
  pageCount: number;
  start: number;
  shown: number;
  total: number;
  hrefFor: (page: number) => string;
}) {
  if (pageCount <= 1) return null;
  return (
    <nav aria-label={label} className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="tabular-nums text-muted-foreground">
        {noun.charAt(0).toUpperCase() + noun.slice(1)} {formatNumber(start + 1)}–{formatNumber(start + shown)} of{' '}
        {formatNumber(total)} · page {formatNumber(page)} of {formatNumber(pageCount)}
      </span>
      <span className="flex gap-2">
        {page > 1 ? (
          <Button asChild variant="outline" size="sm">
            <Link href={hrefFor(page - 1)} rel="prev">
              <ChevronLeft aria-hidden="true" /> Previous
            </Link>
          </Button>
        ) : null}
        {page < pageCount ? (
          <Button asChild variant="outline" size="sm">
            <Link href={hrefFor(page + 1)} rel="next">
              Next <ChevronRight aria-hidden="true" />
            </Link>
          </Button>
        ) : null}
      </span>
    </nav>
  );
}
