import { Clapperboard, FolderKanban, LayoutDashboard, Plus, Settings } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { NavLink } from './nav-link';
import { ThemeToggle } from './theme-toggle';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-3 px-4 sm:px-6">
          <Link href="/" className="mr-2 flex items-center gap-2 font-semibold tracking-tight">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
              <Clapperboard className="size-4" />
            </span>
            <span className="hidden sm:inline">AI Video Studio</span>
          </Link>
          <nav aria-label="Main" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            <NavLink href="/" exact>
              <LayoutDashboard />
              <span className="hidden md:inline">Dashboard</span>
            </NavLink>
            <NavLink href="/projects" exact>
              <FolderKanban />
              <span className="hidden md:inline">Projects</span>
            </NavLink>
            <NavLink href="/settings">
              <Settings />
              <span className="hidden md:inline">Settings</span>
            </NavLink>
          </nav>
          <div className="flex items-center gap-1">
            <Button asChild size="sm">
              <Link href="/projects/new">
                <Plus />
                <span className="hidden sm:inline">New project</span>
              </Link>
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-muted-foreground sm:px-6">
          <span>Universal AI Video Studio · Milestone 1</span>
          <span>Director plans are previewed as animatics; rendering arrives in Milestone 2.</span>
        </div>
      </footer>
    </div>
  );
}
