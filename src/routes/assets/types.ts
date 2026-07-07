import type { ImageEntry, Generation } from "../../lib/tauri";

export type Dims = { w: number; h: number };

/** Origin filter for the asset grid: everything, uploaded sources, AI output,
 *  or source images that haven't produced any AI variant yet. */
export type AssetFilter = "all" | "source" | "ai" | "novariant";
/** Layout for the asset library: tile grid or detailed row list. */
export type AssetView = "grid" | "list";
/** Sort key for the asset grid: date added or display name. */
export type SortKey = "date" | "name";
/** Sort direction. */
export type SortDir = "asc" | "desc";

/** A row in the virtualized grid/list: either a finished image or an
 *  in-progress generation rendered as a placeholder tile. */
export type Item =
  | { kind: "pending"; gen: Generation }
  | { kind: "image"; img: ImageEntry };
