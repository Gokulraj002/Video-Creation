'use client';

import { LoaderCircle, Trash2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { deleteProjectAction } from '@/app/projects/[id]/actions';
import { Button } from '@/components/ui/button';

/** Deletes the project after a confirmation (the API refuses while a director run is active). */
export function DeleteProjectButton({ projectId, title, disabled }: { projectId: string; title: string; disabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    if (!window.confirm(`Delete “${title}” and all of its versions? This cannot be undone.`)) return;
    startTransition(async () => {
      setError(null);
      const result = await deleteProjectAction(projectId);
      if (!result.ok) setError(result.message);
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        disabled={disabled || pending}
        title={disabled ? 'Cancel the active director run before deleting' : 'Delete project'}
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        {pending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
        Delete
      </Button>
      {error ? <p className="max-w-64 text-right text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
