import { GENERATION_TEMPLATES } from "../../lib/templates";
import { IconPhoto } from "../../lib/icons";

/** Grid of generation templates the user can multi-select. Clicking a tile
 *  toggles its membership in `selected`. Shared by the single-asset detail
 *  panel and the bulk (multi-image) panel. */
export function TemplatePicker({
  selected,
  onToggle,
  marginBottom = 12,
}: {
  selected: Set<string>;
  onToggle: (id: string) => void;
  marginBottom?: number;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom }}>
      {GENERATION_TEMPLATES.map((t) => {
        const isSelected = selected.has(t.id);
        return (
          <div
            key={t.id}
            onClick={() => onToggle(t.id)}
            style={{ cursor: "pointer", width: 120 }}
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
                <IconPhoto size={24} color="var(--ink-350)" stroke={1.5} />
              )}
              {isSelected && (
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
                marginTop: 6,
                fontSize: 11.5,
                fontWeight: 600,
                color: isSelected ? "var(--indigo-600)" : "var(--ink-700)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {t.name}
            </div>
          </div>
        );
      })}
    </div>
  );
}
