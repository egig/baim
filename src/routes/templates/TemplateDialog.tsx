import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dialog } from "../../root";
import { IconPhoto, IconX } from "../../lib/icons";
import { useT } from "../../lib/i18n";
import { templatesQuery } from "../../lib/queries";
import { fileToDataUri } from "../../lib/image";
import { createTemplate, updateTemplate } from "../../lib/tauri";
import type { PickerTemplate } from "../../lib/templates";

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 11px",
  border: "1px solid var(--line-4)",
  borderRadius: "var(--r-control)",
  fontSize: 12.5,
  fontFamily: "var(--font-ui)",
  color: "var(--ink-800)",
  background: "var(--surface-0)",
  outline: "none",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--ink-700)",
  marginBottom: 6,
  display: "block",
};

/** Create ("Tambah templat") or edit a saved prompt template from the Templat
 *  page: name, prompt, and an optional preview image. `template === null` means
 *  create; otherwise the fields prefill and only a newly-picked image replaces
 *  the existing preview. Distinct from `SaveTemplateDialog`, which turns an
 *  asset's originating prompt into a template using that asset as the preview. */
export function TemplateDialog({
  template,
  onClose,
  onSaved,
}: {
  template: PickerTemplate | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const qc = useQueryClient();
  const editing = template !== null;
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(template?.name ?? "");
  const [prompt, setPrompt] = useState(template?.prompt ?? "");
  // A freshly-picked preview, as a normalized PNG data URI. `null` means "keep
  // whatever the template already has" (or none, when creating).
  const [previewDataUri, setPreviewDataUri] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewSrc = previewDataUri ?? template?.imagePreview ?? "";
  const disabled = !name.trim() || !prompt.trim() || saving;

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !file.type.startsWith("image/")) return;
    try {
      setPreviewDataUri(await fileToDataUri(file));
    } catch (err) {
      setError(String(err));
    }
  }

  async function save() {
    if (disabled) return;
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await updateTemplate(
          template.id,
          name.trim(),
          prompt.trim(),
          previewDataUri ?? undefined
        );
      } else {
        await createTemplate(
          name.trim(),
          prompt.trim(),
          previewDataUri ?? undefined
        );
      }
      await qc.invalidateQueries({ queryKey: templatesQuery.queryKey });
      onSaved();
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  }

  return (
    <Dialog width={440} onClose={onClose}>
      <div
        style={{
          height: 52,
          flexShrink: 0,
          padding: "0 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-800)" }}>
          {editing ? t("templates.dialogEdit") : t("templates.dialogCreate")}
        </span>
        <div
          onClick={onClose}
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: "var(--ink-400)",
          }}
        >
          <IconX size={12} />
        </div>
      </div>

      <div
        style={{
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 16,
          overflow: "auto",
        }}
      >
        <div>
          <label style={labelStyle} htmlFor="template-name">
            {t("templates.nameLabel")}
          </label>
          <input
            id="template-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("templates.namePlaceholder")}
            style={inputStyle}
          />
        </div>

        <div>
          <label style={labelStyle} htmlFor="template-prompt">
            {t("templates.promptLabel")}
          </label>
          <textarea
            id="template-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("templates.promptPlaceholder")}
            style={{
              ...inputStyle,
              minHeight: 120,
              resize: "vertical",
              lineHeight: 1.45,
            }}
          />
        </div>

        <div>
          <label style={labelStyle}>{t("templates.previewLabel")}</label>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={onPickFile}
            style={{ display: "none" }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              onClick={() => fileRef.current?.click()}
              style={{
                width: 72,
                height: 72,
                flexShrink: 0,
                borderRadius: "var(--r-control)",
                border: "1px solid var(--line-3)",
                background: "var(--fill-1)",
                overflow: "hidden",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
              }}
            >
              {previewSrc ? (
                <img
                  src={previewSrc}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              ) : (
                <IconPhoto size={20} color="var(--ink-350)" stroke={1.5} />
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <Button variant="outline" onClick={() => fileRef.current?.click()}>
                {previewSrc
                  ? t("templates.changeImage")
                  : t("templates.pickImage")}
              </Button>
              {previewDataUri && (
                <button
                  type="button"
                  onClick={() => setPreviewDataUri(null)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: "var(--ink-400)",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  {t("templates.revertImage")}
                </button>
              )}
            </div>
          </div>
        </div>

        {error && (
          <div style={{ fontSize: 11.5, color: "var(--red-600)", lineHeight: 1.45 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Button variant="primary" disabled={disabled} onClick={save}>
            {saving
              ? t("common.saving")
              : editing
              ? t("templates.saveChanges")
              : t("templates.saveTemplate")}
          </Button>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
