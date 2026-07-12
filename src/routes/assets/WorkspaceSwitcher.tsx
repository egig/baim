import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import {
  forgetWorkspace,
  listWorkspaces,
  openWorkspace,
  type WorkspaceInfo,
} from "../../lib/tauri";
import { activeWorkspaceQuery, imagesQuery, generationsQuery } from "../../lib/queries";
import { useEscapeLayer } from "../../root";
import { IconChevronDown, IconFolder } from "../../lib/icons";

const workspacesQueryKey = ["workspaces"] as const;
const MENU_WIDTH = 280;

/** Replaces the old static "Daftar Gambar" title: a clickable control showing
 *  the active workspace's folder name, opening a dropdown of recent
 *  workspaces plus an "Open Folder…" action — the only place the active
 *  folder can be changed. The dropdown is rendered via a portal into
 *  `document.body`, positioned from the trigger button's viewport rect —
 *  the toolbar it lives in has `overflowX: "auto"`, which per the CSS spec
 *  implicitly computes `overflow-y` as `auto` too, so an absolutely
 *  positioned dropdown nested inside it gets clipped rather than floating
 *  above the grid below. */
export function WorkspaceSwitcher({
  activeWorkspace,
}: {
  activeWorkspace: WorkspaceInfo;
}) {
  const qc = useQueryClient();
  const [open_, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ path: string; message: string } | null>(
    null
  );
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const { data: workspaces = [] } = useQuery({
    queryKey: workspacesQueryKey,
    queryFn: listWorkspaces,
    enabled: open_,
    staleTime: 0,
  });

  useEscapeLayer(() => setOpen(false));

  // Position the portaled menu from the trigger button whenever it opens.
  useLayoutEffect(() => {
    if (!open_ || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPos({
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
    });
  }, [open_]);

  useEffect(() => {
    if (!open_) return;
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !buttonRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    // Closing on scroll/resize is simpler and safer than re-tracking the
    // trigger's position live — the menu can't drift out of alignment.
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
  }, [open_]);

  async function switchTo(path: string) {
    setBusy(true);
    setError(null);
    try {
      const info = await openWorkspace(path);
      qc.setQueryData(activeWorkspaceQuery.queryKey, info);
      await Promise.all([
        qc.invalidateQueries({ queryKey: imagesQuery(info.path).queryKey }),
        qc.invalidateQueries({
          queryKey: generationsQuery(info.path).queryKey,
        }),
        qc.invalidateQueries({ queryKey: workspacesQueryKey }),
      ]);
      setOpen(false);
    } catch (err) {
      setError({ path, message: String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function onOpenFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    await switchTo(selected);
  }

  async function onRemoveFromList(path: string) {
    await forgetWorkspace(path);
    setError(null);
    void qc.invalidateQueries({ queryKey: workspacesQueryKey });
  }

  return (
    <div style={{ flexShrink: 0 }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          padding: "4px 6px",
          marginLeft: -6,
          borderRadius: "var(--r-control)",
          fontSize: 14,
          fontWeight: 600,
          color: "var(--ink-800)",
        }}
        title={activeWorkspace.path}
      >
        {activeWorkspace.name}
        <IconChevronDown size={14} color="var(--ink-500)" stroke={1.6} />
      </button>

      {open_ &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            // The portal lifts this node out of `.assets-app` in the DOM
            // tree, and the app's CSS custom properties (--surface-0 etc.)
            // are scoped to that class — reapply it here so the tokens below
            // resolve instead of falling back to their unset/transparent
            // initial values.
            className="assets-app"
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              minWidth: MENU_WIDTH,
              maxWidth: 380,
              background: "var(--surface-0)",
              border: "1px solid var(--line-3)",
              borderRadius: "var(--r-card)",
              boxShadow: "0 8px 24px rgba(0,0,0,.14)",
              zIndex: 1000,
              padding: 6,
            }}
          >
          <div
            style={{
              maxHeight: 280,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 1,
            }}
          >
            {workspaces.map((ws) => (
              <div key={ws.path}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => switchTo(ws.path)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 8px",
                    border: "none",
                    borderRadius: "var(--r-control)",
                    background:
                      ws.path === activeWorkspace.path
                        ? "var(--fill-1)"
                        : "transparent",
                    cursor: busy ? "default" : "pointer",
                    textAlign: "left",
                  }}
                >
                  <IconFolder size={15} color="var(--ink-500)" stroke={1.5} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: "var(--ink-800)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {ws.name}
                    </div>
                    <div
                      style={{
                        fontSize: 10.5,
                        color: "var(--ink-500)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {ws.path}
                    </div>
                  </div>
                </button>
                {error?.path === ws.path && (
                  <div
                    style={{
                      margin: "2px 8px 6px",
                      padding: "6px 8px",
                      borderRadius: "var(--r-control)",
                      background: "var(--red-50, #fef2f2)",
                      fontSize: 11,
                      color: "var(--ink-700)",
                    }}
                  >
                    <div style={{ marginBottom: 4 }}>{error.message}</div>
                    <button
                      type="button"
                      onClick={() => onRemoveFromList(ws.path)}
                      style={{
                        border: "none",
                        background: "transparent",
                        padding: 0,
                        color: "var(--indigo-600)",
                        fontWeight: 600,
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      Hapus dari daftar
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {workspaces.length > 0 && (
            <div
              style={{ height: 1, background: "var(--line-1)", margin: "6px 0" }}
            />
          )}

          <button
            type="button"
            disabled={busy}
            onClick={onOpenFolder}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 8px",
              border: "none",
              borderRadius: "var(--r-control)",
              background: "transparent",
              cursor: busy ? "default" : "pointer",
              textAlign: "left",
              fontSize: 12.5,
              fontWeight: 600,
              color: "var(--indigo-600)",
            }}
          >
            Buka Folder…
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}
