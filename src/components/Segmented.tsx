import type { ReactNode } from "react";

/** Inline segmented control: a pill group where one option is active. Generic
 *  over the option value so it drives both the origin filter and the view toggle. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: ReactNode; title?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        padding: 2,
        gap: 2,
        borderRadius: "var(--r-control)",
        background: "var(--fill-1)",
        border: "1px solid var(--line-3)",
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            title={opt.title}
            onClick={() => onChange(opt.value)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              minHeight: 22,
              padding: "0 9px",
              border: "none",
              borderRadius: "var(--r-badge-sm)",
              cursor: "pointer",
              fontSize: 11.5,
              fontWeight: 600,
              lineHeight: 1,
              color: active ? "var(--indigo-600)" : "var(--ink-500)",
              background: active ? "var(--surface-0)" : "transparent",
              boxShadow: active ? "0 1px 2px rgba(0,0,0,.06)" : "none",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
