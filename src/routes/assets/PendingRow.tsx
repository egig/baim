import { memo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { IconLoader2 } from "../../lib/icons";

/** In-progress generation rendered as a list row, mirroring `PendingCard`. */
export const PendingRow = memo(function PendingRow({
  srcPath,
}: {
  srcPath?: string;
}) {
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
          <IconLoader2
            size={18}
            className="assets-spin"
            stroke={2.5}
            style={{ color: "var(--indigo-500)" }}
          />
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
