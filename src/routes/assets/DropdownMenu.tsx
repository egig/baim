import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useEscapeLayer } from "../../root";
import { IconCheck, IconChevronDown } from "../../lib/icons";

const MENU_WIDTH = 180;

/** Single-select dropdown: a trigger button that opens a portaled list of
 *  options with a checkmark on the active one. Generic over the option value
 *  so it backs both the origin filter and the sort order — each gets its own
 *  trigger instead of being merged into one control. Follows the same
 *  portal-dropdown pattern as WorkspaceSwitcher. */
export function DropdownMenu<T extends string>({
  icon,
  idleLabel,
  title,
  iconOnly,
  options,
  value,
  onChange,
  highlightWhenActive,
}: {
  icon: ReactNode;
  /** Label shown on the trigger when the value has no active-highlight label
   *  (or `highlightWhenActive` is false). Ignored when `iconOnly`. */
  idleLabel: string;
  title: string;
  /** Collapse the trigger to just the icon + chevron (label moves to the
   *  `title` tooltip). The active-highlight background is still applied. */
  iconOnly?: boolean;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  /** When true, the trigger shows the active option's label and an indigo
   *  highlight instead of the idle label — for filters where one option
   *  (typically the first) is the unfiltered default. */
  highlightWhenActive?: (v: T) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEscapeLayer(() => setOpen(false));

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPos({
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !buttonRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    function onScrollOrResize() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [open]);

  const active = highlightWhenActive?.(value) ?? false;
  const activeLabel = options.find((o) => o.value === value)?.label;

  return (
    <div style={{ flexShrink: 0 }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title}
        style={{
          height: 26,
          display: "inline-flex",
          alignItems: "center",
          gap: iconOnly ? 3 : 6,
          border: "1px solid var(--line-3)",
          borderRadius: "var(--r-control)",
          background: active ? "var(--indigo-100)" : "var(--surface-0)",
          padding: iconOnly ? "0 6px" : "0 9px",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 600,
          color: active ? "var(--indigo-600)" : "var(--ink-700)",
        }}
      >
        {icon}
        {!iconOnly && (active ? activeLabel : idleLabel)}
        <IconChevronDown size={13} stroke={1.8} />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="assets-app"
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              width: MENU_WIDTH,
              background: "var(--surface-0)",
              border: "1px solid var(--line-3)",
              borderRadius: "var(--r-card)",
              boxShadow: "0 8px 24px rgba(0,0,0,.14)",
              zIndex: 1000,
              padding: 6,
            }}
          >
            {options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  padding: "7px 8px",
                  border: "none",
                  borderRadius: "var(--r-control)",
                  background:
                    opt.value === value ? "var(--fill-1)" : "transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: "var(--ink-800)",
                }}
              >
                {opt.label}
                {opt.value === value && (
                  <IconCheck size={14} stroke={2} color="var(--indigo-600)" />
                )}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}
