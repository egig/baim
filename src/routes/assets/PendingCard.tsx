import { memo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { IconLoader2 } from "../../lib/icons";

/** An in-progress generation: the source image dimmed under a spinning icon,
 *  shown until polling replaces it with the finished result. */
export const PendingCard = memo(function PendingCard({
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
          <IconLoader2
            size={22}
            className="assets-spin"
            stroke={2.5}
            style={{ color: "var(--indigo-500)" }}
          />
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
