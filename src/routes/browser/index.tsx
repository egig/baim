import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ask } from "@tauri-apps/plugin-dialog";
import { dirListingQuery } from "../../lib/queries";
import { deleteImage, openPathExternally, type DirEntry } from "../../lib/tauri";
import { kindLabel } from "../../lib/fileDisplay";
import { useShell } from "../../root";
import { useT } from "../../lib/i18n";
import { Segmented } from "../../components/Segmented";
import { FileTile } from "./FileTile";
import { FileRow } from "./FileRow";
import {
  IconCaretDownFilled,
  IconCaretUpFilled,
  IconChevronRight,
  IconFolder,
  IconLayoutGrid,
  IconList,
  IconPhoto,
} from "../../lib/icons";

type ViewMode = "grid" | "list";
const VIEW_MODE_KEY = "baim.browser.viewMode";

function loadViewMode(): ViewMode {
  try {
    const stored = localStorage.getItem(VIEW_MODE_KEY);
    if (stored === "grid" || stored === "list") return stored;
  } catch {
    /* localStorage may be unavailable */
  }
  return "grid";
}

type SortKey = "name" | "modified" | "size" | "kind";
type Sort = { key: SortKey; dir: "asc" | "desc" };

// Below this content width the Kind column is dropped, and below the next
// the Date Modified column goes too — Finder-style column collapse so the
// Name column keeps its minimum width instead of getting squeezed.
const HIDE_KIND_BELOW = 560;
const HIDE_MODIFIED_BELOW = 420;

function compareEntries(a: DirEntry, b: DirEntry, key: SortKey): number {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "modified":
      return a.modified_at - b.modified_at;
    case "size":
      return a.size_bytes - b.size_bytes;
    case "kind":
      return kindLabel(a).localeCompare(kindLabel(b));
  }
}

/** Breadcrumb segments for an absolute path, each carrying the full path up
 *  to and including that segment so clicking jumps straight there. Handles
 *  POSIX (`/a/b/c`) and, best-effort, Windows (`C:\a\b`) separators. */
function breadcrumbsOf(path: string): { label: string; path: string }[] {
  const isPosixAbsolute = path.startsWith("/");
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[\\/]/).filter(Boolean);
  const crumbs: { label: string; path: string }[] = [];
  let acc = "";
  if (isPosixAbsolute) crumbs.push({ label: "/", path: "/" });
  for (const part of parts) {
    acc = isPosixAbsolute ? `${acc}/${part}` : acc ? `${acc}${sep}${part}` : part;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

/** Clickable list-view column header: clicking toggles sort by this column,
 *  flipping direction on repeat clicks; a caret shows the active column's
 *  direction. */
function SortHeaderCell({
  label,
  sortKey,
  sort,
  onClick,
  style,
}: {
  label: string;
  sortKey: SortKey;
  sort: Sort | null;
  onClick: (key: SortKey) => void;
  style?: React.CSSProperties;
}) {
  const active = sort?.key === sortKey;
  return (
    <div
      onClick={() => onClick(sortKey)}
      style={{ display: "flex", alignItems: "center", gap: 2, cursor: "pointer", userSelect: "none", ...style }}
    >
      {label}
      {active &&
        (sort!.dir === "asc" ? (
          <IconCaretUpFilled size={10} />
        ) : (
          <IconCaretDownFilled size={10} />
        ))}
    </div>
  );
}

export default function Browser() {
  const { t } = useT();
  const qc = useQueryClient();
  const { currentPath, navigateTo, attachments, toggleAttachment, selectAttachment } = useShell();
  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode);
  const [sort, setSort] = useState<Sort | null>(null);

  function changeViewMode(mode: ViewMode) {
    setViewMode(mode);
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {
      /* localStorage may be unavailable */
    }
  }

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev?.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }
    );
  }

  // Tracks the content panel's width so the list view can drop columns
  // before the Name column gets squeezed below a usable width.
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentWidth, setContentWidth] = useState(0);
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setContentWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const hideKind = contentWidth < HIDE_KIND_BELOW;
  const hideModified = contentWidth < HIDE_MODIFIED_BELOW;

  const { data: listing, isLoading, error } = useQuery({
    ...dirListingQuery(currentPath ?? undefined),
    enabled: currentPath !== null,
  });

  const crumbs = useMemo(() => (listing ? breadcrumbsOf(listing.path) : []), [listing]);

  const sortedEntries = useMemo(() => {
    const entries = listing?.entries ?? [];
    if (!sort) return entries;
    const sorted = [...entries].sort((a, b) => compareEntries(a, b, sort.key));
    return sort.dir === "asc" ? sorted : sorted.reverse();
  }, [listing, sort]);

  function refresh() {
    if (listing) void qc.invalidateQueries({ queryKey: dirListingQuery(listing.path).queryKey });
  }

  function onEntryClick(entry: DirEntry, e: React.MouseEvent) {
    if (entry.is_dir) return;
    // Plain click replaces the chat context with just this file — there's no
    // separate "select to inspect" mode; attaching *is* how you act on a file
    // now (see ChatPane). Cmd-click toggles it into/out of the existing
    // selection instead, for attaching more than one file.
    e.preventDefault();
    if (e.metaKey) {
      toggleAttachment(entry.path);
    } else {
      selectAttachment(entry.path);
    }
  }

  function onEntryDoubleClick(entry: DirEntry) {
    if (entry.is_dir) {
      navigateTo(entry.path);
    } else {
      void openPathExternally(entry.path);
    }
  }

  async function onDeleteImage(entry: DirEntry) {
    const confirmed = await ask(t("confirm.deleteAssetOne"), {
      title: t("confirm.deleteAssetTitle"),
      kind: "warning",
    });
    if (!confirmed) return;
    try {
      await deleteImage(entry.path);
      if (attachments.includes(entry.path)) toggleAttachment(entry.path);
      refresh();
    } catch {
      // Best-effort — the grid simply won't show the file as gone; the user
      // can retry.
    }
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "12px 20px",
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            overflowX: "auto",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {crumbs.map((c, i) => (
            <span key={c.path} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              {i > 0 && <IconChevronRight size={12} color="var(--ink-350)" />}
              <span
                onClick={() => navigateTo(c.path)}
                style={{
                  fontSize: 12.5,
                  fontWeight: i === crumbs.length - 1 ? 700 : 500,
                  color: i === crumbs.length - 1 ? "var(--ink-800)" : "var(--ink-500)",
                  cursor: "pointer",
                }}
              >
                {c.label}
              </span>
            </span>
          ))}
        </div>

        <Segmented
          value={viewMode}
          onChange={changeViewMode}
          options={[
            { value: "grid", label: <IconLayoutGrid size={14} />, title: t("browser.gridView") },
            { value: "list", label: <IconList size={14} />, title: t("browser.listView") },
          ]}
        />
      </div>

      <div
        ref={contentRef}
        style={{ flex: 1, overflowY: "auto", padding: 0, display: "flex", flexDirection: "column" }}
      >
        {isLoading && (
          <div style={{ margin: "auto", color: "var(--ink-400)", fontSize: 12.5 }}>
            {t("browser.loading")}
          </div>
        )}
        {error != null && (
          <div style={{ margin: "auto", color: "var(--red-600)", fontSize: 12.5 }}>
            {String(error)}
          </div>
        )}
        {listing && listing.entries.length === 0 && (
          <div style={{ margin: "auto", textAlign: "center", color: "var(--ink-400)", fontSize: 12.5 }}>
            <IconFolder size={28} color="var(--ink-350)" />
            <div style={{ marginTop: 8 }}>{t("browser.empty")}</div>
          </div>
        )}
        {listing && listing.entries.length > 0 && viewMode === "grid" && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {sortedEntries.map((entry) => (
              <FileTile
                key={entry.path}
                entry={entry}
                selected={attachments.includes(entry.path)}
                onClick={(e) => onEntryClick(entry, e)}
                onDoubleClick={() => onEntryDoubleClick(entry)}
                onDelete={entry.is_image ? () => onDeleteImage(entry) : undefined}
              />
            ))}
          </div>
        )}
        {listing && listing.entries.length > 0 && viewMode === "list" && (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                position: "sticky",
                top: 0,
                zIndex: 1,
                display: "flex",
                background: "var(--surface-0)",
                alignItems: "center",
                gap: 10,
                padding: "10px 6px",
                borderBottom: "1px solid var(--line-1)",
                marginBottom: 4,
                fontSize: 10.5,
                fontWeight: 600,
                color: "var(--ink-400)",
                textTransform: "uppercase",
                letterSpacing: ".02em",
              }}
            >
              <div style={{ width: 28, flexShrink: 0, background: "var(--surface-0)" }} />
              <SortHeaderCell
                label={t("browser.colName")}
                sortKey="name"
                sort={sort}
                onClick={toggleSort}
                style={{ flex: "1 1 160px", minWidth: 160 }}
              />
              {!hideModified && (
                <SortHeaderCell
                  label={t("browser.colModified")}
                  sortKey="modified"
                  sort={sort}
                  onClick={toggleSort}
                  style={{ flex: "0 0 140px" }}
                />
              )}
              <SortHeaderCell
                label={t("browser.colSize")}
                sortKey="size"
                sort={sort}
                onClick={toggleSort}
                style={{ flex: "0 0 70px", justifyContent: "flex-end" }}
              />
              {!hideKind && (
                <SortHeaderCell
                  label={t("browser.colKind")}
                  sortKey="kind"
                  sort={sort}
                  onClick={toggleSort}
                  style={{ flex: "0 0 80px" }}
                />
              )}
              <div style={{ flex: "0 0 24px" }} />
            </div>
            {sortedEntries.map((entry) => (
              <FileRow
                key={entry.path}
                entry={entry}
                selected={attachments.includes(entry.path)}
                hideModified={hideModified}
                hideKind={hideKind}
                onClick={(e) => onEntryClick(entry, e)}
                onDoubleClick={() => onEntryDoubleClick(entry)}
                onDelete={entry.is_image ? () => onDeleteImage(entry) : undefined}
              />
            ))}
          </div>
        )}
      </div>

      {attachments.length > 0 && (
        <div
          style={{
            flexShrink: 0,
            padding: "8px 20px",
            borderTop: "1px solid var(--line-1)",
            fontSize: 11.5,
            color: "var(--ink-500)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <IconPhoto size={13} />
          {t("browser.attachedCount", { count: attachments.length })}
        </div>
      )}
    </div>
  );
}
