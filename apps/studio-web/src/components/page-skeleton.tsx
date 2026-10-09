/** Loading placeholders (used by segment `loading.tsx` files and in-page Suspense boundaries). */

export function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="space-y-2">
        <div className="h-4 w-32 animate-pulse rounded bg-muted" />
        <div className="h-8 w-72 animate-pulse rounded bg-muted" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl border bg-card" />
        ))}
      </div>
      <div className="h-80 animate-pulse rounded-xl border bg-card" />
    </div>
  );
}

/** Tab bar + panel placeholder for the project page body. */
export function ProjectBodySkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading project…</span>
      <div className="h-10 w-full max-w-2xl animate-pulse rounded-lg bg-muted" />
      <div className="h-80 animate-pulse rounded-xl border bg-card" />
    </div>
  );
}
