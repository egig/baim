import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Generation, ImageEntry } from "../../lib/tauri";
import { Button } from "../../root";
import { ImageCard } from "./ImageCard";
import { ImageRow } from "./ImageRow";
import { PendingCard } from "./PendingCard";
import { PendingRow } from "./PendingRow";
import { useContainerWidth } from "./useContainerWidth";
import type { AssetFilter, AssetView, Dims, Item } from "./types";

// The asset grid/list can hold thousands of tiles; we render only the visible
// rows (plus overscan) via @tanstack/react-virtual. Row heights are *computed*
// from the measured container width (tiles are square) rather than DOM-measured,
// so there's no layout thrash when the side panel opens and the column count
// changes.

/** Min tile edge — mirrors the grid's `minmax(98px,1fr)`. */
const GRID_MIN_TILE = 98;
/** Gap between tiles (both axes) — mirrors the grid `gap`. */
const GRID_GAP = 10;
/** Height reserved below each tile for the filename + dimensions caption. */
const GRID_CAPTION = 40;
/** Fixed height of one list-view row (48px thumb + padding + row gap). */
const LIST_ROW_SIZE = 72;
/** Horizontal padding of the scroll container (each side). */
const SCROLL_PAD_X = 22;
/** Top padding of the scroll container; the virtualized list starts below it,
 *  so it's the virtualizer's `scrollMargin`. */
const SCROLL_PAD_TOP = 20;
/** Rows rendered beyond the viewport, to avoid blank flashes while scrolling. */
const OVERSCAN = 4;

/** The virtualized asset grid/list body, including its empty states. Both
 *  views draw from one flat item list (pending placeholders first, then
 *  images), so counts and scroll stay consistent across the grid↔list toggle. */
export function AssetGrid({
  totalCount,
  pending,
  images,
  filter,
  view,
  panelOpen,
  dims,
  selectMode,
  selectedPaths,
  selectedPath,
  onSelectImage,
  onLoad,
  srcPathOf,
  isAi,
  onUploadClick,
}: {
  totalCount: number;
  pending: Generation[];
  images: ImageEntry[];
  filter: AssetFilter;
  view: AssetView;
  panelOpen: boolean;
  dims: Record<string, Dims>;
  selectMode: boolean;
  selectedPaths: Set<string>;
  selectedPath: string | null;
  onSelectImage: (path: string) => void;
  onLoad: (path: string, w: number, h: number) => void;
  srcPathOf: (gen: Generation) => string | undefined;
  isAi: (path: string) => boolean;
  onUploadClick: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // `panelOpen` resizes the scroll container in the same commit; pass it so the
  // width (and thus column count) is re-measured before paint, avoiding a
  // one-frame flash of mis-sized tiles when the detail panel toggles.
  const contentWidth = useContainerWidth(scrollRef, SCROLL_PAD_X * 2, panelOpen);
  const columns = Math.max(
    1,
    Math.floor((contentWidth + GRID_GAP) / (GRID_MIN_TILE + GRID_GAP))
  );
  const tileWidth = (contentWidth - (columns - 1) * GRID_GAP) / columns;
  const gridRowSize = tileWidth + GRID_CAPTION + GRID_GAP;

  const items = useMemo<Item[]>(
    () => [
      ...pending.map((gen) => ({ kind: "pending" as const, gen })),
      ...images.map((img) => ({ kind: "image" as const, img })),
    ],
    [pending, images]
  );

  const isGrid = view === "grid";
  const rowCount = isGrid ? Math.ceil(items.length / columns) : items.length;
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (isGrid ? gridRowSize : LIST_ROW_SIZE),
    overscan: OVERSCAN,
    scrollMargin: SCROLL_PAD_TOP,
  });
  // Recompute row offsets when the row model changes (view toggle, column count,
  // or computed row height after a resize).
  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowVirtualizer, isGrid, gridRowSize, columns]);

  return (
    <div
      ref={scrollRef}
      style={{
        overflow: "auto",
        padding: `${SCROLL_PAD_TOP}px ${SCROLL_PAD_X}px 32px`,
        minWidth: 0,
        width: panelOpen ? "476px" : "100%",
      }}
    >
      {totalCount === 0 ? (
        <div
          style={{
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            color: "var(--ink-400)",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 13, color: "var(--ink-500)" }}>Belum ada aset.</div>
          <div style={{ fontSize: 12 }}>
            Unggah gambar produk untuk membuat varian pertama.
          </div>
          <div style={{ marginTop: 4 }}>
            <Button variant="primary" onClick={onUploadClick}>
              Unggah gambar
            </Button>
          </div>
        </div>
      ) : items.length === 0 ? (
        <div
          style={{
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--ink-400)",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 13, color: "var(--ink-500)" }}>
            {filter === "source"
              ? "Tidak ada gambar sumber."
              : filter === "novariant"
              ? "Semua gambar sumber sudah punya varian."
              : "Belum ada gambar AI."}
          </div>
        </div>
      ) : (
        <div
          style={{
            height: rowVirtualizer.getTotalSize(),
            position: "relative",
            width: "100%",
          }}
        >
          {rowVirtualizer.getVirtualItems().map((vr) => {
            // `scrollMargin` (the container's top padding) is baked into
            // `vr.start`; subtract it to position within the sizer.
            const offset = vr.start - SCROLL_PAD_TOP;
            if (isGrid) {
              const start = vr.index * columns;
              const rowItems = items.slice(start, start + columns);
              return (
                <div
                  key={vr.key}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${offset}px)`,
                    display: "grid",
                    gridTemplateColumns: `repeat(${columns}, minmax(0,1fr))`,
                    gap: GRID_GAP,
                    alignContent: "start",
                  }}
                >
                  {rowItems.map((it) =>
                    it.kind === "pending" ? (
                      <PendingCard key={it.gen.id} srcPath={srcPathOf(it.gen)} />
                    ) : (
                      <ImageCard
                        key={it.img.path}
                        img={it.img}
                        selected={
                          selectMode
                            ? selectedPaths.has(it.img.path)
                            : it.img.path === selectedPath
                        }
                        dim={dims[it.img.path]}
                        onSelect={onSelectImage}
                        onLoad={onLoad}
                      />
                    )
                  )}
                </div>
              );
            }
            const it = items[vr.index];
            return (
              <div
                key={vr.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${offset}px)`,
                  paddingBottom: 6,
                }}
              >
                {it.kind === "pending" ? (
                  <PendingRow srcPath={srcPathOf(it.gen)} />
                ) : (
                  <ImageRow
                    img={it.img}
                    isAi={isAi(it.img.path)}
                    selected={
                      selectMode
                        ? selectedPaths.has(it.img.path)
                        : it.img.path === selectedPath
                    }
                    dim={dims[it.img.path]}
                    onSelect={onSelectImage}
                    onLoad={onLoad}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
