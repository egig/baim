import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ask } from "@tauri-apps/plugin-dialog";
import { templatesQuery } from "../../lib/queries";
import { toPickerTemplates } from "../../lib/templates";
import { deleteTemplate, renameTemplate } from "../../lib/tauri";
import { Dialog } from "../../root";
import { IconBookmarkPlus, IconLayoutGrid } from "../../lib/icons";
import { TemplateTile } from "./TemplateTile";

const GAP = 10;

/** Generation-template chooser. Shared by the single-asset detail panel and
 *  the bulk (multi-image) panel.
 *
 *  Only the *selected* templates render inline (their previews). A "Pilih
 *  templat" button opens a dialog listing every template for multi-select —
 *  so the inline footprint stays fixed regardless of how many templates the
 *  user has saved.
 *
 *  Self-fetches templates (`templatesQuery`, most-recently-created first —
 *  includes the seeded starter templates as regular rows). */
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
  const chosen = useMemo(
    () => all.filter((t) => selected.has(t.id)),
    [all, selected]
  );
  const [pickerOpen, setPickerOpen] = useState(false);

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

  if (all.length === 0) {
    return (
      <div
        style={{
          marginBottom,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          padding: "18px 12px",
          borderRadius: "var(--r-control)",
          border: "1px dashed var(--line-3)",
          background: "var(--fill-1)",
          textAlign: "center",
        }}
      >
        <IconBookmarkPlus size={16} color="var(--ink-400)" />
        <span style={{ fontSize: 11.5, color: "var(--ink-500)", lineHeight: 1.45 }}>
          Belum ada templat. Buat satu lewat "Simpan sebagai templat" pada
          prompt yang pernah dipakai, atau gunakan tab "Prompt manual".
        </span>
      </div>
    );
  }

  return (
    <div style={{ marginBottom }}>
      {chosen.length > 0 && (
        <div style={{ ...grid, marginBottom: 10 }}>
          {chosen.map((t) => (
            <TemplateTile
              key={t.id}
              t={t}
              selected
              onToggle={onToggle}
              onRename={handleRename}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 30,
          padding: "0 12px",
          borderRadius: "var(--r-button)",
          border: "1px solid var(--line-4)",
          background: "var(--surface-0)",
          color: "var(--ink-700)",
          fontFamily: "var(--font-ui)",
          fontSize: 11.5,
          fontWeight: 600,
          lineHeight: 1,
          cursor: "pointer",
        }}
      >
        <IconLayoutGrid size={13} color="var(--ink-500)" />
        {chosen.length > 0
          ? `Ubah pilihan (${chosen.length})`
          : "Pilih templat"}
      </button>

      {pickerOpen && (
        <Dialog
          width="min(560px, 90vw)"
          height="min(520px, 80vh)"
          onClose={() => setPickerOpen(false)}
        >
          <div
            style={{
              padding: "14px 18px",
              borderBottom: "1px solid var(--line-1)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ink-800)",
            }}
          >
            <span>Pilih templat</span>
            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--ink-500)" }}>
              {selected.size} dipilih
            </span>
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
          <div
            style={{
              padding: "12px 18px",
              borderTop: "1px solid var(--line-1)",
              display: "flex",
              justifyContent: "flex-end",
            }}
          >
            <button
              type="button"
              onClick={() => setPickerOpen(false)}
              style={{
                height: 30,
                padding: "0 14px",
                borderRadius: "var(--r-button)",
                border: "1px solid var(--line-4)",
                background: "var(--surface-0)",
                color: "var(--ink-700)",
                fontFamily: "var(--font-ui)",
                fontSize: 11.5,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Selesai
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
