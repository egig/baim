import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ask } from "@tauri-apps/plugin-dialog";
import { templatesQuery } from "../../lib/queries";
import { mergeTemplates } from "../../lib/templates";
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
 *  Self-fetches saved templates (`templatesQuery`) and merges them with the
 *  built-in catalog: saved templates render first under "Templat saya" (only
 *  ~1 row inline, with a "More templates" overflow dialog beyond that),
 *  built-ins render below under "Bawaan". Only saved tiles get hover
 *  rename/delete affordances. */
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
  const all = useMemo(() => mergeTemplates(saved), [saved]);
  const savedList = useMemo(() => all.filter((t) => !t.isBuiltIn), [all]);
  const builtIns = useMemo(() => all.filter((t) => t.isBuiltIn), [all]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(wrapRef, 0, savedList.length);
  const perRow = Math.max(1, Math.floor((width + GAP) / (TILE_WIDTH + GAP)));
  const overflow = savedList.length > perRow;
  const visibleSaved = savedList.slice(0, perRow);
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
      {savedList.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={sectionLabel}>Templat saya</div>
          <div style={grid}>
            {visibleSaved.map((t) => (
              <TemplateTile
                key={t.id}
                t={t}
                selected={selected.has(t.id)}
                onToggle={onToggle}
                editable
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
              Lebih banyak templat ({savedList.length})
            </button>
          )}
        </div>
      )}

      <div style={sectionLabel}>Bawaan</div>
      <div style={grid}>
        {builtIns.map((t) => (
          <TemplateTile
            key={t.id}
            t={t}
            selected={selected.has(t.id)}
            onToggle={onToggle}
            editable={false}
          />
        ))}
      </div>

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
            {savedList.map((t) => (
              <TemplateTile
                key={t.id}
                t={t}
                selected={selected.has(t.id)}
                onToggle={onToggle}
                editable
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
