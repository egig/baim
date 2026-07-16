import { queryOptions } from "@tanstack/react-query";
import {
  getImages,
  getGenerations,
  getActiveWorkspace,
  refreshGeneration,
  submitQueued,
  listTemplates,
  getMaxConcurrency,
  type ImageEntry,
  type Generation,
  type SubmitOutcome,
  type Template,
} from "./tauri";

/** Concurrency the engine always starts each app launch at, before ramping up. */
const FLOOR = 1;

/** Ceiling fallback used until the user's setting loads (see
 *  `ensureCeilingLoaded`) — matches the backend's own default. */
const DEFAULT_CEILING = 10;

/** How many drain ticks to hold `k` steady after a rate-limit hit before
 *  resuming ramp-up, so it doesn't bounce straight back into the same wall. */
const COOLDOWN_TICKS = 3;

/** Adaptive in-flight concurrency target (AIMD: additive increase /
 *  multiplicative decrease, the same idea TCP congestion control uses). The
 *  queue drainer promotes at most `k - inFlight` queued jobs per tick.
 *
 *  In-memory only — always restarts at `FLOOR` on app launch rather than
 *  persisting a learned value: ramping back up costs a few ticks, negligible
 *  next to how long a batch job takes, and this avoids starting "optimistic"
 *  after something changed since last session (quota tier, the same key used
 *  elsewhere).
 *
 *  `k` ramps up by 1 only after a drain tick that both saturated `k` (queued
 *  demand was enough to actually use every free slot — proving nothing isn't
 *  grounds to ramp) and hit no rate limit. A rate-limited submission halves
 *  `k` (floor `FLOOR`) immediately and starts a cooldown that pauses
 *  ramp-up for a few ticks, so it doesn't bounce straight back into the wall
 *  it just found. */
let k = FLOOR;
let ceiling = DEFAULT_CEILING;
let ceilingLoaded = false;
let cooldown = 0;

/** Applied by the settings page right after a successful save, so a new
 *  ceiling takes effect immediately without an app restart. */
export function setConcurrencyCeiling(value: number): void {
  ceiling = value;
  ceilingLoaded = true;
  k = Math.min(k, ceiling);
}

/** Applies the same AIMD backoff a rate-limited `SubmitOutcome` triggers
 *  below, but callable from anywhere a rate limit is observed — including
 *  out-of-band, via the `generation-rate-limited` Tauri event a detached
 *  Interactions-mode task emits (see `root.tsx`) when it hits a 429 after
 *  its own `submit_queued` tick already returned, so it can't ride along in
 *  that call's `SubmitOutcome.rate_limited` like the synchronous Batch path
 *  does. */
export function applyRateLimitSignal(): void {
  k = Math.max(FLOOR, Math.floor(k / 2));
  cooldown = COOLDOWN_TICKS;
}

async function ensureCeilingLoaded(): Promise<void> {
  if (ceilingLoaded) return;
  ceilingLoaded = true; // set eagerly so concurrent ticks don't all fetch
  try {
    ceiling = await getMaxConcurrency();
  } catch {
    // keep DEFAULT_CEILING
  }
}

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
 *   2. if in-flight < `k` (the adaptive concurrency target, see above) and any
 *      `queued` remain, submit the free slots (`submit_queued`) to promote
 *      them to `pending`, then adjust `k` based on the outcome.
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
  await ensureCeilingLoaded();
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
  const free = k - inFlight;
  if (cooldown > 0) cooldown--;
  if (free > 0 && queued > 0) {
    const saturated = queued >= free;
    const result = await submitQueued(free).catch(
      () => ({ generations: [], rate_limited: false }) as SubmitOutcome
    );
    generations = mergeById(generations, result.generations);
    console.debug("[aimd]", { k, ceiling, cooldown, free, queued, saturated, rate_limited: result.rate_limited });

    // 3. Adjust the concurrency target based on how this drain went.
    if (result.rate_limited) {
      applyRateLimitSignal();
    } else if (saturated && cooldown === 0 && k < ceiling) {
      k += 1;
    }
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

/** User-saved prompt templates. Unlike `imagesQuery`/`generationsQuery`, this
 *  is global (not workspace-keyed) — templates are app-wide, not scoped to
 *  whichever folder happens to be the active workspace. */
export const templatesQuery = queryOptions({
  queryKey: ["templates"] as const,
  queryFn: listTemplates,
  staleTime: 30_000,
});

export type { ImageEntry, Generation, Template };
