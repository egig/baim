import { convertFileSrc } from "@tauri-apps/api/core";
import type { DirEntry } from "../../lib/tauri";
import { fmtSize, kindOf } from "../../lib/fileDisplay";
import { IconFolderFilled, IconFile, IconTrash } from "../../lib/icons";

const TILE_SIZE = 128;

/** One grid tile: a folder, an image (thumbnail), or any other file (generic
 *  icon + extension badge). Single click selects/attaches (images only);
 *  double click opens (navigates into a folder, or opens a file externally).
 *  `onDelete` is only wired for images — there's no in-app file management
 *  for anything else, per the browser's read-mostly scope. */
export function FileTile({
  entry,
  selected,
  onClick,
  onDoubleClick,
  onDelete,
}: {
  entry: DirEntry;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={entry.name}
      style={{
        width: TILE_SIZE,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        padding: 8,
        borderRadius: "var(--r-card)",
        cursor: "pointer",
        ...(selected ? { background: "var(--indigo-100)" } : {}),
        position: "relative",
      }}
      className="file-tile"
    >
      {entry.is_image && onDelete && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="file-tile-delete"
          title="Delete"
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            width: 22,
            height: 22,
            borderRadius: 6,
            display: "none",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,.55)",
            color: "#fff",
            zIndex: 1,
          }}
        >
          <IconTrash size={12} />
        </div>
      )}

      <div
        style={{
          width: 96,
          height: 96,
          borderRadius: "var(--r-card)",
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
          <IconFolderFilled size={64} color="var(--indigo-400, #8b91e0)" />
        ) : entry.is_image ? (
          <img
            src={convertFileSrc(entry.path)}
            alt={entry.name}
            loading="lazy"
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <IconFile size={36} color="var(--ink-350)" stroke={1.3} />
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: ".02em",
                color: "var(--ink-400)",
              }}
            >
              {kindOf(entry.name)}
            </span>
          </div>
        )}
      </div>

      <div
        style={{
          width: "100%",
          textAlign: "center",
          fontSize: 11.5,
          fontWeight: 500,
          color: "var(--ink-700)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {entry.name}
      </div>
      {!entry.is_dir && (
        <div style={{ fontSize: 10, color: "var(--ink-400)" }}>{fmtSize(entry.size_bytes)}</div>
      )}
    </div>
  );
}
