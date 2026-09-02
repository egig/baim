import { memo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ImageEntry } from "../../lib/tauri";
import { displayName, kindOf } from "./helpers";
import type { Dims } from "./types";

export const ImageCard = memo(function ImageCard({
  img,
  selected,
  dim,
  onSelect,
  onLoad,
}: {
  img: ImageEntry;
  selected: boolean;
  dim: Dims | undefined;
  onSelect: (path: string, additive: boolean) => void;
  onLoad: (path: string, w: number, h: number) => void;
}) {
  return (
    <div
      onClick={(e) => onSelect(img.path, e.metaKey || e.ctrlKey)}
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
        {dim ? `${dim.w}×${dim.h}` : " "}
      </div>
    </div>
  );
});
