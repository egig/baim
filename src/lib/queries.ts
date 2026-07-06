import { queryOptions } from "@tanstack/react-query";
import {
  getImages,
  getGenerations,
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

/** The saved image library. Split from generations so the queue engine can poll
 *  on its own cadence without re-fetching images every 2s. */
export const imagesQuery = queryOptions({
  queryKey: ["images"] as const,
  queryFn: getImages,
  staleTime: 30_000,
});

/** The queue engine. One `queryFn` owns the whole state machine:
 *   1. poll every `pending` row one step (`refresh_generation`), and
 *   2. if in-flight < K and any `queued` remain, submit the free slots
 *      (`submit_queued`) to promote them to `pending`.
 *
 *  It self-polls every 2s while any job is `queued` or `pending`, and stops once
 *  everything settles. Because the always-mounted shell (sidebar badge) observes
 *  this query, the engine keeps draining on every route. */
export const generationsQuery = queryOptions({
  queryKey: ["generations"] as const,
  queryFn: pollAndDrain,
  staleTime: 30_000,
  refetchInterval: (query) =>
    query.state.data?.some(isActive) ? 2000 : false,
});

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
 *  `pending` for the in-progress placeholder tiles in the grid. */
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
  const pending = generations.filter((g) => g.status === "pending");
  return { gens, childrenBySource, pending };
}

export type { ImageEntry, Generation };
