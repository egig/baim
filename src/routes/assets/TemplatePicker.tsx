import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ask } from "@tauri-apps/plugin-dialog";
import { templatesQuery } from "../../lib/queries";
import { toPickerTemplates } from "../../lib/templates";
import { deleteTemplate, renameTemplate } from "../../lib/tauri";
import { Dialog } from "../../root";
import { TemplateTile } from "./TemplateTile";
import { useContainerWidth } from "./useContainerWidth";

const TILE_WIDTH = 120;
const GAP = 10;

const sectionLabel: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: ".03em",
  color: "var(--ink-350)",
  textTransform: "uppercase",
  marginBottom: 8,
};

/** Grid of generation templates the user can multi-select. Clicking a tile
 *  toggles its membership in `selected`. Shared by the single-asset detail
 *  panel and the bulk (multi-image) panel.
 *
 *  Self-fetches templates (`templatesQuery`, most-recently-created first —
 *  includes the seeded starter templates as regular rows). Only ~1 row
 *  renders inline, with a "More templates" overflow dialog beyond that. */
export function TemplatePicker({
  selected,
  onToggle,
  marginBottom = 12,
}: {
  selected: Set<string>;
  onToggle: (id: string) => void;
  marginBottom?: number;
}) {
  const qc = useQueryClient();
  const { data: saved = [] } = useQuery(templatesQuery);
  const all = useMemo(() => toPickerTemplates(saved), [saved]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(wrapRef, 0, all.length);
  const perRow = Math.max(1, Math.floor((width + GAP) / (TILE_WIDTH + GAP)));
  const overflow = all.length > perRow;
  const visible = all.slice(0, perRow);
  const [moreOpen, setMoreOpen] = useState(false);

  async function handleRename(id: string, name: string) {
    await renameTemplate(id, name);
    qc.invalidateQueries({ queryKey: templatesQuery.queryKey });
  }

  async function handleDelete(id: string) {
    const confirmed = await ask("Hapus templat ini?", {
      title: "Hapus templat",
      kind: "warning",
    });
    if (!confirmed) return;
    await deleteTemplate(id);
    qc.invalidateQueries({ queryKey: templatesQuery.queryKey });
  }

  const grid: React.CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: GAP,
  };

  return (
    <div ref={wrapRef} style={{ marginBottom }}>
      <div style={sectionLabel}>Templat saya</div>
      <div style={grid}>
        {visible.map((t) => (
          <TemplateTile
            key={t.id}
            t={t}
            selected={selected.has(t.id)}
            onToggle={onToggle}
            onRename={handleRename}
            onDelete={handleDelete}
          />
        ))}
      </div>
      {overflow && (
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          style={{
            marginTop: 8,
            background: "none",
            border: "none",
            padding: 0,
            fontSize: 11.5,
            fontWeight: 600,
            color: "var(--indigo-600)",
            cursor: "pointer",
          }}
        >
          Lebih banyak templat ({all.length})
        </button>
      )}

      {moreOpen && (
        <Dialog width="min(560px, 90vw)" height="min(520px, 80vh)" onClose={() => setMoreOpen(false)}>
          <div
            style={{
              padding: "14px 18px",
              borderBottom: "1px solid var(--line-1)",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ink-800)",
            }}
          >
            Templat saya
          </div>
          <div
            style={{
              flex: 1,
              overflow: "auto",
              padding: 18,
              display: "flex",
              flexWrap: "wrap",
              gap: GAP,
              alignContent: "flex-start",
            }}
          >
            {all.map((t) => (
              <TemplateTile
                key={t.id}
                t={t}
                selected={selected.has(t.id)}
                onToggle={onToggle}
                onRename={handleRename}
                onDelete={handleDelete}
              />
            ))}
          </div>
        </Dialog>
      )}
    </div>
  );
}
