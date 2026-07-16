import { Segmented } from "../../components/Segmented";
import { Button } from "../../root";
import { IconLayoutGrid, IconList, IconUpload } from "../../lib/icons";
import { SORT_OPTIONS } from "./helpers";
import type { AssetFilter, AssetView } from "./types";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import type { WorkspaceInfo } from "../../lib/tauri";

/** Top toolbar for the asset library: workspace switcher, origin filter,
 *  search, sort, grid/list toggle, bulk-select mode, and upload. Purely
 *  controlled — all state lives in the parent route. */
export function AssetToolbar({
  activeWorkspace,
  visibleCount,
  filter,
  onFilterChange,
  search,
  onSearchChange,
  sortValue,
  onSortChange,
  view,
  onViewChange,
  selectMode,
  selectedCount,
  onToggleSelectMode,
  onUploadClick,
}: {
  activeWorkspace: WorkspaceInfo | undefined;
  visibleCount: number;
  filter: AssetFilter;
  onFilterChange: (v: AssetFilter) => void;
  search: string;
  onSearchChange: (v: string) => void;
  sortValue: string;
  onSortChange: (v: string) => void;
  view: AssetView;
  onViewChange: (v: AssetView) => void;
  selectMode: boolean;
  selectedCount: number;
  onToggleSelectMode: () => void;
  onUploadClick: () => void;
}) {
  return (
    <div
      style={{
        height: 52,
        flexShrink: 0,
        borderBottom: "1px solid var(--line-1)",
        display: "flex",
        alignItems: "center",
        padding: "0 20px",
        gap: 12,
        // Below the window min-width the controls can't all fit; scroll the
        // toolbar horizontally instead of clipping them off the right edge.
        overflowX: "auto",
      }}
    >
      {activeWorkspace ? (
        <WorkspaceSwitcher activeWorkspace={activeWorkspace} />
      ) : (
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-800)", flexShrink: 0 }}>
          Daftar Gambar
        </div>
      )}
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
        {visibleCount}
      </span>

      <Segmented
        options={[
          { value: "all", label: "Semua" },
          { value: "source", label: "Sumber" },
          { value: "ai", label: "AI" },
          { value: "novariant", label: "Tanpa Varian" },
        ]}
        value={filter}
        onChange={onFilterChange}
      />

      <input
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Cari nama atau prompt…"
        style={{
          height: 26,
          width: 200,
          flexShrink: 0,
          border: "1px solid var(--line-3)",
          borderRadius: "var(--r-control)",
          padding: "0 10px",
          fontFamily: "var(--font-ui)",
          fontSize: 12,
          color: "var(--ink-800)",
          background: "var(--surface-0)",
          outline: "none",
        }}
      />

      <div style={{ flex: 1 }} />

      <select
        value={sortValue}
        onChange={(e) => onSortChange(e.target.value)}
        title="Urutkan"
        style={{
          height: 26,
          flexShrink: 0,
          border: "1px solid var(--line-3)",
          borderRadius: "var(--r-control)",
          padding: "0 8px",
          fontFamily: "var(--font-ui)",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--ink-700)",
          background: "var(--surface-0)",
          cursor: "pointer",
          outline: "none",
        }}
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <Segmented
        options={[
          { value: "grid", label: <IconLayoutGrid size={14} />, title: "Tampilan petak" },
          { value: "list", label: <IconList size={14} />, title: "Tampilan daftar" },
        ]}
        value={view}
        onChange={onViewChange}
      />

      <Button variant={selectMode ? "primary" : "outline"} onClick={onToggleSelectMode}>
        {selectMode
          ? selectedCount > 0
            ? `${selectedCount} dipilih`
            : "Selesai"
          : "Pilih"}
      </Button>

      <Button variant="outline" onClick={onUploadClick}>
        <IconUpload size={14} color="var(--ink-700)" stroke={1.3} />
        Import gambar
      </Button>
    </div>
  );
}
