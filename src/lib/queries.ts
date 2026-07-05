import { queryOptions } from "@tanstack/react-query";
import {
  getImages,
  getGenerations,
  refreshGeneration,
  type ImageEntry,
  type Generation,
} from "./tauri";

export interface AssetsData {
  images: ImageEntry[];
  /** Generations keyed by their output image path, for the source-prompt lookup. */
  gens: Record<string, Generation>;
  /** Generations still running, shown as in-progress placeholder tiles. */
  pending: Generation[];
}

async function fetchAssets(): Promise<AssetsData> {
  let generations = await getGenerations();

  // Advance any async generation by one poll step. Each refetch (driven by the
  // query's `refetchInterval` while pending exist) nudges the backend forward;
  // errors are swallowed per-id so one stuck job doesn't abort the batch.
  const pendingIds = generations
    .filter((g) => g.status === "pending")
    .map((g) => g.id);
  if (pendingIds.length) {
    const advanced = await Promise.all(
      pendingIds.map((id) => refreshGeneration(id).catch(() => null))
    );
    const byId = new Map<string, Generation>();
    for (const g of advanced) if (g) byId.set(g.id, g);
    generations = generations.map((g) => byId.get(g.id) ?? g);
  }

  const images = await getImages();

  const gens: Record<string, Generation> = {};
  for (const g of generations) {
    if (g.output_path) gens[g.output_path] = g;
  }
  const pending = generations.filter((g) => g.status === "pending");
  return { images, gens, pending };
}

/** The asset library query. Shared by the route loader (which prefetches it to
 *  gate navigation) and the component (which reads it via `useQuery`, getting
 *  the cached value instantly plus background revalidation).
 *
 *  While any generation is still `pending`, the query self-polls every 2s —
 *  each refetch advances the backend a step (see `fetchAssets`) — and stops once
 *  everything has settled. */
export const assetsQuery = queryOptions({
  queryKey: ["assets"] as const,
  queryFn: fetchAssets,
  staleTime: 30_000,
  refetchInterval: (query) =>
    query.state.data?.pending.length ? 2000 : false,
});
