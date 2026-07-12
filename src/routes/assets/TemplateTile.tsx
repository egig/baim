import { useState } from "react";
import { IconPencil, IconPhoto, IconTrash, IconX } from "../../lib/icons";
import type { PickerTemplate } from "../../lib/templates";

/** One tile in `TemplatePicker`'s grid: an image (or placeholder), a name
 *  label, and — for saved (non-built-in) templates — hover-revealed rename
 *  and delete actions. Shared by the inline grid and the "More templates"
 *  overflow dialog so both render identically. */
export function TemplateTile({
  t,
  selected,
  onToggle,
  editable,
  onRename,
  onDelete,
}: {
  t: PickerTemplate;
  selected: boolean;
  onToggle: (id: string) => void;
  editable: boolean;
  onRename?: (id: string, name: string) => void;
  onDelete?: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(t.name);

  function commitRename() {
    const name = draftName.trim();
    setRenaming(false);
    if (name && name !== t.name) onRename?.(t.id, name);
    else setDraftName(t.name);
  }

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ width: 120 }}
    >
      <div
        onClick={() => onToggle(t.id)}
        style={{
          position: "relative",
          cursor: "pointer",
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
        {editable && hovered && (
          <div
            style={{
              position: "absolute",
              top: 4,
              right: 4,
              display: "flex",
              gap: 4,
            }}
          >
            <div
              onClick={(e) => {
                e.stopPropagation();
                setDraftName(t.name);
                setRenaming(true);
              }}
              title="Ganti nama"
              style={{
                width: 20,
                height: 20,
                borderRadius: 5,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                background: "rgba(15,18,26,0.55)",
                color: "#fff",
              }}
            >
              <IconPencil size={11} />
            </div>
            <div
              onClick={(e) => {
                e.stopPropagation();
                onDelete?.(t.id);
              }}
              title="Hapus templat"
              style={{
                width: 20,
                height: 20,
                borderRadius: 5,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                background: "rgba(15,18,26,0.55)",
                color: "#fff",
              }}
            >
              <IconTrash size={11} />
            </div>
          </div>
        )}
      </div>

      {renaming ? (
        <div
          style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 3 }}
          onClick={(e) => e.stopPropagation()}
        >
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
              width: "100%",
              minWidth: 0,
              fontSize: 11.5,
              fontWeight: 600,
              padding: "2px 4px",
              border: "1px solid var(--indigo-500)",
              borderRadius: 4,
              outline: "none",
              color: "var(--ink-800)",
              background: "var(--surface-0)",
            }}
          />
          <IconX
            size={11}
            color="var(--ink-400)"
            style={{ cursor: "pointer", flexShrink: 0 }}
            onMouseDown={(e) => {
              e.preventDefault();
              setDraftName(t.name);
              setRenaming(false);
            }}
          />
        </div>
      ) : (
        <div
          style={{
            marginTop: 6,
            fontSize: 11.5,
            fontWeight: 600,
            color: selected ? "var(--indigo-600)" : "var(--ink-700)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {t.name}
        </div>
      )}
    </div>
  );
}
