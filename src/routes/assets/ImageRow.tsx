import { memo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ImageEntry } from "../../lib/tauri";
import { displayName, fmtDate, fmtSize } from "./helpers";
import type { Dims } from "./types";

/** A single image rendered as a detailed row for the list view: thumbnail,
 *  filename with a Sumber/AI origin badge, and a metadata line. */
export const ImageRow = memo(function ImageRow({
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
