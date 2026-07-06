import {
  useRef,
  useState,
  useCallback,
  useMemo,
  useEffect,
  useLayoutEffect,
  memo,
  type ReactNode,
  type RefObject,
} from "react";
import { Link, useLocation } from "react-router";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  createPrediction,
  createPredictions,
  deleteImage,
  saveImage,
  getActiveProvider,
  listProviders,
  hasApiKey,
  type ImageEntry,
  type Generation,
} from "../lib/tauri";
import {
  imagesQuery,
  generationsQuery,
  deriveGenerations,
} from "../lib/queries";
import { GENERATION_TEMPLATES } from "../lib/templates";
import { Button, ImageViewer } from "../root";

// ---------- helpers ----------

type Dims = { w: number; h: number };

/** Origin filter for the asset grid: everything, uploaded sources, AI output,
 *  or source images that haven't produced any AI variant yet. */
type AssetFilter = "all" | "source" | "ai" | "novariant";
/** Layout for the asset library: tile grid or detailed row list. */
type AssetView = "grid" | "list";
/** Sort key for the asset grid: date added or display name. */
type SortKey = "date" | "name";
/** Sort direction. */
type SortDir = "asc" | "desc";

/** The four sort states offered by the dropdown, in menu order. Each maps a
 *  stable `value` (encoded `key-dir`) to its key, direction, and label. */
const SORT_OPTIONS: {
  value: string;
  label: string;
  key: SortKey;
  dir: SortDir;
}[] = [
  { value: "date-desc", label: "Terbaru", key: "date", dir: "desc" },
  { value: "date-asc", label: "Terlama", key: "date", dir: "asc" },
  { value: "name-asc", label: "Nama A–Z", key: "name", dir: "asc" },
  { value: "name-desc", label: "Nama Z–A", key: "name", dir: "desc" },
];

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1).replace(".", ",") + " MB";
  }
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

function fmtDate(seconds: number): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function kindOf(filename: string): string {
  const m = filename.match(/\.([^.]+)$/);
  return (m ? m[1] : "IMG").toUpperCase();
}

/** The name shown and searched for an image: its human `title` when present
 *  (uploads keep their original picked name; seeded files use their on-disk
 *  name), falling back to the on-disk `filename` (a uuid for new uploads, or a
 *  real name on legacy/pre-title rows). */
function displayName(img: ImageEntry): string {
  return img.title ?? img.filename;
}

// ---------- virtualized grid/list geometry ----------
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

/** The content-box width of a scroll container (its `clientWidth` minus
 *  horizontal padding). Tracked live via a `ResizeObserver` for gradual changes
 *  (window resize), and re-measured *synchronously* whenever `watch` changes —
 *  e.g. the side panel opening/closing, which resizes the container in the same
 *  commit. The synchronous re-measure (a layout effect, before paint) keeps the
 *  computed column count from lagging the container's new width by a frame,
 *  which would otherwise flash mis-sized tiles. */
function useContainerWidth(
  ref: RefObject<HTMLElement | null>,
  horizontalPad: number,
  watch: unknown
): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(0, el.clientWidth - horizontalPad));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, horizontalPad]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setWidth(Math.max(0, el.clientWidth - horizontalPad));
  }, [ref, horizontalPad, watch]);
  return width;
}

/** Largest edge (px) we keep for an uploaded source image. Anything bigger is
 *  downscaled — a full-res photo re-encoded to PNG produces a huge payload that
 *  is slow to encode and to ship across the `invoke()` bridge, without helping
 *  generation quality. Bump this if you need more source detail. */
const MAX_UPLOAD_DIMENSION = 2048;

/** Normalize a picked file to a PNG data URI without freezing the UI: decode
 *  off the main thread (`createImageBitmap`), downscale oversized images, and
 *  encode asynchronously (`toBlob`) instead of the synchronous `toDataURL`. */
function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("Gagal membaca gambar."));
    createImageBitmap(file)
      .then((bitmap) => {
        const scale = Math.min(
          1,
          MAX_UPLOAD_DIMENSION / Math.max(bitmap.width, bitmap.height)
        );
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
        bitmap.close();
        canvas.toBlob((blob) => {
          if (!blob) {
            fail();
            return;
          }
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result as string);
          fr.onerror = fail;
          fr.readAsDataURL(blob);
        }, "image/png");
      })
      .catch(fail);
  });
}

const ImageCard = memo(function ImageCard({
  img,
  selected,
  dim,
  onSelect,
  onLoad,
}: {
  img: ImageEntry;
  selected: boolean;
  dim: Dims | undefined;
  onSelect: (path: string) => void;
  onLoad: (path: string, w: number, h: number) => void;
}) {
  return (
    <div
      onClick={() => onSelect(img.path)}
      style={{ cursor: "pointer", position: "relative" }}
    >
      <div
        style={{
          position: "relative",
          aspectRatio: "1",
          borderRadius: "var(--r-card)",
          overflow: "hidden",
          border: "1px solid var(--line-3)",
          background: "var(--fill-1)",
        }}
      >
        <img
          src={convertFileSrc(img.path)}
          alt={displayName(img)}
          loading="lazy"
          onLoad={(e) => {
            const el = e.currentTarget;
            onLoad(img.path, el.naturalWidth, el.naturalHeight);
          }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
        <span
          style={{
            position: "absolute",
            bottom: 7,
            right: 7,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: ".02em",
            padding: "2px 5px",
            borderRadius: "var(--r-badge-sm)",
            background: "rgba(255,255,255,.92)",
            color: "var(--ink-700)",
          }}
        >
          {kindOf(img.filename)}
        </span>
        {selected && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              border: "1.5px solid var(--indigo-500)",
              borderRadius: "var(--r-card)",
              boxShadow: "0 0 0 1.5px var(--indigo-100)",
            }}
          />
        )}
      </div>
      <div
        style={{
          marginTop: 7,
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          fontWeight: 500,
          color: "var(--ink-700)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {displayName(img)}
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--ink-400)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {dim ? `${dim.w}\u00d7${dim.h}` : "\u00a0"}
      </div>
    </div>
  );
});

/** An in-progress generation: the source image dimmed under a spinning icon,
 *  shown until polling replaces it with the finished result. */
const PendingCard = memo(function PendingCard({
  srcPath,
}: {
  srcPath?: string;
}) {
  return (
    <div style={{ position: "relative" }}>
      <div
        style={{
          position: "relative",
          aspectRatio: "1",
          borderRadius: "var(--r-card)",
          overflow: "hidden",
          border: "1px solid var(--line-3)",
          background: "var(--fill-1)",
        }}
      >
        {srcPath && (
          <img
            src={convertFileSrc(srcPath)}
            alt=""
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              opacity: 0.35,
            }}
          />
        )}
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg
            className="assets-spin"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            style={{ color: "var(--indigo-500)" }}
          >
            <path
              d="M21 12a9 9 0 1 1-6.219-8.56"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </svg>
        </div>
      </div>
      <div
        style={{
          marginTop: 7,
          fontSize: 11.5,
          fontWeight: 500,
          color: "var(--ink-400)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        Menghasilkan…
      </div>
    </div>
  );
});

/** A generated variant shown in the detail panel's lineage section. Succeeded →
 *  clickable thumbnail (opens that variant); pending → spinner over the dimmed
 *  source; failed → a warning tile carrying the error message. */
const VariantTile = memo(function VariantTile({
  gen,
  srcPath,
  onOpen,
}: {
  gen: Generation;
  srcPath?: string;
  onOpen: (path: string) => void;
}) {
  const clickable = gen.status === "succeeded" && !!gen.output_path;
  return (
    <div
      onClick={clickable ? () => onOpen(gen.output_path!) : undefined}
      title={gen.status === "failed" ? gen.error ?? "Gagal" : gen.prompt}
      style={{
        position: "relative",
        aspectRatio: "1",
        borderRadius: "var(--r-card)",
        overflow: "hidden",
        border: "1px solid var(--line-3)",
        background: "var(--fill-1)",
        cursor: clickable ? "pointer" : "default",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {gen.status === "succeeded" && gen.output_path && (
        <img
          src={convertFileSrc(gen.output_path)}
          alt=""
          loading="lazy"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      )}
      {(gen.status === "pending" || gen.status === "queued") && (
        <>
          {srcPath && (
            <img
              src={convertFileSrc(srcPath)}
              alt=""
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
                opacity: 0.35,
              }}
            />
          )}
          <svg
            className="assets-spin"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            style={{ color: "var(--indigo-500)", position: "relative" }}
          >
            <path
              d="M21 12a9 9 0 1 1-6.219-8.56"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </svg>
        </>
      )}
      {gen.status === "failed" && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
            padding: 6,
            textAlign: "center",
          }}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            style={{ color: "#dc2626" }}
          >
            <path
              d="M12 3.5l9 16H3l9-16Z M12 10v4 M12 17.4v.1"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span
            style={{
              fontSize: 9.5,
              lineHeight: 1.25,
              color: "#b91c1c",
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
            }}
          >
            {gen.error ?? "Gagal"}
          </span>
        </div>
      )}
    </div>
  );
});

/** A single image rendered as a detailed row for the list view: thumbnail,
 *  filename with a Sumber/AI origin badge, and a metadata line. */
const ImageRow = memo(function ImageRow({
  img,
  isAi,
  selected,
  dim,
  onSelect,
  onLoad,
}: {
  img: ImageEntry;
  isAi: boolean;
  selected: boolean;
  dim: Dims | undefined;
  onSelect: (path: string) => void;
  onLoad: (path: string, w: number, h: number) => void;
}) {
  return (
    <div
      onClick={() => onSelect(img.path)}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 10px",
        borderRadius: "var(--r-card)",
        border: selected
          ? "1.5px solid var(--indigo-500)"
          : "1px solid var(--line-3)",
        boxShadow: selected ? "0 0 0 1.5px var(--indigo-100)" : "none",
        background: "var(--surface-0)",
        cursor: "pointer",
      }}
    >
      <div
        style={{
          position: "relative",
          width: 48,
          height: 48,
          flexShrink: 0,
          borderRadius: "var(--r-badge-sm)",
          overflow: "hidden",
          border: "1px solid var(--line-3)",
          background: "var(--fill-1)",
        }}
      >
        <img
          src={convertFileSrc(img.path)}
          alt={displayName(img)}
          loading="lazy"
          onLoad={(e) => {
            const el = e.currentTarget;
            onLoad(img.path, el.naturalWidth, el.naturalHeight);
          }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--ink-900)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {displayName(img)}
          </span>
          <span
            style={{
              flexShrink: 0,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: ".02em",
              padding: "2px 5px",
              borderRadius: "var(--r-badge-sm)",
              color: isAi ? "var(--indigo-600)" : "var(--ink-500)",
              background: isAi ? "var(--indigo-100)" : "var(--fill-1)",
            }}
          >
            {isAi ? "AI" : "Sumber"}
          </span>
        </div>
        <div
          style={{
            marginTop: 3,
            fontSize: 11,
            color: "var(--ink-400)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {`${dim ? `${dim.w}×${dim.h}` : "…"} · ${fmtSize(
            img.size_bytes
          )} · ${fmtDate(img.created_at)}`}
        </div>
      </div>
    </div>
  );
});

/** In-progress generation rendered as a list row, mirroring `PendingCard`. */
const PendingRow = memo(function PendingRow({ srcPath }: { srcPath?: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 10px",
        borderRadius: "var(--r-card)",
        border: "1px solid var(--line-3)",
        background: "var(--surface-0)",
      }}
    >
      <div
        style={{
          position: "relative",
          width: 48,
          height: 48,
          flexShrink: 0,
          borderRadius: "var(--r-badge-sm)",
          overflow: "hidden",
          border: "1px solid var(--line-3)",
          background: "var(--fill-1)",
        }}
      >
        {srcPath && (
          <img
            src={convertFileSrc(srcPath)}
            alt=""
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              opacity: 0.35,
            }}
          />
        )}
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg
            className="assets-spin"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            style={{ color: "var(--indigo-500)" }}
          >
            <path
              d="M21 12a9 9 0 1 1-6.219-8.56"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </svg>
        </div>
      </div>
      <div
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: "var(--ink-400)",
        }}
      >
        Menghasilkan…
      </div>
    </div>
  );
});

// ---------- route ----------

/** Prefetch the asset library into the query cache so navigation to "/" is
 *  gated on the first load only; repeat visits render instantly from cache. */
export const loader = (qc: QueryClient) => async () => {
  await Promise.all([
    qc.ensureQueryData(imagesQuery),
    qc.ensureQueryData(generationsQuery),
  ]);
  return null;
};

export default function Assets() {
  const fileRef = useRef<HTMLInputElement>(null);
  const location = useLocation();

  const qc = useQueryClient();
  const { data: images = [] } = useQuery(imagesQuery);
  const { data: generations = [] } = useQuery(generationsQuery);
  const { gens, childrenBySource, pending } = useMemo(
    () => deriveGenerations(generations),
    [generations]
  );

  // Image lookup by stable id, so pending placeholder tiles can render their
  // (dimmed) source image from `source_id` — the inline data URI is no longer
  // stored on generation rows.
  const imgById = useMemo(() => {
    const m = new Map<string, ImageEntry>();
    for (const img of images) m.set(img.id, img);
    return m;
  }, [images]);
  const srcPathOf = useCallback(
    (gen: Generation) =>
      gen.source_id ? imgById.get(gen.source_id)?.path : undefined,
    [imgById]
  );

  // View controls: filter by origin (source vs AI) and toggle grid/list layout.
  // Both are ephemeral view preferences — they reset to their defaults on remount.
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [view, setView] = useState<AssetView>("grid");
  // Sort order for the grid/list. Ephemeral like `filter`/`view`; defaults to
  // newest-first, matching the DB's `ORDER BY created_at DESC`. Key and
  // direction are picked together from the dropdown (`SORT_OPTIONS`).
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const changeSort = useCallback((value: string) => {
    const opt = SORT_OPTIONS.find((o) => o.value === value);
    if (!opt) return;
    setSortKey(opt.key);
    setSortDir(opt.dir);
  }, []);
  // Free-text search over the in-memory rows (title for sources, prompt for AI).
  // Client-side since virtualization keeps the whole dataset in memory.
  const [search, setSearch] = useState("");

  // An image is AI-generated iff it's the output of a generation (`gens` is keyed
  // by output path). Everything else is an uploaded source. The search query
  // matches an image's title/filename or, for AI outputs, its source prompt.
  // Memoized so filtering a large library doesn't re-run on every render.
  const query = search.trim().toLowerCase();
  const visibleImages = useMemo(
    () =>
      images.filter((img) => {
        const isAi = !!gens[img.path];
        if (filter === "ai" && !isAi) return false;
        if (filter === "source" && isAi) return false;
        // "Tanpa varian": uploaded sources that have no generation output yet.
        if (filter === "novariant") {
          if (isAi) return false;
          if ((childrenBySource[img.id]?.length ?? 0) > 0) return false;
        }
        if (query) {
          const name = displayName(img).toLowerCase();
          const prompt = gens[img.path]?.prompt?.toLowerCase() ?? "";
          if (!name.includes(query) && !prompt.includes(query)) return false;
        }
        return true;
      }),
    [images, gens, childrenBySource, filter, query]
  );
  // Pending tiles are always in-flight AI generations — hide them under
  // source-only filters ("source"/"novariant"), and while searching (they have
  // no title/prompt to match yet).
  const visiblePending = useMemo(
    () =>
      filter === "source" || filter === "novariant" || query ? [] : pending,
    [filter, query, pending]
  );

  // Sort the filtered images. Pending tiles are pinned first (see `items`) and
  // never sorted. Name uses a locale-aware, case-insensitive, numeric compare
  // (id locale, matching the app's date formatting) with `created_at` desc as a
  // stable tie-breaker.
  const sortedImages = useMemo(() => {
    const sign = sortDir === "asc" ? 1 : -1;
    const sorted = [...visibleImages];
    sorted.sort((a, b) => {
      if (sortKey === "name") {
        const cmp = displayName(a).localeCompare(displayName(b), "id", {
          sensitivity: "base",
          numeric: true,
        });
        if (cmp !== 0) return cmp * sign;
        return b.created_at - a.created_at;
      }
      const cmp = (a.created_at - b.created_at) * sign;
      if (cmp !== 0) return cmp;
      return b.created_at - a.created_at;
    });
    return sorted;
  }, [visibleImages, sortKey, sortDir]);

  /** Re-fetch after a mutation. `invalidateQueries` resolves once the refetch
   *  settles, so callers can safely select the newly-created asset afterward. */
  const refresh = useCallback(
    () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: imagesQuery.queryKey }),
        qc.invalidateQueries({ queryKey: generationsQuery.queryKey }),
      ]),
    [qc]
  );

  /** Optimistically drop just-enqueued generations into the cache so their
   *  placeholder tiles appear immediately, then kick the drain/refetch in the
   *  background. We deliberately do NOT await: a generations refetch runs
   *  `pollAndDrain`, which submits queued jobs to the provider (a slow network
   *  round-trip) — awaiting it would freeze the button on "Menghasilkan…" for
   *  the whole submit. The optimistic rows are `queued`, hence rendered as
   *  placeholders, and reconcile with the DB when the background refetch lands. */
  const enqueueGenerations = useCallback(
    (created: Generation[]) => {
      qc.setQueryData<Generation[]>(generationsQuery.queryKey, (old) =>
        old ? [...old, ...created] : created
      );
      void qc.invalidateQueries({ queryKey: generationsQuery.queryKey });
      void qc.invalidateQueries({ queryKey: imagesQuery.queryKey });
    },
    [qc]
  );

  const [dims, setDims] = useState<Record<string, Dims>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Full-screen image lightbox: the resolved `<img src>` currently displayed, or
  // null when closed. Independent of `selectedPath` so closing it leaves the
  // detail-panel selection intact.
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);

  // Bulk-action selection: a Select mode where clicking tiles toggles membership
  // in `selectedPaths` (instead of opening the detail panel), and the right panel
  // becomes a bulk template picker that fans out across every selected image.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  const [variantOpen, setVariantOpen] = useState(false);
  const [variantPrompt, setVariantPrompt] = useState("");
  const [selectedTemplates, setSelectedTemplates] = useState<Set<string>>(
    new Set()
  );
  const [generating, setGenerating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The globally-selected provider drives which API key we read and send.
  const { data: providerCtx } = useQuery({
    queryKey: ["activeProvider"],
    queryFn: async () => {
      const [id, providers] = await Promise.all([
        getActiveProvider(),
        listProviders(),
      ]);
      const info = providers.find((p) => p.id === id) ?? null;
      return { id, label: info?.label ?? id };
    },
    staleTime: 30_000,
  });
  const providerId = providerCtx?.id ?? "replicate";
  const providerLabel = providerCtx?.label ?? "AI";

  // Whether the active provider has a key saved in the backend. Drives the
  // "set your key" banner and gates generation.
  const { data: apiKey } = useQuery({
    queryKey: ["hasApiKey", providerId],
    queryFn: () => hasApiKey(providerId),
    staleTime: 30_000,
  });

  const selectAsset = useCallback((path: string) => {
    setSelectedPath(path);
    setVariantOpen(false);
    setVariantPrompt("");
    setSelectedTemplates(new Set());
    setError(null);
  }, []);

  const handleImageLoad = useCallback((path: string, w: number, h: number) => {
    setDims((prev) =>
      prev[path] ? prev : { ...prev, [path]: { w, h } }
    );
  }, []);

  // Images and generations are now separate queries, so a just-finished variant
  // (new image row) won't show in the grid until images refetch. When a
  // generation references an output not yet in the image list, invalidate images
  // to pull it in. Self-limiting: once refetched, the output is known and this
  // stops firing.
  useEffect(() => {
    const known = new Set(images.map((i) => i.path));
    const hasUnknownOutput = generations.some(
      (g) => g.output_path && !known.has(g.output_path)
    );
    if (hasUnknownOutput) {
      qc.invalidateQueries({ queryKey: imagesQuery.queryKey });
    }
  }, [generations, images, qc]);

  // When the Generations page opens a finished variant, it navigates here with
  // the target path in router state; select it once, then clear the state so a
  // later back-navigation doesn't reselect it.
  useEffect(() => {
    const st = location.state as { selectPath?: string } | null;
    if (st?.selectPath) {
      selectAsset(st.selectPath);
      window.history.replaceState({}, "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  // Toggle Select (bulk) mode. Entering it closes the single-asset detail; both
  // transitions reset the multi-selection and any picked templates.
  function toggleSelectMode() {
    setSelectMode((m) => !m);
    setSelectedPaths(new Set());
    setSelectedTemplates(new Set());
    setSelectedPath(null);
    setVariantOpen(false);
    setError(null);
  }

  const togglePathSelection = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  function close() {
    setSelectedPath(null);
    setVariantOpen(false);
    setVariantPrompt("");
    setSelectedTemplates(new Set());
  }

  function toggleVariant() {
    setVariantOpen((v) => !v);
    setVariantPrompt("");
  }

  function toggleTemplate(id: string) {
    setSelectedTemplates((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function onUploadClick() {
    fileRef.current?.click();
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !file.type.startsWith("image/")) return;
    setError(null);
    try {
      const dataUri = await fileToDataUri(file);
      // Preserve the original picked name as the searchable/displayed title; the
      // file on disk is a collision-free uuid.
      const saved = await saveImage(dataUri, file.name);
      await refresh();
      setSelectedPath(saved.path);
      setVariantOpen(true);
      setVariantPrompt("");
    } catch (err) {
      setError(String(err));
    }
  }

  async function generate() {
    if (generating) return;
    if (!apiKey) {
      setError(`Kunci API ${providerLabel} belum diatur.`);
      return;
    }
    if (!variantPrompt.trim()) return;
    if (!selectedPath) return;

    setGenerating(true);
    setError(null);
    try {
      // Enqueue and return immediately. The backend records a `queued` row keyed
      // by the source image id; the drainer submits it to the provider later.
      const gen = await createPrediction(
        variantPrompt.trim(),
        providerId,
        selectedImage?.id
      );
      enqueueGenerations([gen]);
      setVariantOpen(false);
      setVariantPrompt("");
    } catch (err) {
      setError(String(err));
    } finally {
      setGenerating(false);
    }
  }

  async function generateFromTemplates() {
    if (generating || selectedTemplates.size === 0) return;
    if (!apiKey) {
      setError(`Kunci API ${providerLabel} belum diatur.`);
      return;
    }
    if (!selectedPath) return;

    setGenerating(true);
    setError(null);
    try {
      const prompts = GENERATION_TEMPLATES.filter((t) =>
        selectedTemplates.has(t.id)
      ).map((t) => t.prompt);
      // One backend call enqueues one queued generation per template.
      const gens = await createPredictions(prompts, providerId, selectedImage?.id);
      enqueueGenerations(gens);
      setSelectedTemplates(new Set());
      setVariantOpen(false);
      setVariantPrompt("");
    } catch (err) {
      setError(String(err));
    } finally {
      setGenerating(false);
    }
  }

  /** Bulk generate: for every selected image, enqueue each selected template.
   *  N images × M templates = N×M queued jobs, drained under the concurrency cap.
   *  Afterwards, exit Select mode and clear the selection. */
  async function generateBulk() {
    if (generating || selectedTemplates.size === 0 || selectedPaths.size === 0) {
      return;
    }
    if (!apiKey) {
      setError(`Kunci API ${providerLabel} belum diatur.`);
      return;
    }

    setGenerating(true);
    setError(null);
    try {
      const prompts = GENERATION_TEMPLATES.filter((t) =>
        selectedTemplates.has(t.id)
      ).map((t) => t.prompt);
      const all: Generation[] = [];
      for (const path of selectedPaths) {
        const img = images.find((i) => i.path === path);
        if (!img) continue;
        all.push(...(await createPredictions(prompts, providerId, img.id)));
      }
      enqueueGenerations(all);
      setSelectMode(false);
      setSelectedPaths(new Set());
      setSelectedTemplates(new Set());
    } catch (err) {
      setError(String(err));
    } finally {
      setGenerating(false);
    }
  }

  async function del() {
    if (!selectedPath || deleting) return;
    const confirmed = await ask(
      "Hapus aset ini secara permanen? Tindakan ini tidak bisa dibatalkan.",
      { title: "Hapus aset", kind: "warning" }
    );
    if (!confirmed) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteImage(selectedPath);
      await refresh();
      setSelectedPath(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setDeleting(false);
    }
  }

  const selectedImage = selectedPath
    ? images.find((i) => i.path === selectedPath) ?? null
    : null;
  const hasSelection = !!selectedImage;

  const detail = selectedImage
    ? {
        preview: convertFileSrc(selectedImage.path),
        name: displayName(selectedImage),
        kind: kindOf(selectedImage.filename),
        dims: dims[selectedImage.path]
          ? `${dims[selectedImage.path].w}×${dims[selectedImage.path].h}`
          : "…",
        sizeText: fmtSize(selectedImage.size_bytes),
        added: fmtDate(selectedImage.created_at),
        prompt: gens[selectedImage.path]?.prompt,
      }
      : null;

  // Direct children: generations made with the selected image as their source.
  const children = selectedImage
    ? childrenBySource[selectedImage.id] ?? []
    : [];

  // The source (parent) image this one was generated from, when the selected
  // image is itself a generation output and its source still exists.
  const sourceGen = selectedImage ? gens[selectedImage.path] : undefined;
  const sourceImage = sourceGen?.source_id
    ? images.find((i) => i.id === sourceGen.source_id) ?? null
    : null;

  const generateDisabled = generating || !variantPrompt.trim();
  const generateLabel = generating ? "Menghasilkan…" : "Hasilkan varian";

  // The right panel shows the bulk picker in Select mode (once ≥1 image is
  // picked), otherwise the single-asset detail. Both shrink the grid.
  const bulkOpen = selectMode && selectedPaths.size > 0;
  const panelOpen = bulkOpen || (hasSelection && !!detail);
  const bulkJobCount = selectedPaths.size * selectedTemplates.size;

  // --- Virtualization: render only the visible rows of the grid/list. Both
  // views draw from one flat item list (pending placeholders first, then
  // images), so counts and scroll stay consistent across the grid↔list toggle.
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

  type Item =
    | { kind: "pending"; gen: Generation }
    | { kind: "image"; img: ImageEntry };
  const items = useMemo<Item[]>(
    () => [
      ...visiblePending.map((gen) => ({ kind: "pending" as const, gen })),
      ...sortedImages.map((img) => ({ kind: "image" as const, img })),
    ],
    [visiblePending, sortedImages]
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
    <>
      {viewerSrc && (
        <ImageViewer src={viewerSrc} onClose={() => setViewerSrc(null)} />
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        onChange={onFilePicked}
        style={{ display: "none" }}
      />
        <div
          style={{
            height: 52,
            flexShrink: 0,
            borderBottom: "1px solid var(--line-1)",
            display: "flex",
            alignItems: "center",
            padding: "0 20px",
            gap: 12,
            // Below the window min-width the controls can't all fit; scroll the
            // toolbar horizontally instead of clipping them off the right edge.
            overflowX: "auto",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-800)", flexShrink: 0 }}>Daftar Gambar</div>
          <span
            style={{
              minWidth: 18,
              height: 18,
              padding: "0 6px",
              borderRadius: 9999,
              background: "var(--fill-1)",
              color: "var(--ink-500)",
              fontSize: 11,
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {visibleImages.length}
          </span>

          <Segmented
            options={[
              { value: "all", label: "Semua" },
              { value: "source", label: "Sumber" },
              { value: "ai", label: "AI" },
              { value: "novariant", label: "Tanpa Varian" },
            ]}
            value={filter}
            onChange={setFilter}
          />

          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari nama atau prompt…"
            style={{
              height: 26,
              width: 200,
              flexShrink: 0,
              border: "1px solid var(--line-3)",
              borderRadius: "var(--r-control)",
              padding: "0 10px",
              fontFamily: "var(--font-ui)",
              fontSize: 12,
              color: "var(--ink-800)",
              background: "var(--surface-0)",
              outline: "none",
            }}
          />

          <div style={{ flex: 1 }} />

          <select
            value={`${sortKey}-${sortDir}`}
            onChange={(e) => changeSort(e.target.value)}
            title="Urutkan"
            style={{
              height: 26,
              flexShrink: 0,
              border: "1px solid var(--line-3)",
              borderRadius: "var(--r-control)",
              padding: "0 8px",
              fontFamily: "var(--font-ui)",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--ink-700)",
              background: "var(--surface-0)",
              cursor: "pointer",
              outline: "none",
            }}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <Segmented
            options={[
              { value: "grid", label: <GridIcon />, title: "Tampilan petak" },
              { value: "list", label: <ListIcon />, title: "Tampilan daftar" },
            ]}
            value={view}
            onChange={setView}
          />

          <Button
            variant={selectMode ? "primary" : "outline"}
            onClick={toggleSelectMode}
          >
            {selectMode
              ? selectedPaths.size > 0
                ? `${selectedPaths.size} dipilih`
                : "Selesai"
              : "Pilih"}
          </Button>

          <Button variant="outline" onClick={onUploadClick}>
            <svg width="14" height="14" viewBox="0 0 15 15">
              <path
                d="M7.5 9.6V2.4M4.6 5.1 7.5 2.2l2.9 2.9"
                stroke="var(--ink-700)"
                strokeWidth={1.3}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M2.6 9.4v2.2a1 1 0 0 0 1 1h7.8a1 1 0 0 0 1-1V9.4"
                stroke="var(--ink-700)"
                strokeWidth={1.3}
                fill="none"
                strokeLinecap="round"
              />
            </svg>
            Unggah gambar
          </Button>
        </div>

        {!apiKey && (
          <div
            style={{
              padding: "9px 20px",
              background: "var(--indigo-100)",
              borderBottom: "1px solid var(--line-1)",
              fontSize: 12,
              color: "var(--ink-700)",
            }}
          >
            Kunci API {providerLabel} belum diatur — pembuatan varian butuh
            kunci.{" "}
            <Link
              to="/settings"
              style={{ color: "var(--indigo-600)", fontWeight: 600 }}
            >
              Atur sekarang
            </Link>
            .
          </div>
        )}

        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          {/* Grid */}
          <div
            ref={scrollRef}
            style={{
              overflow: "auto",
              padding: `${SCROLL_PAD_TOP}px ${SCROLL_PAD_X}px 32px`,
              minWidth: 0,
              width: panelOpen ? "476px" : "100%",
            }}
          >
            {images.length === 0 ? (
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
            ) : visibleImages.length === 0 && visiblePending.length === 0 ? (
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
                            <PendingCard
                              key={it.gen.id}
                              srcPath={srcPathOf(it.gen)}
                            />
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
                              onSelect={
                                selectMode ? togglePathSelection : selectAsset
                              }
                              onLoad={handleImageLoad}
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
                          isAi={!!gens[it.img.path]}
                          selected={
                            selectMode
                              ? selectedPaths.has(it.img.path)
                              : it.img.path === selectedPath
                          }
                          dim={dims[it.img.path]}
                          onSelect={
                            selectMode ? togglePathSelection : selectAsset
                          }
                          onLoad={handleImageLoad}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Bulk panel — template picker fanned across the multi-selection */}
          {bulkOpen && (
            <div
              style={{
                flex: 1,
                minWidth: 380,
                borderLeft: "1px solid var(--line-1)",
                background: "var(--surface-1)",
                display: "flex",
                flexDirection: "column",
                overflow: "auto",
              }}
            >
              <div
                style={{
                  padding: "16px 18px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  borderBottom: "1px solid var(--line-1)",
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-800)" }}>
                  Aksi massal · {selectedPaths.size} gambar
                </span>
                <div
                  onClick={() => setSelectedPaths(new Set())}
                  style={{
                    fontSize: 12,
                    color: "var(--indigo-600)",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Bersihkan
                </div>
              </div>

              <div style={{ padding: "16px 18px" }}>
                <div
                  style={{
                    fontSize: 10.5,
                    fontWeight: 600,
                    letterSpacing: ".04em",
                    color: "var(--ink-350)",
                    textTransform: "uppercase",
                    marginBottom: 10,
                  }}
                >
                  Pilih templat
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill,minmax(120px,1fr))",
                    gap: 10,
                    marginBottom: 14,
                  }}
                >
                  {GENERATION_TEMPLATES.map((t) => {
                    const isSelected = selectedTemplates.has(t.id);
                    return (
                      <div
                        key={t.id}
                        onClick={() => toggleTemplate(t.id)}
                        style={{ cursor: "pointer" }}
                      >
                        <div
                          style={{
                            position: "relative",
                            aspectRatio: "1",
                            borderRadius: "var(--r-card)",
                            overflow: "hidden",
                            border: "1px solid var(--line-3)",
                            background: "var(--fill-1)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          {t.imagePreview ? (
                            <img
                              src={t.imagePreview}
                              alt={t.name}
                              style={{
                                position: "absolute",
                                inset: 0,
                                width: "100%",
                                height: "100%",
                                objectFit: "cover",
                              }}
                            />
                          ) : (
                            <svg
                              width="24"
                              height="24"
                              viewBox="0 0 24 24"
                              fill="none"
                              style={{ color: "var(--ink-350)" }}
                            >
                              <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
                              <circle cx="8.5" cy="9.5" r="1.5" fill="currentColor" />
                              <path d="M4 17l5-5 4 4 3-3 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                          {isSelected && (
                            <div
                              style={{
                                position: "absolute",
                                inset: 0,
                                border: "1.5px solid var(--indigo-500)",
                                borderRadius: "var(--r-card)",
                                boxShadow: "0 0 0 1.5px var(--indigo-100)",
                              }}
                            />
                          )}
                        </div>
                        <div
                          style={{
                            marginTop: 6,
                            fontSize: 11.5,
                            fontWeight: 600,
                            color: isSelected ? "var(--indigo-600)" : "var(--ink-700)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {t.name}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div
                  style={{
                    fontSize: 12,
                    color: "var(--ink-500)",
                    marginBottom: 12,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {selectedPaths.size} gambar × {selectedTemplates.size} templat ={" "}
                  <strong style={{ color: "var(--ink-800)" }}>{bulkJobCount}</strong> tugas
                </div>

                <Button
                  variant="primary"
                  disabled={generating || bulkJobCount === 0}
                  onClick={generateBulk}
                >
                  <svg width="14" height="14" viewBox="0 0 15 15">
                    <path
                      d="M7.5 1.8l1.3 3.4 3.4 1.3-3.4 1.3L7.5 11.2 6.2 7.8 2.8 6.5 6.2 5.2Z"
                      fill="#fff"
                    />
                  </svg>
                  {generating ? "Mengantre…" : `Hasilkan ${bulkJobCount} varian`}
                </Button>

                {error && (
                  <div
                    style={{
                      marginTop: 12,
                      fontSize: 11.5,
                      color: "var(--red-600)",
                      lineHeight: 1.45,
                    }}
                  >
                    {error}
                  </div>
                )}

                <div
                  style={{
                    marginTop: 12,
                    fontSize: 11,
                    color: "var(--ink-400)",
                    lineHeight: 1.45,
                  }}
                >
                  Tugas masuk antrean dan diproses maksimal 3 sekaligus. Pantau di
                  halaman Antrean.
                </div>
              </div>
            </div>
          )}

          {/* Detail panel */}
          {!selectMode && hasSelection && detail && (
            <div
              style={{
                flex: 1,
                minWidth: 380,
                borderLeft: "1px solid var(--line-1)",
                background: "var(--surface-1)",
                display: "flex",
                flexDirection: "column",
                overflow: "auto",
              }}
            >
              <div
                style={{
                  padding: "16px 18px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  borderBottom: "1px solid var(--line-1)",
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-800)" }}>
                  Detail aset
                </span>
                <div
                  onClick={close}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 6,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    color: "var(--ink-400)",
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12">
                    <path
                      d="M2.5 2.5l7 7M9.5 2.5l-7 7"
                      stroke="currentColor"
                      strokeWidth={1.4}
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              </div>

              <div style={{ padding: "16px 18px" }}>
                <div
                  onClick={() => setViewerSrc(detail.preview)}
                  style={{
                    position: "relative",
                    height: 230,
                    borderRadius: "var(--r-card)",
                    overflow: "hidden",
                    border: "1px solid var(--line-3)",
                    background: "var(--fill-1)",
                    cursor: "zoom-in",
                  }}
                >
                  <img
                    src={detail.preview}
                    alt={detail.name}
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: "100%",
                      height: "100%",
                      objectFit: "contain",
                    }}
                  />
                </div>

                <div
                  style={{
                    marginTop: 14,
                    fontFamily: "var(--font-mono)",
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "var(--ink-900)",
                    wordBreak: "break-all",
                  }}
                >
                  {detail.name}
                </div>

                <div
                  style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 9 }}
                >
                  <DetailRow label="Jenis">
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: ".02em",
                        padding: "2px 5px",
                        borderRadius: "var(--r-badge-sm)",
                        color: "var(--indigo-600)",
                        background: "var(--indigo-100)",
                      }}
                    >
                      {detail.kind}
                    </span>
                  </DetailRow>
                  <DetailRow label="Dimensi">
                    <Mono>{detail.dims} px</Mono>
                  </DetailRow>
                  <DetailRow label="Ukuran">
                    <Mono>{detail.sizeText}</Mono>
                  </DetailRow>
                  <DetailRow label="Ditambahkan">
                    <Mono>{detail.added}</Mono>
                  </DetailRow>
                </div>

                {(sourceImage || detail.prompt) && (
                  <div
                    style={{
                      marginTop: 14,
                      display: "flex",
                      flexDirection: "row",
                      gap: 12,
                      padding: 12,
                      borderRadius: "var(--r-control)",
                      border: "1px solid var(--line-3)",
                      background: "var(--fill-1)",
                    }}
                  >
                    {sourceImage && (
                      <div>
                        <div
                          style={{
                            fontSize: 11.5,
                            color: "var(--ink-500)",
                            marginBottom: 7,
                          }}
                        >
                          Sumber
                        </div>
                        <div
                          onClick={() => selectAsset(sourceImage.path)}
                          title={sourceImage.filename}
                          style={{
                            position: "relative",
                            width: 72,
                            height: 72,
                            borderRadius: "var(--r-card)",
                            overflow: "hidden",
                            border: "1px solid var(--line-3)",
                            background: "var(--fill-2, var(--fill-1))",
                            cursor: "pointer",
                          }}
                        >
                          <img
                            src={convertFileSrc(sourceImage.path)}
                            alt={sourceImage.filename}
                            loading="lazy"
                            style={{
                              position: "absolute",
                              inset: 0,
                              width: "100%",
                              height: "100%",
                              objectFit: "cover",
                            }}
                          />
                        </div>
                      </div>
                    )}

                    {detail.prompt && (
                      <div>
                        <div
                          style={{
                            fontSize: 11.5,
                            color: "var(--ink-500)",
                            marginBottom: 5,
                            padding: "0 10px",
                          }}
                        >
                          Prompt
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            color: "var(--ink-700)",
                            lineHeight: 1.45,
                            background: "var(--indigo-100)",
                            borderRadius: "var(--r-control)",
                            padding: "8px 10px",
                          }}
                        >
                          {detail.prompt}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {children.length > 0 && (
                  <div style={{ marginTop: 14 }}>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: "var(--ink-500)",
                        marginBottom: 7,
                      }}
                    >
                      Varian dihasilkan
                    </div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(3, 1fr)",
                        gap: 8,
                      }}
                    >
                      {children.map((g) => (
                        <VariantTile
                          key={g.id}
                          gen={g}
                          srcPath={selectedImage?.path}
                          onOpen={(path) => setViewerSrc(convertFileSrc(path))}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div style={{ height: 1, background: "var(--line-1)", margin: "2px 0" }} />

              {/* Variant generation */}
              <div style={{ padding: "16px 18px" }}>
                <div
                  style={{
                    fontSize: 10.5,
                    fontWeight: 600,
                    letterSpacing: ".04em",
                    color: "var(--ink-350)",
                    textTransform: "uppercase",
                    marginBottom: 10,
                  }}
                >
                  Buat varian
                </div>

                {/* Template picker — pick one or more, generate as a batch */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill,minmax(120px,1fr))",
                    gap: 10,
                    marginBottom: 12,
                  }}
                >
                  {GENERATION_TEMPLATES.map((t) => {
                    const isSelected = selectedTemplates.has(t.id);
                    return (
                      <div
                        key={t.id}
                        onClick={() => toggleTemplate(t.id)}
                        style={{ cursor: "pointer" }}
                      >
                        <div
                          style={{
                            position: "relative",
                            aspectRatio: "1",
                            borderRadius: "var(--r-card)",
                            overflow: "hidden",
                            border: "1px solid var(--line-3)",
                            background: "var(--fill-1)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          {t.imagePreview ? (
                            <img
                              src={t.imagePreview}
                              alt={t.name}
                              style={{
                                position: "absolute",
                                inset: 0,
                                width: "100%",
                                height: "100%",
                                objectFit: "cover",
                              }}
                            />
                          ) : (
                            <svg
                              width="24"
                              height="24"
                              viewBox="0 0 24 24"
                              fill="none"
                              style={{ color: "var(--ink-350)" }}
                            >
                              <rect
                                x="3"
                                y="4"
                                width="18"
                                height="16"
                                rx="2"
                                stroke="currentColor"
                                strokeWidth="1.5"
                              />
                              <circle
                                cx="8.5"
                                cy="9.5"
                                r="1.5"
                                fill="currentColor"
                              />
                              <path
                                d="M4 17l5-5 4 4 3-3 4 4"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                          {isSelected && (
                            <div
                              style={{
                                position: "absolute",
                                inset: 0,
                                border: "1.5px solid var(--indigo-500)",
                                borderRadius: "var(--r-card)",
                                boxShadow: "0 0 0 1.5px var(--indigo-100)",
                              }}
                            />
                          )}
                        </div>
                        <div
                          style={{
                            marginTop: 6,
                            fontSize: 11.5,
                            fontWeight: 600,
                            color: isSelected
                              ? "var(--indigo-600)"
                              : "var(--ink-700)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {t.name}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <Button
                  variant="primary"
                  disabled={generating || selectedTemplates.size === 0}
                  onClick={generateFromTemplates}
                >
                  <svg width="14" height="14" viewBox="0 0 15 15">
                    <path
                      d="M7.5 1.8l1.3 3.4 3.4 1.3-3.4 1.3L7.5 11.2 6.2 7.8 2.8 6.5 6.2 5.2Z"
                      fill="#fff"
                    />
                  </svg>
                  {generating
                    ? "Menghasilkan…"
                    : `Hasilkan ${selectedTemplates.size} varian`}
                </Button>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    margin: "16px 0 12px",
                    fontSize: 10.5,
                    fontWeight: 600,
                    letterSpacing: ".04em",
                    color: "var(--ink-350)",
                    textTransform: "uppercase",
                  }}
                >
                  <div style={{ flex: 1, height: 1, background: "var(--line-1)" }} />
                  atau prompt manual
                  <div style={{ flex: 1, height: 1, background: "var(--line-1)" }} />
                </div>

                {variantOpen ? (
                  <div>
                    <textarea
                      placeholder="Jelaskan perubahannya. mis. ganti latar jadi putih bersih, tambah bayangan lembut"
                      value={variantPrompt}
                      onChange={(e) => setVariantPrompt(e.target.value)}
                      style={{
                        width: "100%",
                        minHeight: 74,
                        resize: "none",
                        border: "1px solid var(--line-4)",
                        borderRadius: "var(--r-button)",
                        padding: "10px 11px",
                        fontFamily: "var(--font-ui)",
                        fontSize: 12,
                        color: "var(--ink-800)",
                        lineHeight: 1.45,
                        outline: "none",
                        background: "var(--surface-0)",
                      }}
                    />
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                      <Button variant="primary" disabled={generateDisabled} onClick={generate}>
                        <svg width="14" height="14" viewBox="0 0 15 15">
                          <path
                            d="M7.5 1.8l1.3 3.4 3.4 1.3-3.4 1.3L7.5 11.2 6.2 7.8 2.8 6.5 6.2 5.2Z"
                            fill="#fff"
                          />
                        </svg>
                        {generateLabel}
                      </Button>
                      <Button variant="ghost" disabled={generating} onClick={toggleVariant}>
                        Batal
                      </Button>
                    </div>
                    <div
                      style={{
                        marginTop: 9,
                        fontSize: 11,
                        color: "var(--ink-400)",
                        lineHeight: 1.45,
                      }}
                    >
                      Varian disimpan sebagai aset baru dan ditautkan ke gambar sumber.
                    </div>
                  </div>
                ) : (
                  <div
                    onClick={toggleVariant}
                    style={{
                      border: "1px dashed var(--line-5)",
                      borderRadius: "var(--r-button)",
                      padding: "13px 14px",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      cursor: "pointer",
                      background: "var(--indigo-100)",
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 15 15">
                      <path
                        d="M7.5 1.8l1.3 3.4 3.4 1.3-3.4 1.3L7.5 11.2 6.2 7.8 2.8 6.5 6.2 5.2Z"
                        fill="var(--indigo-500)"
                      />
                    </svg>
                    <div style={{ flex: 1, lineHeight: 1.3 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--indigo-600)" }}>
                        Buat varian dengan prompt
                      </div>
                      <div style={{ fontSize: 11, color: "var(--ink-500)" }}>
                        Hasilkan versi baru dari teks
                      </div>
                    </div>
                  </div>
                )}

                {error && (
                  <div
                    style={{
                      marginTop: 12,
                      fontSize: 11.5,
                      color: "var(--red-600)",
                      lineHeight: 1.45,
                    }}
                  >
                    {error}
                  </div>
                )}
              </div>

              <div style={{ flex: 1 }} />

              <div style={{ padding: "14px 18px", borderTop: "1px solid var(--line-1)" }}>
                  <Button variant="danger" disabled={deleting} onClick={del}>
                    <svg width="14" height="14" viewBox="0 0 15 15">
                      <path
                        d="M3 4h9M6 4V2.8h3V4M4.2 4l.6 8a1 1 0 0 0 1 .95h3.4a1 1 0 0 0 1-.95l.6-8"
                        stroke="var(--red-600)"
                        strokeWidth={1.2}
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    {deleting ? "Menghapus…" : "Hapus aset"}
                  </Button>
                </div>
            </div>
          )}
        </div>
    </>
  );
}

/** Inline segmented control: a pill group where one option is active. Generic
 *  over the option value so it drives both the origin filter and the view toggle. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: ReactNode; title?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        padding: 2,
        gap: 2,
        borderRadius: "var(--r-control)",
        background: "var(--fill-1)",
        border: "1px solid var(--line-3)",
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            title={opt.title}
            onClick={() => onChange(opt.value)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              minHeight: 22,
              padding: "0 9px",
              border: "none",
              borderRadius: "var(--r-badge-sm)",
              cursor: "pointer",
              fontSize: 11.5,
              fontWeight: 600,
              lineHeight: 1,
              color: active ? "var(--indigo-600)" : "var(--ink-500)",
              background: active ? "var(--surface-0)" : "transparent",
              boxShadow: active ? "0 1px 2px rgba(0,0,0,.06)" : "none",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 15 15" fill="none">
      <rect x="2" y="2" width="4.5" height="4.5" rx="1" fill="currentColor" />
      <rect x="8.5" y="2" width="4.5" height="4.5" rx="1" fill="currentColor" />
      <rect x="2" y="8.5" width="4.5" height="4.5" rx="1" fill="currentColor" />
      <rect x="8.5" y="8.5" width="4.5" height="4.5" rx="1" fill="currentColor" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 15 15" fill="none">
      <rect x="2" y="2.5" width="3" height="3" rx="0.7" fill="currentColor" />
      <rect x="2" y="9.5" width="3" height="3" rx="0.7" fill="currentColor" />
      <path
        d="M6.5 4h6.5M6.5 11h6.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <span style={{ fontSize: 11.5, color: "var(--ink-500)" }}>{label}</span>
      {children}
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11.5,
        color: "var(--ink-700)",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {children}
    </span>
  );
}
