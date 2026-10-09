import { FolderKanban, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ApiErrorState } from '@/components/api-error-state';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { ProjectsTable } from '@/components/projects/projects-table';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { attempt, listProjects } from '@/lib/studio-api';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Projects' };

const PAGE_SIZE = 20;

function firstParam(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v && /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : null;
}

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const cursor = firstParam(params.cursor);
  const result = await attempt(() => listProjects({ limit: PAGE_SIZE, cursor }));
  const now = Date.now();

  const header = (
    <PageHeader
      title="Projects"
      description="All of your projects, most recently updated first."
      actions={
        <Button asChild>
          <Link href="/projects/new">
            <Plus />
            New project
          </Link>
        </Button>
      }
    />
  );

  if (!result.ok) {
    return (
      <>
        {header}
        <ApiErrorState failure={result.failure} retryHref={cursor ? `/projects?cursor=${cursor}` : '/projects'} />
      </>
    );
  }

  const { items, nextCursor } = result.data;
  return (
    <>
      {header}
      <Card>
        <CardContent className="pt-5">
          {items.length === 0 ? (
            <EmptyState
              icon={FolderKanban}
              title={cursor ? 'No more projects' : 'No projects yet'}
              description={cursor ? 'You reached the end of the list.' : 'Create a project to let the AI Director plan your first video.'}
              action={
                cursor ? (
                  <Button asChild variant="outline">
                    <Link href="/projects">Back to first page</Link>
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ProjectsTable projects={items} now={now} />
          )}
        </CardContent>
      </Card>
      {cursor || nextCursor ? (
        <div className="mt-4 flex items-center justify-between gap-2">
          {cursor ? (
            <Button asChild variant="outline" size="sm">
              <Link href="/projects">First page</Link>
            </Button>
          ) : (
            <span />
          )}
          {nextCursor ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects?cursor=${encodeURIComponent(nextCursor)}`}>Next page</Link>
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
