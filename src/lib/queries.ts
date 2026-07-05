import { queryOptions } from "@tanstack/react-query";
import {
  getImages,
  getGenerations,
  type ImageEntry,
  type Generation,
} from "./tauri";

export interface AssetsData {
  images: ImageEntry[];
  /** Generations keyed by their output image path, for the source-prompt lookup. */
  gens: Record<string, Generation>;
}

async function fetchAssets(): Promise<AssetsData> {
  const [images, generations] = await Promise.all([getImages(), getGenerations()]);
  const gens: Record<string, Generation> = {};
  for (const g of generations) {
    if (g.output_path) gens[g.output_path] = g;
  }
  return { images, gens };
}

/** The asset library query. Shared by the route loader (which prefetches it to
 *  gate navigation) and the component (which reads it via `useQuery`, getting
 *  the cached value instantly plus background revalidation). */
export const assetsQuery = queryOptions({
  queryKey: ["assets"] as const,
  queryFn: fetchAssets,
  staleTime: 30_000,
});
