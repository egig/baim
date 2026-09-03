import { useState } from "react";
import { useT } from "../../lib/i18n";
import { IconPencil, IconPhoto, IconTrash } from "../../lib/icons";
import type { PickerTemplate } from "../../lib/templates";

/** One card on the Templat management page: a compact preview (sized to match
 *  the asset library tiles), the template name, a prompt excerpt, and
 *  edit/delete actions overlaid on the preview. Distinct from the compact,
 *  selection-oriented `TemplateTile` used inside the pickers. Editing (name +
 *  prompt + preview) happens in `TemplateDialog`, opened via `onEdit`. */
export function TemplateCard({
  t,
  onEdit,
  onDelete,
}: {
  t: PickerTemplate;
  onEdit: () => void;
  onDelete: (id: string) => void;
}) {
  const { t: tr } = useT();
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        style={{
          position: "relative",
          aspectRatio: "1",
          borderRadius: "var(--r-card)",
          overflow: "hidden",
          border: "1px solid var(--line-3)",
          background: "var(--fill-1)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {t.imagePreview ? (
          <img
            src={t.imagePreview}
            alt={t.name}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        ) : (
          <IconPhoto size={22} color="var(--ink-350)" stroke={1.5} />
        )}

        <div
          style={{
            position: "absolute",
            top: 5,
            right: 5,
            display: "flex",
            gap: 4,
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? "auto" : "none",
            transition: "opacity .12s",
          }}
        >
          <button
            type="button"
            title={tr("templates.editTemplate")}
            onClick={onEdit}
            style={iconBtn}
          >
            <IconPencil size={12} />
          </button>
          <button
            type="button"
            title={tr("templates.deleteTemplate")}
            onClick={() => onDelete(t.id)}
            style={{ ...iconBtn, color: "var(--red-600)" }}
          >
            <IconTrash size={12} />
          </button>
        </div>
      </div>

      <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 3 }}>
        <span
          title={t.name}
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: "var(--ink-800)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {t.name}
        </span>
        <div
          title={t.prompt}
          style={{
            fontSize: 11,
            lineHeight: 1.4,
            color: "var(--ink-400)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {t.prompt}
        </div>
      </div>
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  flexShrink: 0,
  width: 22,
  height: 22,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid var(--line-4)",
  borderRadius: "var(--r-control)",
  background: "rgba(255,255,255,.92)",
  color: "var(--ink-600)",
  cursor: "pointer",
};
