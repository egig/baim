import { Link, Outlet, useLocation } from "react-router";
import type { ReactNode } from "react";

/* ---------- shared primitives ---------- */

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



/* ---------- shell ---------- */

export default function Root() {
  return (
    <div className="assets-app" style={{ height: "100vh", display: "flex" }}>
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
        {/* Brand */}
        <div
          style={{
            margin: "12px 10px 10px",
            padding: "7px 8px",
            display: "flex",
            alignItems: "center",
            gap: 9,
          }}
        >
          <div
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              background: "linear-gradient(150deg,#5e6ad2,#8b93e8)",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            R
          </div>
          <div style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: "var(--ink-800)" }}>
            Recraftory Business
          </div>
        </div>

        {/* Nav */}
        <div style={{ padding: "2px 10px", display: "flex", flexDirection: "column", gap: 1 }}>
          <NavItem to="/" label="Daftar Gambar" icon={iconLibrary} />
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
  );
}
