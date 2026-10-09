'use client';

import { LoaderCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactNode } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export interface ProjectTabLink {
  value: string;
  label: string;
  icon?: ReactNode;
  /** URL of the page with this tab active (`?tab=`); the server renders only the active panel. */
  href: string;
}

/**
 * Tab list for the project page. Only the active panel exists: it is server-rendered for the `?tab=` in the URL and
 * passed in as `children`. Selecting another tab navigates (`router.replace`, no scroll) and shows a placeholder
 * until the server sends that panel. Manual activation: arrow keys move focus between tabs, Enter / Space opens one
 * (opening a panel costs a request, so focus alone must not trigger it — and focus never jumps into the panel).
 */
export function ProjectTabs({ tabs, active, children }: { tabs: readonly ProjectTabLink[]; active: string; children: ReactNode }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [target, setTarget] = useState<string | null>(null);
  const shown = isPending && target !== null ? target : active;

  const select = (value: string) => {
    const tab = tabs.find((t) => t.value === value);
    if (!tab || (value === active && !isPending)) return;
    setTarget(value);
    startTransition(() => router.replace(tab.href, { scroll: false }));
  };

  return (
    <Tabs value={shown} onValueChange={select} activationMode="manual">
      <TabsList aria-label="Project artifacts">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.icon}
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={shown} aria-busy={shown !== active ? true : undefined}>
        {shown === active ? (
          children
        ) : (
          <div role="status" className="flex min-h-40 items-center justify-center gap-2 rounded-xl border border-dashed text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Loading {tabs.find((t) => t.value === shown)?.label ?? 'tab'}…
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
