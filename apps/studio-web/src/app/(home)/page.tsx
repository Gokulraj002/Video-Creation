import { Coins, Cpu, FolderKanban, Plus, Sparkles, Zap } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ApiErrorState } from '@/components/api-error-state';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { ProjectsTable } from '@/components/projects/projects-table';
import { StatCard } from '@/components/stat-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { projectCountStat } from '@/lib/dashboard';
import { formatCompactNumber, formatNumber, formatUsd } from '@/lib/format';
import { attempt, getUsageSummary, listProjects } from '@/lib/studio-api';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Dashboard' };

const RECENT_LIMIT = 10;

export default async function DashboardPage() {
  const [projectsResult, usageResult] = await Promise.all([
    attempt(() => listProjects({ limit: RECENT_LIMIT })),
    attempt(() => getUsageSummary()),
  ]);
  const now = Date.now();

  const newProjectButton = (
    <Button asChild>
      <Link href="/projects/new">
        <Plus />
        New project
      </Link>
    </Button>
  );

  if (!projectsResult.ok) {
    return (
      <>
        <PageHeader title="Dashboard" description="Your AI-directed video projects at a glance." />
        <ApiErrorState failure={projectsResult.failure} retryHref="/" />
      </>
    );
  }

  const page = projectsResult.data;
  const usage = usageResult.ok ? usageResult.data : null;
  const directing = page.items.filter((p) => p.status === 'directing').length;
  const projectCount = projectCountStat(page, directing);
  const monthTokens = usage ? usage.month.inputTokens + usage.month.outputTokens : null;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Your AI-directed video projects at a glance."
        actions={newProjectButton}
      />

      <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Statistics">
        <StatCard
          icon={FolderKanban}
          label="Projects"
          value={projectCount.value}
          hint={projectCount.hint}
        />
        <StatCard
          icon={Zap}
          label="Director runs today"
          value={usage ? formatNumber(usage.today.runs) : '—'}
          hint={usage ? `${formatUsd(usage.today.estimatedCostUsd)} est. today (UTC)` : 'Usage unavailable'}
        />
        <StatCard
          icon={Cpu}
          label="Tokens this month"
          value={monthTokens === null ? '—' : formatCompactNumber(monthTokens)}
          hint={
            usage
              ? `${formatCompactNumber(usage.month.inputTokens)} in · ${formatCompactNumber(usage.month.outputTokens)} out · ${formatCompactNumber(usage.month.cacheReadTokens)} cached`
              : 'Usage unavailable'
          }
        />
        <StatCard
          icon={Coins}
          label="Est. cost this month"
          value={usage ? formatUsd(usage.month.estimatedCostUsd) : '—'}
          hint={usage ? `${formatNumber(usage.month.runs)} runs this month` : 'Usage unavailable'}
        />
      </section>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
          <div className="space-y-1">
            <CardTitle>Recent projects</CardTitle>
            <CardDescription>Most recently updated first.</CardDescription>
          </div>
          {page.items.length > 0 ? (
            <Button asChild variant="outline" size="sm">
              <Link href="/projects">View all</Link>
            </Button>
          ) : null}
        </CardHeader>
        <CardContent>
          {page.items.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title="No projects yet"
              description="Describe the video you want — the AI Director writes the brief, script, storyboard and shot list, then compiles a frame-accurate timeline you can preview."
              action={newProjectButton}
            />
          ) : (
            <ProjectsTable projects={page.items} now={now} />
          )}
        </CardContent>
      </Card>
    </>
  );
}
