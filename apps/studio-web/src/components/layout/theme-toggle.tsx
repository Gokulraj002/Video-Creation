'use client';

import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const THEME_STORAGE_KEY = 'vc-studio-theme';

/**
 * Inline script for <head>: applies the saved theme (or the OS preference) before first paint so there is no
 * flash. Kept tiny and dependency-free.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");var d=t?t==="dark":window.matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;

/** Toggles light/dark. Icons are switched purely with CSS so server and client markup always match. */
export function ThemeToggle() {
  const toggle = () => {
    const root = document.documentElement;
    const next = !root.classList.contains('dark');
    root.classList.toggle('dark', next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next ? 'dark' : 'light');
    } catch {
      // Storage unavailable (private mode) — the toggle still works for this page view.
    }
  };
  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle dark mode" title="Toggle dark mode">
      <Sun className="hidden dark:block" />
      <Moon className="block dark:hidden" />
    </Button>
  );
}
