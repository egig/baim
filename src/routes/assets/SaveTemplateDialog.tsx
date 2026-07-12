import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dialog } from "../../root";
import { IconX } from "../../lib/icons";
import { templatesQuery } from "../../lib/queries";
import { saveTemplate } from "../../lib/tauri";

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

/** Dialog for turning an asset's originating prompt into a reusable, named
 *  template. Both name and prompt are editable (prompt prefilled from the
 *  generation) so the user can generalize it before saving. Triggered from
 *  `DetailPanel`'s "Prompt" card. */
export function SaveTemplateDialog({
  initialPrompt,
  sourceImagePath,
  onClose,
  onSaved,
}: {
  initialPrompt: string;
  sourceImagePath: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState(initialPrompt);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled = !name.trim() || !prompt.trim() || saving;

  async function save() {
    if (disabled) return;
    setSaving(true);
    setError(null);
    try {
      await saveTemplate(name.trim(), prompt.trim(), sourceImagePath);
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
          Simpan sebagai templat
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
        }}
      >
        <div>
          <label style={labelStyle} htmlFor="template-name">
            Nama templat
          </label>
          <input
            id="template-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="mis. Latar putih studio"
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle} htmlFor="template-prompt">
            Prompt
          </label>
          <textarea
            id="template-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            style={{
              ...inputStyle,
              minHeight: 100,
              resize: "none",
              lineHeight: 1.45,
            }}
          />
        </div>

        {error && (
          <div style={{ fontSize: 11.5, color: "var(--red-600)", lineHeight: 1.45 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Button variant="primary" disabled={disabled} onClick={save}>
            {saving ? "Menyimpan…" : "Simpan templat"}
          </Button>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            Batal
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
