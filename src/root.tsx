import { Link, Outlet, useLocation } from "react-router";
import { memo, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { generationsQuery, isActive } from "./lib/queries";

/* ---------- shared primitives ---------- */

/** Full-screen lightbox: a dark scrim with the image fit to the viewport.
 *  Dismissed via Escape, backdrop click, or the close button — clicking the
 *  image itself is swallowed so it doesn't count as a backdrop click. Shared by
 *  the assets library and the generation detail panel. */
export const ImageViewer = memo(function ImageViewer({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.82)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "zoom-out",
      }}
    >
      <img
        src={src}
        alt={alt ?? ""}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: "92vw",
          maxHeight: "92vh",
          objectFit: "contain",
          borderRadius: "var(--r-card)",
          cursor: "default",
        }}
      />
      <div
        onClick={onClose}
        style={{
          position: "absolute",
          top: 18,
          right: 18,
          width: 34,
          height: 34,
          borderRadius: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          color: "#fff",
          background: "rgba(255,255,255,.14)",
        }}
      >
        <svg width="14" height="14" viewBox="0 0 12 12">
          <path
            d="M2.5 2.5l7 7M9.5 2.5l-7 7"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  );
});

type ButtonVariant = "primary" | "outline" | "ghost" | "danger";

export function Button({
  variant,
  onClick,
  disabled,
  children,
}: {
  variant: ButtonVariant;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const base: React.CSSProperties = {
    height: 32,
    padding: "0 12px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: "var(--r-button)",
    fontFamily: "var(--font-ui)",
    fontSize: 12.5,
    fontWeight: 600,
    lineHeight: 1,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    border: "1px solid transparent",
    whiteSpace: "nowrap",
    transition: "background .12s, border-color .12s",
  };
  const byVariant: Record<ButtonVariant, React.CSSProperties> = {
    primary: { background: "var(--indigo-500)", color: "#fff" },
    outline: {
      background: "var(--surface-0)",
      borderColor: "var(--line-4)",
      color: "var(--ink-700)",
    },
    ghost: { background: "transparent", color: "var(--ink-500)" },
    danger: {
      background: "var(--surface-0)",
      borderColor: "var(--line-4)",
      color: "var(--red-600)",
    },
  };
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{ ...base, ...byVariant[variant] }}
    >
      {children}
    </button>
  );
}

function NavItem({
  to,
  label,
  icon,
  count,
}: {
  to: string;
  label: string;
  icon: ReactNode;
  count?: number;
}) {
  const location = useLocation();
  const active = location.pathname === to;
  return (
    <Link
      to={to}
      style={{
        height: 30,
        padding: "0 8px",
        display: "flex",
        alignItems: "center",
        gap: 9,
        borderRadius: 6,
        cursor: "pointer",
        textDecoration: "none",
        background: active ? "var(--fill-1)" : "transparent",
        color: active ? "var(--ink-900)" : "var(--ink-700)",
        fontSize: 12.5,
        fontWeight: active ? 600 : 500,
      }}
    >
      <span style={{ display: "flex", opacity: 0.85 }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {count != null && (
        <span
          style={{
            fontSize: 11,
            color: "var(--ink-400)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {count}
        </span>
      )}
    </Link>
  );
}

function strokePath(d: string) {
  return (
    <path
      d={d}
      stroke="currentColor"
      strokeWidth={1.2}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

const iconLibrary = (
  <svg width="15" height="15" viewBox="0 0 15 15" style={{ color: "var(--ink-700)" }}>
    {strokePath("M2 2.4h4.5v4.5H2zM8.5 2.4H13v4.5H8.5zM2 8.9h4.5v3.7H2zM8.5 8.9H13v3.7H8.5z")}
  </svg>
);

const iconQueue = (
  <svg width="15" height="15" viewBox="0 0 15 15" style={{ color: "var(--ink-700)" }}>
    {strokePath("M2.5 3.5h10M2.5 7.5h10M2.5 11.5h10")}
  </svg>
);

/* ---------- titlebar ---------- */

function Titlebar() {
  return (
    <div
      data-tauri-drag-region
      style={{
        height: 32,
        flexShrink: 0,
        background: "var(--surface-2)",
        borderBottom: "1px solid var(--line-1)",
      }}
    />
  );
}

/* ---------- shell ---------- */

export default function Root() {
  // Observing the queue engine from the always-mounted shell keeps it polling
  // and draining on every route; the count drives the sidebar badge.
  const { data: activeCount = 0 } = useQuery({
    ...generationsQuery,
    select: (gens) => gens.filter(isActive).length,
  });

  return (
    <div
      className="assets-app"
      style={{
        height: "100vh",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Titlebar />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Sidebar */}
        <div
          style={{
            width: 240,
            flexShrink: 0,
            background: "var(--surface-2)",
            borderRight: "1px solid var(--line-1)",
            display: "flex",
            flexDirection: "column",
          }}
        >

          {/* Nav */}
          <div style={{ padding: "2px 10px", display: "flex", flexDirection: "column", gap: 1 }}>
            <NavItem to="/" label="Daftar Gambar" icon={iconLibrary} />
            <NavItem
              to="/generations"
              label="Antrean"
              icon={iconQueue}
              count={activeCount > 0 ? activeCount : undefined}
            />
          </div>

              

          <div style={{ flex: 1 }} />

          {/* API Key link */}
          <div
            style={{
              padding: "12px 14px",
              borderTop: "1px solid var(--line-1)",
              display: "flex",
              alignItems: "center",
              gap: 9,
            }}
          >
            <Link
              to="/settings"
              style={{
                textDecoration: "none",
                display: "flex",
                alignItems: "center",
                gap: 9,
                flex: 1,
              }}
            >
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  background: "var(--indigo-100)",
                  color: "var(--indigo-500)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11.5,
                  fontWeight: 700,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 15 15">
                  {strokePath("M6.5 9.5A3 3 0 1 0 3 5.5a3 3 0 0 0 3.5 4v3.5h2v-2h2v-1.5h.5")}
                  {strokePath("M9 7.5h.01")}
                </svg>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-800)" }}>Pengaturan</div>
                <div style={{ fontSize: 11, color: "var(--ink-500)" }}>API key &amp; penyimpanan</div>
              </div>
            </Link>
          </div>
        </div>

        {/* Main content */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          <Outlet />
        </div>
      </div>
    </div>
  );
}
