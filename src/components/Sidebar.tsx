import type { ReactNode } from "react";
import { NavLink } from "react-router";
import type { WorkspaceInfo } from "../lib/tauri";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import {
  IconLayoutGrid,
  IconStack2,
  IconHistory,
  IconSettings,
} from "../lib/icons";

/** Primary navigation, one entry per top-level route. `end` on "/" so it isn't
 *  marked active for `/templates` and `/history` too. */
const NAV: { to: string; label: string; icon: ReactNode; end?: boolean }[] = [
  {
    to: "/",
    label: "Semua Berkas",
    icon: <IconLayoutGrid size={16} stroke={1.6} />,
    end: true,
  },
  {
    to: "/templates",
    label: "Templat",
    icon: <IconStack2 size={16} stroke={1.6} />,
  },
  {
    to: "/history",
    label: "Riwayat",
    icon: <IconHistory size={16} stroke={1.6} />,
  },
];

const rowStyle: React.CSSProperties = {
  height: 32,
  display: "flex",
  alignItems: "center",
  gap: 9,
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

/** Left navigation rail. The header hosts the global `WorkspaceSwitcher` (the
 *  active folder every route depends on). `activeCount` (queued + in-flight
 *  generations) drives the badge on the Riwayat row; the Pengaturan button at
 *  the foot opens the settings dialog owned by the shell. */
export function Sidebar({
  activeWorkspace,
  activeCount,
  onOpenSettings,
}: {
  activeWorkspace: WorkspaceInfo | undefined;
  activeCount: number;
  onOpenSettings: () => void;
}) {
  return (
    <nav
      style={{
        width: 200,
        flexShrink: 0,
        background: "var(--surface-2)",
        borderRight: "1px solid var(--line-1)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          padding: "8px 8px 6px",
          borderBottom: "1px solid var(--line-1)",
          minHeight: 44,
        }}
      >
        {activeWorkspace ? (
          <WorkspaceSwitcher activeWorkspace={activeWorkspace} />
        ) : (
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
        )}
      </div>

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: 2,
          padding: "4px 8px",
        }}
      >
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className="nav-row"
            style={({ isActive }) =>
              isActive
                ? {
                    ...rowStyle,
                    color: "var(--indigo-600)",
                    background: "var(--indigo-100)",
                  }
                : rowStyle
            }
          >
            {item.icon}
            <span style={{ flex: 1 }}>{item.label}</span>
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

      <div style={{ padding: "4px 8px 8px" }}>
        <button
          type="button"
          className="nav-row"
          onClick={onOpenSettings}
          style={rowStyle}
        >
          <IconSettings size={16} stroke={1.6} />
          <span style={{ flex: 1 }}>Pengaturan</span>
        </button>
      </div>
    </nav>
  );
}
