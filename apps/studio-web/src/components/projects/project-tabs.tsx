'use client';

import type { ReactNode } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export interface ProjectTab {
  value: string;
  label: string;
  icon?: ReactNode;
  content: ReactNode;
}

/** Radix tabs wrapper; panel contents are rendered on the server and passed in as nodes. */
export function ProjectTabs({ tabs, defaultValue }: { tabs: readonly ProjectTab[]; defaultValue: string }) {
  return (
    <Tabs defaultValue={defaultValue}>
      <TabsList aria-label="Project artifacts">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.icon}
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.value} value={tab.value}>
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
