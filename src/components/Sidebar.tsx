import type { ReactNode } from "react";
import { NavLink, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listFavorites,
  listRecentFolders,
  removeRecentFolder,
  type FavoriteEntry,
  type FolderRow,
} from "../lib/tauri";
import { useT } from "../lib/i18n";
import { useShell } from "../root";
import {
  IconLayoutGrid,
  IconStack2,
  IconHistory,
  IconSettings,
  IconHome,
  IconDeviceDesktop,
  IconPhoto,
  IconDownload,
  IconFolder,
  IconX,
} from "../lib/icons";

/** Top-level routes, one entry per page. `end` on "/" so it isn't marked
 *  active for `/templates` and `/history` too. */
const NAV: { to: string; labelKey: string; icon: ReactNode; end?: boolean }[] = [
  {
    to: "/",
    labelKey: "nav.files",
    icon: <IconLayoutGrid size={16} stroke={1.6} />,
    end: true,
  },
  {
    to: "/templates",
    labelKey: "nav.templates",
    icon: <IconStack2 size={16} stroke={1.6} />,
  },
  {
    to: "/history",
    labelKey: "nav.history",
    icon: <IconHistory size={16} stroke={1.6} />,
  },
];

const FAVORITE_ICONS: Record<string, ReactNode> = {
  Home: <IconHome size={14} stroke={1.6} />,
  Desktop: <IconDeviceDesktop size={14} stroke={1.6} />,
  Pictures: <IconPhoto size={14} stroke={1.6} />,
  Downloads: <IconDownload size={14} stroke={1.6} />,
};

const rowStyle: React.CSSProperties = {
  height: 30,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "0 10px",
  borderRadius: "var(--r-control)",
  fontFamily: "var(--font-ui)",
  fontSize: 12.5,
  fontWeight: 600,
  color: "var(--ink-500)",
  textDecoration: "none",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  width: "100%",
  textAlign: "left",
};

const sectionLabelStyle: React.CSSProperties = {
  padding: "10px 10px 4px",
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: ".04em",
  textTransform: "uppercase",
  color: "var(--ink-350)",
};

/** Left navigation rail: a Finder-style sidebar. Favorites is a fixed
 *  starter set (Home/Desktop/Pictures/Downloads); Recents is auto-tracked.
 *  Both just move the shared `currentPath` (see root.tsx) and route to "/"
 *  — they aren't routes of their own. Below that, the three fixed pages.
 *  `activeCount` (queued + in-flight generations) drives the History badge;
 *  `onOpenSettings` opens the settings dialog owned by the shell. */
export function Sidebar({
  activeCount,
  onOpenSettings,
}: {
  activeCount: number;
  onOpenSettings: () => void;
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { currentPath, navigateTo } = useShell();

  const { data: favorites = [] } = useQuery({
    queryKey: ["favorites"] as const,
    queryFn: listFavorites,
    staleTime: Infinity,
  });
  const recentsQueryKey = ["recentFolders"] as const;
  const { data: recents = [] } = useQuery({
    queryKey: recentsQueryKey,
    queryFn: listRecentFolders,
    staleTime: 5_000,
  });

  function goTo(path: string) {
    navigateTo(path);
    navigate("/");
  }

  async function onRemoveRecent(e: React.MouseEvent, path: string) {
    e.stopPropagation();
    await removeRecentFolder(path);
    void qc.invalidateQueries({ queryKey: recentsQueryKey });
  }

  return (
    <nav
      style={{
        width: 220,
        flexShrink: 0,
        background: "var(--surface-2)",
        borderRight: "1px solid var(--line-1)",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          padding: "10px 8px 6px",
          borderBottom: "1px solid var(--line-1)",
          minHeight: 44,
        }}
      >
        <span
          style={{
            padding: "0 8px",
            fontSize: 13,
            fontWeight: 700,
            color: "var(--ink-800)",
          }}
        >
          Baim
        </span>
      </div>

      <div style={{ padding: "4px 8px 0" }}>
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className="nav-row"
            style={({ isActive }) =>
              isActive
                ? { ...rowStyle, color: "var(--indigo-600)", background: "var(--indigo-100)" }
                : rowStyle
            }
          >
            {item.icon}
            <span style={{ flex: 1 }}>{t(item.labelKey)}</span>
            {item.to === "/history" && activeCount > 0 && (
              <span
                style={{
                  minWidth: 16,
                  height: 16,
                  padding: "0 4px",
                  borderRadius: 9999,
                  background: "var(--indigo-500)",
                  color: "#fff",
                  fontSize: 10,
                  fontWeight: 700,
                  lineHeight: "16px",
                  textAlign: "center",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {activeCount}
              </span>
            )}
          </NavLink>
        ))}
      </div>

      {favorites.length > 0 && (
        <div>
          <div style={sectionLabelStyle}>{t("sidebar.favorites")}</div>
          <div style={{ padding: "0 8px", display: "flex", flexDirection: "column", gap: 1 }}>
            {favorites.map((fav: FavoriteEntry) => (
              <button
                key={fav.path}
                type="button"
                className="nav-row"
                onClick={() => goTo(fav.path)}
                title={fav.path}
                style={
                  currentPath === fav.path
                    ? { ...rowStyle, color: "var(--indigo-600)", background: "var(--indigo-100)" }
                    : rowStyle
                }
              >
                {FAVORITE_ICONS[fav.label] ?? <IconFolder size={14} stroke={1.6} />}
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {t(`sidebar.fav.${fav.label}`) || fav.label}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {recents.length > 0 && (
        <div>
          <div style={sectionLabelStyle}>{t("sidebar.recents")}</div>
          <div style={{ padding: "0 8px", display: "flex", flexDirection: "column", gap: 1 }}>
            {recents.map((row: FolderRow) => {
              const name = row.path.split(/[\\/]/).filter(Boolean).pop() ?? row.path;
              return (
                <div
                  key={row.path}
                  onClick={() => goTo(row.path)}
                  title={row.path}
                  className="nav-row"
                  style={{
                    ...(currentPath === row.path
                      ? { color: "var(--indigo-600)", background: "var(--indigo-100)" }
                      : {}),
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "0 4px 0 10px",
                    height: 30,
                    borderRadius: "var(--r-control)",
                    cursor: "pointer",
                  }}
                >
                  <IconFolder size={14} stroke={1.6} style={{ flexShrink: 0 }} />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12.5,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {name}
                  </span>
                  <button
                    type="button"
                    title={t("sidebar.removeRecent")}
                    onClick={(e) => onRemoveRecent(e, row.path)}
                    style={{
                      flexShrink: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 20,
                      height: 20,
                      border: "none",
                      borderRadius: "var(--r-control)",
                      background: "transparent",
                      color: "var(--ink-400)",
                      cursor: "pointer",
                    }}
                  >
                    <IconX size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ flex: 1 }} />

      <div style={{ padding: "8px 8px", borderTop: "1px solid var(--line-1)" }}>
        <button type="button" className="nav-row" onClick={onOpenSettings} style={rowStyle}>
          <IconSettings size={16} stroke={1.6} />
          <span style={{ flex: 1 }}>{t("nav.settings")}</span>
        </button>
      </div>
    </nav>
  );
}
