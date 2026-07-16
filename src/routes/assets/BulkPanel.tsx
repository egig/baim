import { Button } from "../../root";
import { IconSparkles, IconTrash } from "../../lib/icons";
import { TemplatePicker } from "./TemplatePicker";
import { Segmented } from "../../components/Segmented";
import type { ApiMode } from "../../lib/tauri";

/** Right-side panel shown in Select mode once ≥1 image is picked: a template
 *  picker fanned across every selected image (N images × M templates), plus
 *  a bulk-delete action for the same selection. */
export function BulkPanel({
  selectedCount,
  onClearSelection,
  selectedTemplates,
  onToggleTemplate,
  mode,
  onModeChange,
  jobCount,
  generating,
  onGenerateBulk,
  deleting,
  onDeleteBulk,
  error,
}: {
  selectedCount: number;
  onClearSelection: () => void;
  selectedTemplates: Set<string>;
  onToggleTemplate: (id: string) => void;
  mode: ApiMode;
  onModeChange: (mode: ApiMode) => void;
  jobCount: number;
  generating: boolean;
  onGenerateBulk: () => void;
  deleting: boolean;
  onDeleteBulk: () => void;
  error: string | null;
}) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 380,
        borderLeft: "1px solid var(--line-1)",
        background: "var(--surface-1)",
        display: "flex",
        flexDirection: "column",
        overflow: "auto",
      }}
    >
      <div
        style={{
          padding: "16px 18px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-800)" }}>
          Aksi massal · {selectedCount} gambar
        </span>
        <div
          onClick={onClearSelection}
          style={{
            fontSize: 12,
            color: "var(--indigo-600)",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Bersihkan
        </div>
      </div>

      <div style={{ padding: "16px 18px" }}>
        <div
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: ".04em",
            color: "var(--ink-350)",
            textTransform: "uppercase",
            marginBottom: 10,
          }}
        >
          Pilih templat
        </div>

        <TemplatePicker
          selected={selectedTemplates}
          onToggle={onToggleTemplate}
          marginBottom={14}
        />

        <div
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: ".04em",
            color: "var(--ink-350)",
            textTransform: "uppercase",
            marginBottom: 10,
          }}
        >
          Mode generate
        </div>
        <Segmented<ApiMode>
          options={[
            { value: "batch", label: "Batch" },
            { value: "interactions", label: "Interactions" },
          ]}
          value={mode}
          onChange={onModeChange}
        />

        <div
          style={{
            fontSize: 12,
            color: "var(--ink-500)",
            margin: "12px 0",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {selectedCount} gambar × {selectedTemplates.size} templat ={" "}
          <strong style={{ color: "var(--ink-800)" }}>{jobCount}</strong> tugas
        </div>

        <Button variant="primary" disabled={generating || jobCount === 0} onClick={onGenerateBulk}>
          <IconSparkles size={14} color="#fff" />
          {generating ? "Mengantre…" : `Hasilkan ${jobCount} varian`}
        </Button>

        {error && (
          <div
            style={{
              marginTop: 12,
              fontSize: 11.5,
              color: "var(--red-600)",
              lineHeight: 1.45,
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            marginTop: 12,
            fontSize: 11,
            color: "var(--ink-400)",
            lineHeight: 1.45,
          }}
        >
          Tugas masuk antrean dan diproses maksimal 3 sekaligus. Pantau di halaman
          Antrean.
        </div>
      </div>

      <div style={{ height: 1, background: "var(--line-1)", margin: "2px 0" }} />

      <div style={{ padding: "16px 18px" }}>
        <Button variant="danger" disabled={deleting} onClick={onDeleteBulk}>
          <IconTrash size={14} color="var(--red-600)" stroke={1.2} />
          {deleting ? "Menghapus…" : `Hapus ${selectedCount} gambar`}
        </Button>
      </div>
    </div>
  );
}
