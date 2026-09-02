import { useRef, useState, useCallback, useMemo, useEffect } from "react";
import { useLocation } from "react-router";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  createPrediction,
  createPredictions,
  deleteImage,
  deleteImages,
  saveImage,
  getActiveProvider,
  listProviders,
  hasApiKey,
  type ApiMode,
  type Generation,
  type ImageEntry,
} from "../../lib/tauri";
import {
  activeWorkspaceQuery,
  imagesQuery,
  generationsQuery,
  templatesQuery,
  deriveGenerations,
} from "../../lib/queries";
import { ImageViewer, useShell } from "../../root";
import { ApiKeyBanner } from "./ApiKeyBanner";
import { AssetGrid } from "./AssetGrid";
import { AssetToolbar } from "./AssetToolbar";
import { BulkPanel } from "./BulkPanel";
import { DetailPanel } from "./DetailPanel";
import { fileToDataUri } from "../../lib/image";
import { displayName } from "./helpers";
import type { AssetFilter, AssetView, Dims, SortDir, SortKey } from "./types";
import { SORT_OPTIONS } from "./helpers";

/** Prefetch the asset library into the query cache so navigation to "/" is
 *  gated on the first load only; repeat visits render instantly from cache. */
export const loader = (qc: QueryClient) => async () => {
  const ws = await qc.ensureQueryData(activeWorkspaceQuery);
  await Promise.all([
    qc.ensureQueryData(imagesQuery(ws.path)),
    qc.ensureQueryData(generationsQuery(ws.path)),
    qc.ensureQueryData(templatesQuery),
  ]);
  return null;
};

export default function Assets() {
  const fileRef = useRef<HTMLInputElement>(null);
  const location = useLocation();
  const { openSettings } = useShell();

  const qc = useQueryClient();
  const { data: activeWorkspace } = useQuery(activeWorkspaceQuery);
  const wsPath = activeWorkspace?.path;
  const { data: images = [] } = useQuery(imagesQuery(wsPath));
  const { data: generations = [] } = useQuery(generationsQuery(wsPath));
  const { data: savedTemplates = [] } = useQuery(templatesQuery);
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

  // Sort the filtered images. Pending tiles are pinned first (via `AssetGrid`)
  // and never sorted. Name uses a locale-aware, case-insensitive, numeric
  // compare (id locale, matching the app's date formatting) with `created_at`
  // desc as a stable tie-breaker.
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
        qc.invalidateQueries({ queryKey: imagesQuery(wsPath).queryKey }),
        qc.invalidateQueries({ queryKey: generationsQuery(wsPath).queryKey }),
      ]),
    [qc, wsPath]
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
      qc.setQueryData<Generation[]>(
        generationsQuery(wsPath).queryKey,
        (old) => (old ? [...old, ...created] : created)
      );
      void qc.invalidateQueries({ queryKey: generationsQuery(wsPath).queryKey });
      void qc.invalidateQueries({ queryKey: imagesQuery(wsPath).queryKey });
    },
    [qc, wsPath]
  );

  const [dims, setDims] = useState<Record<string, Dims>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Full-screen image lightbox: the resolved `<img src>` currently displayed, or
  // null when closed. Independent of `selectedPath` so closing it leaves the
  // detail-panel selection intact.
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);

  // Bulk-action selection: ⌘/Ctrl-clicking a tile toggles its membership in
  // `selectedPaths` instead of opening the detail panel. Once ≥1 image is
  // picked we're in "select mode" — plain clicks toggle too, and the right
  // panel becomes a bulk template picker that fans out across every selected
  // image. No explicit toggle button; the panel's "Bersihkan" exits.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const selectMode = selectedPaths.size > 0;
  // Batch vs Interactions API for bulk generation only (single-image flows
  // below always use Batch implicitly). Ephemeral — always starts at
  // "batch", never persisted, so a leftover choice can't leak into an
  // unrelated later bulk run.
  const [bulkMode, setBulkMode] = useState<ApiMode>("batch");

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
  const providerId = providerCtx?.id ?? "google";
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
    setVariantPrompt("");
    setSelectedTemplates(new Set());
    setError(null);
  }, []);

  const handleImageLoad = useCallback((path: string, w: number, h: number) => {
    setDims((prev) => (prev[path] ? prev : { ...prev, [path]: { w, h } }));
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
      qc.invalidateQueries({ queryKey: imagesQuery(wsPath).queryKey });
    }
  }, [generations, images, qc, wsPath]);

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

  // ⌘/Ctrl-click a tile, or a plain click once already in select mode, toggles
  // its membership in the bulk selection. Entering select mode closes the
  // single-asset detail panel.
  const togglePathSelection = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    setSelectedPath(null);
    setVariantPrompt("");
    setError(null);
  }, []);

  // Dispatch a tile click: additive (⌘/Ctrl) clicks and any click while in
  // select mode toggle the bulk selection; otherwise open the detail panel.
  const onTileClick = useCallback(
    (path: string, additive: boolean) => {
      if (additive || selectMode) togglePathSelection(path);
      else selectAsset(path);
    },
    [selectMode, togglePathSelection, selectAsset]
  );

  // Clear the bulk selection and every choice scoped to it.
  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set());
    setSelectedTemplates(new Set());
    setBulkMode("batch");
    setError(null);
  }, []);

  function close() {
    setSelectedPath(null);
    setVariantPrompt("");
    setSelectedTemplates(new Set());
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
      // Single-image generation defaults to the Interactions API (fast,
      // synchronous) rather than Batch — unlike Bulk, there's no cost-vs-speed
      // tradeoff to expose here since it's usually just one request.
      const gen = await createPrediction(
        variantPrompt.trim(),
        providerId,
        selectedImage?.id,
        "interactions"
      );
      enqueueGenerations([gen]);
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
      const prompts = savedTemplates
        .filter((t) => selectedTemplates.has(t.id))
        .map((t) => t.prompt);
      // One backend call enqueues one queued generation per template. Same
      // Interactions-by-default reasoning as `generate()` above.
      const gens = await createPredictions(
        prompts,
        providerId,
        selectedImage?.id,
        "interactions"
      );
      enqueueGenerations(gens);
      setSelectedTemplates(new Set());
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
    if (
      generating ||
      selectedTemplates.size === 0 ||
      selectedPaths.size === 0
    ) {
      return;
    }
    if (!apiKey) {
      setError(`Kunci API ${providerLabel} belum diatur.`);
      return;
    }

    setGenerating(true);
    setError(null);
    try {
      const prompts = savedTemplates
        .filter((t) => selectedTemplates.has(t.id))
        .map((t) => t.prompt);
      const all: Generation[] = [];
      for (const path of selectedPaths) {
        const img = images.find((i) => i.path === path);
        if (!img) continue;
        all.push(
          ...(await createPredictions(prompts, providerId, img.id, bulkMode))
        );
      }
      enqueueGenerations(all);
      setSelectedPaths(new Set());
      setSelectedTemplates(new Set());
      setBulkMode("batch");
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

  async function delBulk() {
    if (selectedPaths.size === 0 || deleting) return;
    const count = selectedPaths.size;
    const confirmed = await ask(
      `Hapus ${count} aset secara permanen? Tindakan ini tidak bisa dibatalkan.`,
      { title: "Hapus aset", kind: "warning" }
    );
    if (!confirmed) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteImages([...selectedPaths]);
      await refresh();
      setSelectedPaths(new Set());
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

  // The right panel shows the bulk picker once ≥1 image is picked, otherwise
  // the single-asset detail. Both shrink the grid.
  const bulkOpen = selectMode;
  const panelOpen = bulkOpen || hasSelection;
  const bulkJobCount = selectedPaths.size * selectedTemplates.size;

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

      <AssetToolbar
        visibleCount={visibleImages.length}
        filter={filter}
        onFilterChange={setFilter}
        search={search}
        onSearchChange={setSearch}
        sortValue={`${sortKey}-${sortDir}`}
        onSortChange={changeSort}
        view={view}
        onViewChange={setView}
        onUploadClick={onUploadClick}
      />

      {!apiKey && (
        <ApiKeyBanner providerLabel={providerLabel} onOpenSettings={openSettings} />
      )}

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <AssetGrid
          totalCount={images.length}
          pending={visiblePending}
          images={sortedImages}
          filter={filter}
          view={view}
          panelOpen={panelOpen}
          dims={dims}
          selectMode={selectMode}
          selectedPaths={selectedPaths}
          selectedPath={selectedPath}
          onSelectImage={onTileClick}
          onLoad={handleImageLoad}
          srcPathOf={srcPathOf}
          isAi={(path) => !!gens[path]}
          onUploadClick={onUploadClick}
        />

        {bulkOpen && (
          <BulkPanel
            selectedCount={selectedPaths.size}
            onClearSelection={clearSelection}
            selectedTemplates={selectedTemplates}
            onToggleTemplate={toggleTemplate}
            mode={bulkMode}
            onModeChange={setBulkMode}
            jobCount={bulkJobCount}
            generating={generating}
            onGenerateBulk={generateBulk}
            deleting={deleting}
            onDeleteBulk={delBulk}
            error={error}
          />
        )}

        {!selectMode && selectedImage && (
          <DetailPanel
            image={selectedImage}
            dim={dims[selectedImage.path]}
            prompt={gens[selectedImage.path]?.prompt}
            sourceImage={sourceImage}
            variants={children}
            onClose={close}
            onViewImage={setViewerSrc}
            onSelectSource={selectAsset}
            variantPrompt={variantPrompt}
            onVariantPromptChange={setVariantPrompt}
            selectedTemplates={selectedTemplates}
            onToggleTemplate={toggleTemplate}
            generating={generating}
            generateDisabled={generateDisabled}
            generateLabel={generateLabel}
            onGenerate={generate}
            onGenerateFromTemplates={generateFromTemplates}
            error={error}
            deleting={deleting}
            onDelete={del}
          />
        )}
      </div>
    </>
  );
}
