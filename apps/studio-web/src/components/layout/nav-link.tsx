'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Main-navigation link. The text label is visually hidden below `md` (icon-only header) but stays in the
 * accessibility tree, so the link always has an accessible name; `title` adds a tooltip for the icon-only state.
 */
export function NavLink({
  href,
  exact = false,
  label,
  children,
}: {
  href: string;
  exact?: boolean;
  label: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      title={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors [&_svg]:size-4',
        active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
      <span className="sr-only md:not-sr-only">{label}</span>
    </Link>
  );
}
