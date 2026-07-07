import type { ReactNode } from "react";

export function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
    >
      <span style={{ fontSize: 11.5, color: "var(--ink-500)" }}>{label}</span>
      {children}
    </div>
  );
}
