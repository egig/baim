import { Outlet } from "react-router";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import {
  applyRateLimitSignal,
  dirListingQuery,
  generationsQuery,
  isActive,
} from "./lib/queries";
import Settings from "./routes/settings";
import { Sidebar } from "./components/Sidebar";
import { ChatPane } from "./components/ChatPane";
import { IconX } from "./lib/icons";

/** Height of the custom titlebar (drag region + traffic-light space on
 *  macOS). Full-window overlays sit below this so they never cover it. */
const TITLEBAR_HEIGHT = 32;

/* ---------- escape layering ---------- */

/** Stack of dismissable layers (dialogs, panels, lightboxes). A single window
 *  listener closes only the topmost layer per Escape press, so nested overlays
 *  unwind one at a time instead of all at once. */
const escapeLayers: (() => void)[] = [];
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && escapeLayers.length > 0) {
    escapeLayers[escapeLayers.length - 1]();
  }
});

/** Register the calling component as the current topmost Escape target for as
 *  long as it stays mounted. */
export function useEscapeLayer(onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const layer = () => closeRef.current();
    escapeLayers.push(layer);
    return () => {
      const i = escapeLayers.indexOf(layer);
      if (i !== -1) escapeLayers.splice(i, 1);
    };
  }, []);
}

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
  useEscapeLayer(onClose);

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
        <IconX size={14} />
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

/** Centered modal over a scrim. Closes on Escape (topmost-layer only) and
 *  backdrop click; clicks inside the panel are swallowed. Sits below the
 *  ImageViewer (z 1000) so a lightbox opened from a dialog covers it. */
export function Dialog({
  width,
  height,
  onClose,
  children,
}: {
  width: number | string;
  height?: number | string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEscapeLayer(onClose);
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 900,
        background: "rgba(15,18,26,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width,
          height,
          maxWidth: "94vw",
          maxHeight: "88vh",
          background: "var(--surface-1)",
          border: "1px solid var(--line-3)",
          borderRadius: "var(--r-window)",
          boxShadow: "0 24px 64px rgba(0,0,0,.28)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/* ---------- shell context ---------- */

interface ShellValue {
  openSettings: () => void;
  /** The folder the browser is currently showing. `null` until the initial
   *  `list_dir` resolution (last-visited folder, or home) lands. Lifted up
   *  here — rather than owned by the browser route — because the sidebar's
   *  favorites/recents also need to trigger and reflect navigation. */
  currentPath: string | null;
  navigateTo: (path: string) => void;
  /** Files attached to the next chat message, picked in the browser.
   *  Lifted here for the same reason: the browser sets them, the chat pane
   *  reads/clears them. */
  attachments: string[];
  toggleAttachment: (path: string) => void;
  /** Replaces the whole attachment list with just this file — the plain-click
   *  behavior in the browser, so picking a new file doesn't pile onto
   *  whatever was attached before. Clicking the sole attached file again
   *  clears it. */
  selectAttachment: (path: string) => void;
  clearAttachments: () => void;
}

const ShellContext = createContext<ShellValue>({
  openSettings: () => {},
  currentPath: null,
  navigateTo: () => {},
  attachments: [],
  toggleAttachment: () => {},
  selectAttachment: () => {},
  clearAttachments: () => {},
});

/** Shell actions/state shared between the sidebar, the routed browser page,
 *  and the always-mounted chat pane. */
export function useShell() {
  return useContext(ShellContext);
}

/* ---------- titlebar ---------- */

/** Bare custom titlebar: a drag region that also reserves space for the macOS
 *  traffic lights. Navigation and shell actions live in the `Sidebar` now. */
function Titlebar() {
  return (
    <div
      data-tauri-drag-region
      style={{
        height: TITLEBAR_HEIGHT,
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
  // and draining regardless of route; the count drives the sidebar's Riwayat badge.
  const { data: activeCount = 0 } = useQuery({
    ...generationsQuery,
    select: (gens) => gens.filter(isActive).length,
  });

  // The folder the browser shows. Starts unresolved; the bootstrap query
  // below resolves it once (backend: last-visited folder, else home) and
  // every explicit `navigateTo` after that is just a plain state update —
  // no route param, so it survives switching to Templates/History and back.
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const { data: bootListing } = useQuery({
    ...dirListingQuery(undefined),
    enabled: currentPath === null,
  });
  useEffect(() => {
    if (currentPath === null && bootListing) setCurrentPath(bootListing.path);
  }, [currentPath, bootListing]);
  const navigateTo = useCallback((path: string) => setCurrentPath(path), []);

  const [attachments, setAttachments] = useState<string[]>([]);
  const toggleAttachment = useCallback((path: string) => {
    setAttachments((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]
    );
  }, []);
  const selectAttachment = useCallback((path: string) => {
    setAttachments((prev) => (prev.length === 1 && prev[0] === path ? [] : [path]));
  }, []);
  const clearAttachments = useCallback(() => setAttachments([]), []);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeDialog = () => setSettingsOpen(false);

  // A detached Interactions-mode task (see generation.rs::spawn_interaction)
  // can hit a rate limit after its own submit_queued tick already returned,
  // so it can't ride along in that call's SubmitOutcome like the synchronous
  // Batch path does — it emits this event instead. No query invalidation
  // needed here: the reverted row is already persisted before the event
  // fires, and generationsQuery's own 2s refetchInterval picks it up. This
  // listener's only job is nudging the in-memory AIMD state.
  useEffect(() => {
    const unlisten = listen("generation-rate-limited", () =>
      applyRateLimitSignal()
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const shell = useMemo<ShellValue>(
    () => ({
      openSettings: () => setSettingsOpen(true),
      currentPath,
      navigateTo,
      attachments,
      toggleAttachment,
      selectAttachment,
      clearAttachments,
    }),
    [currentPath, navigateTo, attachments, toggleAttachment, selectAttachment, clearAttachments]
  );

  return (
    <ShellContext.Provider value={shell}>
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
        <div
          style={{
            flex: 1,
            display: "flex",
            minWidth: 0,
            minHeight: 0,
          }}
        >
          <Sidebar activeCount={activeCount} onOpenSettings={shell.openSettings} />
          <div
            style={{
              flex: 2,
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              minHeight: 0,
            }}
          >
            <Outlet />
          </div>
          <ChatPane />
        </div>

        {settingsOpen && (
          <Dialog width={540} onClose={closeDialog}>
            <Settings onClose={closeDialog} />
          </Dialog>
        )}
      </div>
    </ShellContext.Provider>
  );
}
