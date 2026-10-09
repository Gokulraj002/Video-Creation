import type { Metadata } from 'next';
import Link from 'next/link';
import { ApiErrorAlert } from '@/components/api-error-state';
import { PageHeader } from '@/components/page-header';
import { ProjectForm } from '@/components/projects/project-form';
import { attempt, getSystemConfig } from '@/lib/studio-api';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'New project' };

export default async function NewProjectPage() {
  // Limits are configurable on the API side; show them (no hardcoded maxima in the UI).
  const config = await attempt(() => getSystemConfig());

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/projects" className="hover:text-foreground hover:underline">
            Projects
          </Link>
        }
        title="New project"
        description={
          config.ok ? (
            <>
              Director: <span className="font-medium text-foreground">{config.data.aiProvider.name}</span> ·{' '}
              {config.data.aiProvider.model} ({config.data.aiProvider.mode === 'mock' ? 'mock — no credits spent' : 'live'})
            </>
          ) : (
            'Describe your video and the AI Director will plan it end to end.'
          )
        }
      />
      {!config.ok ? (
        <div className="mb-6">
          <ApiErrorAlert
            failure={config.failure}
            title="The Studio API is unavailable — you can fill in the form, but submitting will fail until it is back."
          />
        </div>
      ) : null}
      <ProjectForm limits={config.ok ? config.data.limits : null} />
    </>
  );
}
