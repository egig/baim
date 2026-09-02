import { useState } from "react";
import { IconPencil, IconPhoto, IconTrash, IconX } from "../../lib/icons";
import type { PickerTemplate } from "../../lib/templates";

/** One card on the Templat management page: a large preview, the template name
 *  (inline-editable), the full prompt, and rename/delete actions. Distinct from
 *  the compact, selection-oriented `TemplateTile` used inside the pickers. */
export function TemplateCard({
  t,
  onRename,
  onDelete,
}: {
  t: PickerTemplate;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(t.name);

  function commitRename() {
    const name = draftName.trim();
    setRenaming(false);
    if (name && name !== t.name) onRename(t.id, name);
    else setDraftName(t.name);
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        borderRadius: "var(--r-card)",
        border: "1px solid var(--line-3)",
        background: "var(--surface-0)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "relative",
          aspectRatio: "4 / 3",
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
          <IconPhoto size={28} color="var(--ink-350)" stroke={1.5} />
        )}
      </div>

      <div
        style={{
          padding: "10px 12px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          flex: 1,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {renaming ? (
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") {
                  setDraftName(t.name);
                  setRenaming(false);
                }
              }}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 12.5,
                fontWeight: 600,
                padding: "2px 4px",
                border: "1px solid var(--indigo-500)",
                borderRadius: 4,
                outline: "none",
                color: "var(--ink-800)",
                background: "var(--surface-0)",
              }}
            />
          ) : (
            <span
              title={t.name}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 12.5,
                fontWeight: 600,
                color: "var(--ink-800)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {t.name}
            </span>
          )}

          <button
            type="button"
            title={renaming ? "Batal" : "Ganti nama"}
            onClick={() => {
              if (renaming) {
                setDraftName(t.name);
                setRenaming(false);
              } else {
                setDraftName(t.name);
                setRenaming(true);
              }
            }}
            style={iconBtn}
          >
            {renaming ? <IconX size={13} /> : <IconPencil size={13} />}
          </button>
          <button
            type="button"
            title="Hapus templat"
            onClick={() => onDelete(t.id)}
            style={{ ...iconBtn, color: "var(--red-600)" }}
          >
            <IconTrash size={13} />
          </button>
        </div>

        <div
          title={t.prompt}
          style={{
            fontSize: 11.5,
            lineHeight: 1.45,
            color: "var(--ink-500)",
            display: "-webkit-box",
            WebkitLineClamp: 4,
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
  width: 24,
  height: 24,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid var(--line-4)",
  borderRadius: "var(--r-control)",
  background: "var(--surface-0)",
  color: "var(--ink-500)",
  cursor: "pointer",
};
