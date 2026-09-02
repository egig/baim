import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ask } from "@tauri-apps/plugin-dialog";
import { templatesQuery } from "../../lib/queries";
import { toPickerTemplates } from "../../lib/templates";
import { deleteTemplate, renameTemplate } from "../../lib/tauri";
import { IconStack2 } from "../../lib/icons";
import { TemplateCard } from "./TemplateCard";

/** The Templat page: every saved prompt template (name + prompt + preview),
 *  with inline rename and delete. Templates are created elsewhere — via
 *  "Simpan sebagai templat" on a prompt in the asset detail panel — since that
 *  is where a source image (the required preview) is in hand. */
export default function Templates() {
  const qc = useQueryClient();
  const { data: saved = [] } = useQuery(templatesQuery);
  const templates = useMemo(() => toPickerTemplates(saved), [saved]);

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

  return (
    <>
      <div
        style={{
          height: 52,
          flexShrink: 0,
          borderBottom: "1px solid var(--line-1)",
          display: "flex",
          alignItems: "center",
          padding: "0 20px",
          gap: 12,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-800)" }}>
          Templat
        </div>
        <span
          style={{
            minWidth: 18,
            height: 18,
            padding: "0 6px",
            borderRadius: 9999,
            background: "var(--fill-1)",
            color: "var(--ink-500)",
            fontSize: 11,
            fontWeight: 600,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {templates.length}
        </span>
      </div>

      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        {templates.length === 0 ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              color: "var(--ink-400)",
              textAlign: "center",
              padding: "0 32px",
            }}
          >
            <IconStack2 size={22} stroke={1.5} />
            <div style={{ fontSize: 13, maxWidth: 340, lineHeight: 1.5 }}>
              Belum ada templat. Buat satu lewat "Simpan sebagai templat" pada
              prompt yang pernah dipakai di panel detail aset.
            </div>
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
              gap: 14,
              padding: 20,
              alignContent: "start",
            }}
          >
            {templates.map((t) => (
              <TemplateCard
                key={t.id}
                t={t}
                onRename={handleRename}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
