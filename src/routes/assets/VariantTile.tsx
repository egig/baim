import { memo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Generation } from "../../lib/tauri";
import { useT } from "../../lib/i18n";
import { IconAlertTriangle, IconLoader2 } from "../../lib/icons";

/** A generated variant shown in the detail panel's lineage section. Succeeded →
 *  clickable thumbnail (opens that variant); pending → spinner over the dimmed
 *  source; failed → a warning tile carrying the error message. */
export const VariantTile = memo(function VariantTile({
  gen,
  srcPath,
  onOpen,
}: {
  gen: Generation;
  srcPath?: string;
  onOpen: (path: string) => void;
}) {
  const { t } = useT();
  const clickable = gen.status === "succeeded" && !!gen.output_path;
  return (
    <div
      onClick={clickable ? () => onOpen(gen.output_path!) : undefined}
      title={gen.status === "failed" ? gen.error ?? t("detail.failed") : gen.prompt}
      style={{
        position: "relative",
        width: 84,
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
          <IconLoader2
            size={20}
            className="assets-spin"
            stroke={2.5}
            style={{ color: "var(--indigo-500)", position: "relative" }}
          />
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
          <IconAlertTriangle size={20} color="#dc2626" stroke={1.6} />
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
            {gen.error ?? t("detail.failed")}
          </span>
        </div>
      )}
    </div>
  );
});
