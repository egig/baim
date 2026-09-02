import { Segmented } from "../../components/Segmented";
import { Button } from "../../root";
import {
  IconArrowsSort,
  IconFilter,
  IconLayoutGrid,
  IconList,
  IconUpload,
} from "../../lib/icons";
import { SORT_OPTIONS } from "./helpers";
import type { AssetFilter, AssetView } from "./types";
import { DropdownMenu } from "./DropdownMenu";

const FILTER_OPTIONS: { value: AssetFilter; label: string }[] = [
  { value: "all", label: "Semua" },
  { value: "source", label: "Sumber" },
  { value: "ai", label: "AI" },
  { value: "novariant", label: "Tanpa Varian" },
];

/** Top toolbar for the asset library: page title, origin filter and sort as
 *  two separate dropdown buttons, search, grid/list toggle, bulk-select mode,
 *  and upload. The active-folder switcher lives in the sidebar header now.
 *  Purely controlled — all state lives in the parent route. */
export function AssetToolbar({
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
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: "var(--ink-800)",
          flexShrink: 0,
        }}
      >
        Semua Berkas
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
        {visibleCount}
      </span>

      <DropdownMenu
        icon={<IconFilter size={13} stroke={1.8} />}
        idleLabel="Filter"
        title="Filter asal gambar"
        iconOnly
        options={FILTER_OPTIONS}
        value={filter}
        onChange={onFilterChange}
        highlightWhenActive={(v) => v !== "all"}
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

      <DropdownMenu
        icon={<IconArrowsSort size={13} stroke={1.8} />}
        idleLabel="Urutkan"
        title="Urutkan"
        iconOnly
        options={SORT_OPTIONS}
        value={sortValue}
        onChange={onSortChange}
      />

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
