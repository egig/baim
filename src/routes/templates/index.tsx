import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ask } from "@tauri-apps/plugin-dialog";
import { templatesQuery } from "../../lib/queries";
import { toPickerTemplates, type PickerTemplate } from "../../lib/templates";
import { deleteTemplate } from "../../lib/tauri";
import { IconBookmarkPlus, IconStack2 } from "../../lib/icons";
import { Button } from "../../root";
import { TemplateCard } from "./TemplateCard";
import { TemplateDialog } from "./TemplateDialog";

/** The Templat page: every saved prompt template (name + prompt + preview),
 *  with full CRUD — "Tambah templat" creates one from scratch (name + prompt +
 *  optional preview image), each card edits or deletes. Templates can also be
 *  created elsewhere via "Simpan sebagai templat" on a prompt in the asset
 *  detail panel, where a source image for the preview is already in hand. */
export default function Templates() {
  const qc = useQueryClient();
  const { data: saved = [] } = useQuery(templatesQuery);
  const templates = useMemo(() => toPickerTemplates(saved), [saved]);

  // null = closed; { template: null } = create; { template } = edit that one.
  const [dialog, setDialog] = useState<{ template: PickerTemplate | null } | null>(
    null
  );

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
        <div style={{ flex: 1 }} />
        <Button variant="primary" onClick={() => setDialog({ template: null })}>
          <IconBookmarkPlus size={14} />
          Tambah templat
        </Button>
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
              Belum ada templat. Klik "Tambah templat" untuk membuat satu, atau
              gunakan "Simpan sebagai templat" pada prompt di panel detail aset.
            </div>
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(98px, 1fr))",
              gap: 10,
              padding: "20px 22px",
              alignContent: "start",
            }}
          >
            {templates.map((t) => (
              <TemplateCard
                key={t.id}
                t={t}
                onEdit={() => setDialog({ template: t })}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>

      {dialog && (
        <TemplateDialog
          template={dialog.template}
          onClose={() => setDialog(null)}
          onSaved={() => setDialog(null)}
        />
      )}
    </>
  );
}
