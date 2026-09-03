import { Button } from "../../root";
import { useT } from "../../lib/i18n";
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
  const { t } = useT();
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
          {t("bulk.title", { count: selectedCount })}
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
          {t("bulk.clearSelection")}
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
          {t("bulk.pickTemplateLabel")}
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
          {t("bulk.generateModeLabel")}
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
          {t("bulk.equation", {
            images: selectedCount,
            templates: selectedTemplates.size,
            jobs: jobCount,
          })}
        </div>

        <Button variant="primary" disabled={generating || jobCount === 0} onClick={onGenerateBulk}>
          <IconSparkles size={14} color="#fff" />
          {generating
            ? t("bulk.queueing")
            : t("bulk.generateN", { count: jobCount })}
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
          {t("bulk.queueNote")}
        </div>
      </div>

      <div style={{ height: 1, background: "var(--line-1)", margin: "2px 0" }} />

      <div style={{ padding: "16px 18px" }}>
        <Button variant="danger" disabled={deleting} onClick={onDeleteBulk}>
          <IconTrash size={14} color="var(--red-600)" stroke={1.2} />
          {deleting
            ? t("bulk.deleting")
            : t("bulk.deleteN", { count: selectedCount })}
        </Button>
      </div>
    </div>
  );
}
