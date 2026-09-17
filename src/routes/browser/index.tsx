import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ask } from "@tauri-apps/plugin-dialog";
import { dirListingQuery } from "../../lib/queries";
import { deleteImage, openPathExternally, type DirEntry } from "../../lib/tauri";
import { useShell } from "../../root";
import { useT } from "../../lib/i18n";
import { FileTile } from "./FileTile";
import { IconChevronRight, IconFolder, IconPhoto } from "../../lib/icons";

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

export default function Browser() {
  const { t } = useT();
  const qc = useQueryClient();
  const { currentPath, navigateTo, attachments, toggleAttachment } = useShell();

  const { data: listing, isLoading, error } = useQuery({
    ...dirListingQuery(currentPath ?? undefined),
    enabled: currentPath !== null,
  });

  const crumbs = useMemo(() => (listing ? breadcrumbsOf(listing.path) : []), [listing]);

  function refresh() {
    if (listing) void qc.invalidateQueries({ queryKey: dirListingQuery(listing.path).queryKey });
  }

  function onEntryClick(entry: DirEntry, e: React.MouseEvent) {
    if (entry.is_dir) return;
    // Any plain or additive click toggles this file as chat context — there's
    // no separate "select to inspect" mode; attaching *is* how you act on a
    // file now (see ChatPane).
    e.preventDefault();
    toggleAttachment(entry.path);
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
          gap: 4,
          padding: "12px 20px",
          borderBottom: "1px solid var(--line-1)",
          overflowX: "auto",
          whiteSpace: "nowrap",
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

      <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column" }}>
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
        {listing && listing.entries.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {listing.entries.map((entry) => (
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
