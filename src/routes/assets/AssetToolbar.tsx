import { Segmented } from "../../components/Segmented";
import { Button } from "../../root";
import {
  IconArrowsSort,
  IconFilter,
  IconLayoutGrid,
  IconList,
  IconDownload
} from "../../lib/icons";
import { SORT_OPTIONS } from "./helpers";
import { useT } from "../../lib/i18n";
import type { AssetFilter, AssetView } from "./types";
import { DropdownMenu } from "./DropdownMenu";

const FILTER_OPTIONS: { value: AssetFilter; labelKey: string }[] = [
  { value: "all", labelKey: "assets.filterAll" },
  { value: "source", labelKey: "assets.filterSource" },
  { value: "ai", labelKey: "assets.filterAi" },
  { value: "novariant", labelKey: "assets.filterNoVariant" },
];

/** Top toolbar for the asset library: page title, origin filter and sort as
 *  two separate dropdown buttons, search, grid/list toggle, and upload. Bulk
 *  selection is driven by ⌘/Ctrl-clicking tiles, not a toolbar button. The
 *  active-folder switcher lives in the sidebar header now. Purely controlled —
 *  all state lives in the parent route. */
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
  onUploadClick: () => void;
}) {
  const { t } = useT();
  const filterOptions = FILTER_OPTIONS.map((o) => ({
    value: o.value,
    label: t(o.labelKey),
  }));
  const sortOptions = SORT_OPTIONS.map((o) => ({
    value: o.value,
    label: t(o.labelKey),
  }));
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
        {t("assets.title")}
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
        idleLabel={t("assets.filter")}
        title={t("assets.filterTitle")}
        iconOnly
        options={filterOptions}
        value={filter}
        onChange={onFilterChange}
        highlightWhenActive={(v) => v !== "all"}
      />

      <input
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={t("assets.searchPlaceholder")}
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
        idleLabel={t("assets.sort")}
        title={t("assets.sortTitle")}
        iconOnly
        options={sortOptions}
        value={sortValue}
        onChange={onSortChange}
      />

      <Segmented
        options={[
          { value: "grid", label: <IconLayoutGrid size={14} />, title: t("assets.gridView") },
          { value: "list", label: <IconList size={14} />, title: t("assets.listView") },
        ]}
        value={view}
        onChange={onViewChange}
      />

      <Button variant="outline" onClick={onUploadClick}>
        <IconDownload size={14} color="var(--ink-700)" stroke={1.3} />
        {t("assets.import")}
      </Button>
    </div>
  );
}
