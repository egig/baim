import { queryOptions } from "@tanstack/react-query";
import {
  getImages,
  getGenerations,
  getActiveWorkspace,
  refreshGeneration,
  submitQueued,
  type ImageEntry,
  type Generation,
} from "./tauri";

/** Max generations allowed in flight (`pending`) at once. The queue drainer
 *  promotes at most `K - inFlight` queued jobs per tick, so concurrency — and
 *  therefore provider rate/cost pressure — stays capped no matter how many jobs
 *  are queued. */
export const K = 3;

/** A generation is "active" (keeps the poll/drain engine ticking) while it is
 *  either waiting to be submitted (`queued`) or in flight (`pending`). */
export function isActive(g: Generation): boolean {
  return g.status === "queued" || g.status === "pending";
}

/** The active workspace. Only changes via an explicit `setQueryData` right
 *  after `open_workspace` succeeds (see the switcher), so this never refetches
 *  on its own. */
export const activeWorkspaceQuery = queryOptions({
  queryKey: ["activeWorkspace"] as const,
  queryFn: getActiveWorkspace,
  staleTime: Infinity,
});

/** The saved image library, scoped to a workspace. Split from generations so
 *  the queue engine can poll on its own cadence without re-fetching images
 *  every 2s. Keying by workspace path is what makes switching workspaces safe
 *  — a different path is simply a different, independently-fetched cache
 *  entry, so nothing from the previous workspace can leak through. `enabled`
 *  is false until the active workspace is known, so components that mount
 *  before then don't error. */
export function imagesQuery(workspacePath: string | undefined) {
  return queryOptions({
    queryKey: ["images", workspacePath ?? null] as const,
    queryFn: getImages,
    enabled: workspacePath != null,
    staleTime: 30_000,
  });
}

/** The queue engine, scoped to a workspace. One `queryFn` owns the whole state
 *  machine:
 *   1. poll every `pending` row one step (`refresh_generation`), and
 *   2. if in-flight < K and any `queued` remain, submit the free slots
 *      (`submit_queued`) to promote them to `pending`.
 *
 *  It self-polls every 2s while any job is `queued` or `pending`, and stops once
 *  everything settles. Because the always-mounted shell (sidebar badge) observes
 *  this query, the engine keeps draining on every route. A workspace that isn't
 *  active stops being polled — its jobs resume advancing once it's reopened. */
export function generationsQuery(workspacePath: string | undefined) {
  return queryOptions({
    queryKey: ["generations", workspacePath ?? null] as const,
    queryFn: pollAndDrain,
    enabled: workspacePath != null,
    staleTime: 30_000,
    refetchInterval: (query) =>
      query.state.data?.some(isActive) ? 2000 : false,
  });
}

async function pollAndDrain(): Promise<Generation[]> {
  let generations = await getGenerations();

  // 1. Advance any in-flight generation by one poll step. Errors are swallowed
  //    per-id so one stuck job doesn't abort the pass.
  const pendingIds = generations
    .filter((g) => g.status === "pending")
    .map((g) => g.id);
  if (pendingIds.length) {
    const advanced = await Promise.all(
      pendingIds.map((id) => refreshGeneration(id).catch(() => null))
    );
    generations = mergeById(generations, advanced);
  }

  // 2. Drain the queue up to the free in-flight slots. Recompute in-flight after
  //    polling, since jobs that just finished free up their slots this tick.
  const inFlight = generations.filter((g) => g.status === "pending").length;
  const queued = generations.filter((g) => g.status === "queued").length;
  const free = K - inFlight;
  if (free > 0 && queued > 0) {
    const submitted = await submitQueued(free).catch(() => [] as Generation[]);
    generations = mergeById(generations, submitted);
  }

  return generations;
}

/** Overlay updated records (by id) onto the list, keeping order. */
function mergeById(
  list: Generation[],
  updates: (Generation | null)[]
): Generation[] {
  const byId = new Map<string, Generation>();
  for (const g of updates) if (g) byId.set(g.id, g);
  if (byId.size === 0) return list;
  return list.map((g) => byId.get(g.id) ?? g);
}

/** Derived views over the raw generation list, computed by the assets page.
 *  `gens` keyed by output path (source-prompt lookup); `childrenBySource`
 *  grouped by source image id (oldest first) for the detail panel's lineage;
 *  `pending` (queued *or* in-flight) for the placeholder tiles in the grid —
 *  queued jobs render immediately, before the drainer submits them. */
export interface DerivedGenerations {
  gens: Record<string, Generation>;
  childrenBySource: Record<string, Generation[]>;
  pending: Generation[];
}

export function deriveGenerations(
  generations: Generation[]
): DerivedGenerations {
  const gens: Record<string, Generation> = {};
  const childrenBySource: Record<string, Generation[]> = {};
  for (const g of generations) {
    if (g.output_path) gens[g.output_path] = g;
    if (g.source_id) (childrenBySource[g.source_id] ??= []).push(g);
  }
  for (const list of Object.values(childrenBySource)) {
    list.sort((a, b) => a.created_at - b.created_at);
  }
  const pending = generations.filter(isActive);
  return { gens, childrenBySource, pending };
}

export type { ImageEntry, Generation };
