import type { ReactNode } from "react";
import { NavLink, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  listFavorites,
  listLocations,
  RECENT_VIRTUAL_PATH,
  type FavoriteEntry,
  type LocationEntry,
} from "../lib/tauri";
import { useT } from "../lib/i18n";
import { useShell } from "../root";
import {
  IconStack2,
  IconHistory,
  IconClock,
  IconDeviceSdCard,
  IconSettings,
  IconHome,
  IconDeviceDesktop,
  IconPhoto,
  IconDownload,
  IconFolder,
} from "../lib/icons";

/** Top-level routes, one entry per page. `end` on "/" so it isn't marked
 *  active for `/templates` and `/history` too. */
const NAV: { to: string; labelKey: string; icon: ReactNode; end?: boolean }[] = [
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
 *  starter set (Home/Desktop/Pictures/Downloads); "Recent" is a virtual
 *  folder of files recently clicked/viewed in the browser (see
 *  `RECENT_VIRTUAL_PATH`, detected by the browser route); "Locations" lists
 *  mounted external/secondary volumes (not the root/boot disk), live from
 *  the OS and hidden entirely when there are none. All of these just move
 *  the shared `currentPath` (see root.tsx) and route to "/" — they aren't
 *  routes of their own. Below that, the two fixed pages. `activeCount`
 *  (queued + in-flight generations) drives the History badge;
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
  const { currentPath, navigateTo } = useShell();

  const { data: favorites = [] } = useQuery({
    queryKey: ["favorites"] as const,
    queryFn: listFavorites,
    staleTime: Infinity,
  });
  // No explicit staleTime: default (0) means this refetches on window focus
  // and on mount, which is as live as "Locations" needs to be — a plugged-in
  // drive shows up next time you look, without a background watcher.
  const { data: locations = [] } = useQuery({
    queryKey: ["locations"] as const,
    queryFn: listLocations,
  });

  function goTo(path: string) {
    navigateTo(path);
    navigate("/");
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

      <div style={{ padding: "0 8px" }}>
        <button
          type="button"
          className="nav-row"
          onClick={() => goTo(RECENT_VIRTUAL_PATH)}
          style={
            currentPath === RECENT_VIRTUAL_PATH
              ? { ...rowStyle, color: "var(--indigo-600)", background: "var(--indigo-100)" }
              : rowStyle
          }
        >
          <IconClock size={14} stroke={1.6} />
          <span style={{ flex: 1 }}>{t("sidebar.recent")}</span>
        </button>
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

      {locations.length > 0 && (
        <div>
          <div style={sectionLabelStyle}>{t("sidebar.locations")}</div>
          <div style={{ padding: "0 8px", display: "flex", flexDirection: "column", gap: 1 }}>
            {locations.map((loc: LocationEntry) => (
              <button
                key={loc.path}
                type="button"
                className="nav-row"
                onClick={() => goTo(loc.path)}
                title={loc.path}
                style={
                  currentPath === loc.path
                    ? { ...rowStyle, color: "var(--indigo-600)", background: "var(--indigo-100)" }
                    : rowStyle
                }
              >
                <IconDeviceSdCard size={14} stroke={1.6} />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {loc.label}
                </span>
              </button>
            ))}
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
