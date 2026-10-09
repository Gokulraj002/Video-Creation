import { PageSkeleton } from '@/components/page-skeleton';

/**
 * Segment-scoped loading UI. Deliberately NOT at the app root: a root `loading.tsx` would wrap
 * `/projects/[id]` too, start streaming before that page can call `notFound()`, and turn a missing
 * project into an HTTP 200. Only segments that never call `notFound()` get one.
 */
export default function Loading() {
  return <PageSkeleton />;
}
