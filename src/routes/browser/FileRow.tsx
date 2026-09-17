import { convertFileSrc } from "@tauri-apps/api/core";
import type { DirEntry } from "../../lib/tauri";
import { fmtDate, fmtSize, kindOf } from "../../lib/fileDisplay";
import { useT } from "../../lib/i18n";
import { IconFolderFilled, IconFile, IconTrash } from "../../lib/icons";

/** One list-view row: a folder, an image (thumbnail), or any other file,
 *  laid out Finder-style across Name / Date Modified / Size / Kind columns.
 *  Mirrors `FileTile`'s click/selection/delete behavior. `hideModified`/
 *  `hideKind` drop those columns when the panel is too narrow to fit them
 *  (see the width tracking in `index.tsx`), matching Finder's column collapse. */
export function FileRow({
  entry,
  selected,
  hideModified,
  hideKind,
  onClick,
  onDoubleClick,
  onDelete,
}: {
  entry: DirEntry;
  selected: boolean;
  hideModified: boolean;
  hideKind: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onDelete?: () => void;
}) {
  const { t } = useT();
  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={entry.name}
      className="file-tile"
      style={{
        position: "relative",
        zIndex: 0,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 10px",
        borderRadius: "var(--r-control)",
        cursor: "pointer",
        ...(selected ? { background: "var(--indigo-100)" } : {}),
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          flexShrink: 0,
          borderRadius: 6,
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: entry.is_dir ? "transparent" : "var(--fill-1)",
          border: entry.is_dir ? "none" : "1px solid var(--line-3)",
          position: "relative",
        }}
      >
        {entry.is_dir ? (
          <IconFolderFilled size={20} color="var(--indigo-400, #8b91e0)" />
        ) : entry.is_image ? (
          <img
            src={convertFileSrc(entry.path)}
            alt={entry.name}
            loading="lazy"
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <IconFile size={16} color="var(--ink-350)" stroke={1.3} />
        )}
      </div>

      <div
        style={{
          flex: "1 1 160px",
          minWidth: 160,
          fontSize: 12.5,
          fontWeight: 500,
          color: "var(--ink-700)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {entry.name}
      </div>

      {!hideModified && (
        <div style={{ flex: "0 0 140px", fontSize: 11.5, color: "var(--ink-400)" }}>
          {fmtDate(entry.modified_at)}
        </div>
      )}

      <div style={{ flex: "0 0 70px", fontSize: 11.5, color: "var(--ink-400)", textAlign: "right" }}>
        {!entry.is_dir && fmtSize(entry.size_bytes)}
      </div>

      {!hideKind && (
        <div style={{ flex: "0 0 80px", fontSize: 11.5, color: "var(--ink-400)" }}>
          {entry.is_dir ? t("browser.kindFolder") : kindOf(entry.name)}
        </div>
      )}

      <div style={{ flex: "0 0 24px", display: "flex", justifyContent: "flex-end" }}>
        {entry.is_image && onDelete && (
          <div
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="file-tile-delete"
            title="Delete"
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              display: "none",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(0,0,0,.55)",
              color: "#fff",
            }}
          >
            <IconTrash size={12} />
          </div>
        )}
      </div>
    </div>
  );
}
