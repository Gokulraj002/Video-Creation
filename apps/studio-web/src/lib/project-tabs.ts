/**
 * Project page tabs. Only the active tab is rendered (server-side); the URL carries it as `?tab=` (plus `version`
 * and, for paginated tabs, `page`). Pure helpers, shared by the page and its tests.
 */

export const PROJECT_TABS = [
  { value: 'storyboard', label: 'Storyboard', needsVersion: true },
  { value: 'preview', label: 'Preview', needsVersion: true },
  { value: 'brief', label: 'Brief', needsVersion: true },
  { value: 'script', label: 'Script', needsVersion: true },
  { value: 'shots', label: 'Shot list', needsVersion: true },
  { value: 'timeline', label: 'Timeline JSON', needsVersion: true },
  { value: 'usage', label: 'Usage', needsVersion: false },
  { value: 'request', label: 'Request', needsVersion: false },
] as const;

export type ProjectTabId = (typeof PROJECT_TABS)[number]['value'];

/** Tabs whose server render needs the full version payload (artifacts / timeline). */
export const TABS_NEEDING_VERSION_PAYLOAD: ReadonlySet<ProjectTabId> = new Set(['storyboard', 'brief', 'script', 'shots']);

export function availableTabs(hasVersion: boolean): ProjectTabId[] {
  return PROJECT_TABS.filter((t) => hasVersion || !t.needsVersion).map((t) => t.value);
}

export function tabLabel(tab: ProjectTabId): string {
  return PROJECT_TABS.find((t) => t.value === tab)?.label ?? tab;
}

/** The requested tab when it is available, otherwise the first available one. */
export function resolveTab(requested: string | null | undefined, available: readonly ProjectTabId[]): ProjectTabId {
  const match = available.find((t) => t === requested);
  return match ?? available[0] ?? 'usage';
}

/** 1-based page number from `?page=` (invalid / missing → 1). */
export function parsePage(raw: string | null | undefined): number {
  if (!raw || !/^\d{1,6}$/.test(raw)) return 1;
  return Math.max(1, Number(raw));
}

/**
 * Link to a project page state. `tab` is omitted when it is the default (first) tab and `page` when it is 1, so the
 * canonical URL stays `/projects/:id`.
 */
export function projectHref(
  basePath: string,
  opts: { version?: number | null; tab?: ProjectTabId | null; defaultTab?: ProjectTabId | null; page?: number | null },
): string {
  const params = new URLSearchParams();
  if (opts.version !== null && opts.version !== undefined) params.set('version', String(opts.version));
  if (opts.tab && opts.tab !== opts.defaultTab) params.set('tab', opts.tab);
  if (opts.page && opts.page > 1) params.set('page', String(opts.page));
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export interface PageSlice<T> {
  items: T[];
  page: number;
  pageCount: number;
  /** 0-based index of the first item on this page. */
  start: number;
  total: number;
}

/** Slices `items` into fixed-size pages; out-of-range pages clamp to the last page. */
export function paginate<T>(items: readonly T[], page: number, pageSize: number): PageSlice<T> {
  const size = Math.max(1, Math.trunc(pageSize));
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, Math.trunc(page)), pageCount);
  const start = (current - 1) * size;
  return { items: items.slice(start, start + size), page: current, pageCount, start, total: items.length };
}
