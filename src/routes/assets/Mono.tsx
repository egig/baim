import type { ReactNode } from "react";

export function Mono({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11.5,
        color: "var(--ink-700)",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {children}
    </span>
  );
}
