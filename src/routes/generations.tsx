import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  clearQueue,
  requeueGeneration,
  type Generation,
  type ImageEntry,
} from "../lib/tauri";
import { generationsQuery, imagesQuery } from "../lib/queries";
import { Button, ImageViewer, useEscapeLayer } from "../root";
import { Segmented } from "../components/Segmented";
import { IconX, IconLoader2 } from "../lib/icons";

/** Which generation states the list is filtered to. */
type StatusFilter = "all" | "queued" | "pending" | "succeeded" | "failed";

/** Sentinel error returned by the Recraftory provider when the key's credit
 *  balance is exhausted (sabi::provider::OUT_OF_CREDITS_ERROR). Shown as a
 *  distinct message rather than the raw generic-looking string. */
const OUT_OF_CREDITS = "OUT_OF_CREDITS";

function errorLabel(error: string): string {
  return error === OUT_OF_CREDITS
    ? "Kredit habis — tambah kredit di Pengaturan"
    : error;
}

/** Trim, collapse whitespace, and truncate a prompt to a short preview on a word
 *  boundary. The 2-line CSS clamp stays as a second safety net. */
function shortPrompt(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length <= 140) return clean;
  const cut = clean.slice(0, 140);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 100 ? cut.slice(0, lastSpace) : cut) + "…";
}

function fmtWhen(seconds: number): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString("id-ID", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Visual treatment per status: label + colors for the pill. */
function statusStyle(status: Generation["status"]): {
  label: string;
  color: string;
  bg: string;
} {
  switch (status) {
    case "queued":
      return { label: "Antre", color: "var(--ink-500)", bg: "var(--fill-1)" };
    case "pending":
      return {
        label: "Berjalan",
        color: "var(--indigo-600)",
        bg: "var(--indigo-100)",
      };
    case "succeeded":
      return { label: "Selesai", color: "#15803d", bg: "#dcfce7" };
    case "failed":
      return { label: "Gagal", color: "#b91c1c", bg: "#fee2e2" };
  }
}

/** The uppercased file extension of a name, e.g. "IMG-01.jpg" → "JPG". */
function fileKind(filename: string): string {
  const m = filename.match(/\.([^.]+)$/);
  return (m ? m[1] : "IMG").toUpperCase();
}

/** Reference-style colored chip for a file type — blue JPG, green PNG, etc.,
 *  falling back to a neutral fill for anything unrecognized. */
function kindChipStyle(kind: string): { color: string; bg: string } {
  switch (kind) {
    case "JPG":
    case "JPEG":
      return { color: "#1a56c4", bg: "#e8f0fe" };
    case "PNG":
      return { color: "#0f766e", bg: "#d9f2ee" };
    case "PDF":
      return { color: "#c0392b", bg: "#fdeaea" };
    case "WEBP":
      return { color: "#7c3aed", bg: "#f0e9fe" };
    default:
      return { color: "var(--ink-500)", bg: "var(--fill-1)" };
  }
}

/** Shared grid track template for the header and every data row, so columns
 *  stay aligned: Waktu · Sumber (thumb + nama + prompt) · Status. */
const GRID_COLS = "128px minmax(0,1fr) 148px";

/** Small uppercase section label inside the detail panel. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: ".04em",
        color: "var(--ink-350)",
        textTransform: "uppercase",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

/** Right-side detail panel for one generation: source/output preview, status +
 *  live provider logs, and (for failures) the full error with a retry action.
 *  Replaces the old navigate-to-asset behavior — the "Buka gambar" button now
 *  performs that navigation explicitly. Reads its generation live from the
 *  parent (which re-derives it from `generationsQuery` every poll). */
function GenerationDetail({
  gen,
  sourceImg,
  busy,
  onClose,
  onOpenImage,
  onViewImage,
  onRetry,
}: {
  gen: Generation;
  sourceImg: ImageEntry | undefined;
  busy: boolean;
  onClose: () => void;
  onOpenImage: (path: string) => void;
  onViewImage: (src: string) => void;
  onRetry: (id: string) => void;
}) {
  // Escape closes the panel — layered, so it wins over the enclosing dialog
  // and loses to a lightbox opened on top of it.
  useEscapeLayer(onClose);

  const active = gen.status === "queued" || gen.status === "pending";
  const succeeded = gen.status === "succeeded" && !!gen.output_path;
  const badge = statusStyle(gen.status);
  const sourceSrc = sourceImg ? convertFileSrc(sourceImg.path) : null;
  // Main preview: the generated output when finished, else the source image.
  const mainSrc = succeeded ? convertFileSrc(gen.output_path!) : sourceSrc;
  const logs = gen.logs?.trim() ? gen.logs : null;

  // Auto-follow the tail of the log while it streams — but only when the user is
  // already near the bottom, so a manual scroll-up to read isn't yanked back.
  const logRef = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [gen.logs]);

  return (
    <div
      style={{
        flex: 1,
        minWidth: 380,
        borderLeft: "1px solid var(--line-1)",
        background: "var(--surface-1)",
        display: "flex",
        flexDirection: "column",
        overflow: "auto",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "16px 18px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-800)" }}>
          Detail generasi
        </span>
        <div
          onClick={onClose}
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: "var(--ink-400)",
          }}
        >
          <IconX size={12} />
        </div>
      </div>

      <div style={{ padding: "16px 18px" }}>
        {/* Preview: output-for-succeeded / source otherwise (dimmed + spinner
            while the job is still running). */}
        <div
          onClick={mainSrc ? () => onViewImage(mainSrc) : undefined}
          style={{
            position: "relative",
            height: 230,
            borderRadius: "var(--r-card)",
            overflow: "hidden",
            border: "1px solid var(--line-3)",
            background: "var(--fill-1)",
            cursor: mainSrc ? "zoom-in" : "default",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {mainSrc && (
            <img
              src={mainSrc}
              alt=""
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "contain",
                opacity: active ? 0.4 : 1,
              }}
            />
          )}
          {active && (
            <IconLoader2
              size={24}
              className="assets-spin"
              stroke={2.5}
              style={{ color: "var(--indigo-500)", position: "relative" }}
            />
          )}
        </div>

        {/* Small "from this source" reference, only when the main preview is the
            output (i.e. succeeded). */}
        {succeeded && sourceSrc && (
          <div
            style={{
              marginTop: 10,
              display: "flex",
              alignItems: "center",
              gap: 9,
            }}
          >
            <div
              onClick={() => onViewImage(sourceSrc)}
              style={{
                width: 40,
                height: 40,
                flexShrink: 0,
                borderRadius: "var(--r-badge-sm)",
                overflow: "hidden",
                border: "1px solid var(--line-3)",
                background: "var(--fill-1)",
                cursor: "zoom-in",
              }}
            >
              <img
                src={sourceSrc}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            </div>
            <span style={{ fontSize: 11.5, color: "var(--ink-500)" }}>
              Dari sumber:{" "}
              <span style={{ color: "var(--ink-700)", fontWeight: 500 }}>
                {sourceImg ? sourceImg.title ?? sourceImg.filename : "—"}
              </span>
            </span>
          </div>
        )}

        {/* Status block */}
        <div style={{ marginTop: 16 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: ".01em",
                padding: "3px 10px",
                borderRadius: 9999,
                color: badge.color,
                background: badge.bg,
              }}
            >
              {badge.label}
            </span>
            <span
              style={{
                fontSize: 11.5,
                color: "var(--ink-400)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {gen.provider} · {fmtWhen(gen.created_at)}
            </span>
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--ink-600)",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {gen.prompt}
          </div>
        </div>

        {/* Failed → error box; otherwise the live provider log (when present). */}
        {gen.status === "failed" ? (
          <div style={{ marginTop: 16 }}>
            <SectionLabel>Kesalahan</SectionLabel>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                lineHeight: 1.5,
                color: "#b91c1c",
                background: "#fee2e2",
                border: "1px solid #fecaca",
                borderRadius: "var(--r-card)",
                padding: "10px 12px",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {errorLabel(gen.error ?? "Gagal")}
            </div>
          </div>
        ) : (
          logs && (
            <div style={{ marginTop: 16 }}>
              <SectionLabel>Log</SectionLabel>
              <pre
                ref={logRef}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: "var(--ink-600)",
                  background: "var(--fill-1)",
                  border: "1px solid var(--line-3)",
                  borderRadius: "var(--r-card)",
                  padding: "10px 12px",
                  margin: 0,
                  maxHeight: 200,
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {logs}
              </pre>
            </div>
          )
        )}

        {/* Footer actions */}
        {(succeeded || gen.status === "failed") && (
          <div style={{ marginTop: 18 }}>
            {succeeded ? (
              <Button
                variant="primary"
                onClick={() => onOpenImage(gen.output_path!)}
              >
                Buka gambar
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => onRetry(gen.id)}
              >
                Ulangi
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Generations({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: generations = [] } = useQuery(generationsQuery);
  const { data: images = [] } = useQuery(imagesQuery);

  const [filter, setFilter] = useState<StatusFilter>("all");
  const [busy, setBusy] = useState(false);
  // The generation whose detail panel is open, by id. Resolved against the full
  // list (not the filtered `visible`) so status transitions keep flowing into
  // the panel even if the current filter would hide the row.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Fullscreen lightbox source for the panel's preview, or null when closed.
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);

  const imgById = new Map<string, ImageEntry>();
  for (const img of images) imgById.set(img.id, img);

  /** The source image's display name for a generation row (title, falling back
   *  to the on-disk filename), or "—" when there is no source. */
  function sourceName(g: Generation): string {
    const src = g.source_id ? imgById.get(g.source_id) : undefined;
    return src ? src.title ?? src.filename : "—";
  }

  const queuedCount = generations.filter((g) => g.status === "queued").length;
  const failed = generations.filter((g) => g.status === "failed");

  const visible =
    filter === "all"
      ? generations
      : generations.filter((g) => g.status === filter);

  // The open generation, resolved live from the full list. If its id is gone
  // (cleared queue / deleted), auto-close the panel.
  const selectedGen = selectedId
    ? generations.find((g) => g.id === selectedId) ?? null
    : null;
  useEffect(() => {
    if (selectedId && !selectedGen) setSelectedId(null);
  }, [selectedId, selectedGen]);

  const panelOpen = !!selectedGen;

  const refresh = () =>
    qc.invalidateQueries({ queryKey: generationsQuery.queryKey });

  async function onClearQueue() {
    if (busy || queuedCount === 0) return;
    setBusy(true);
    try {
      await clearQueue();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onRetry(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      await requeueGeneration(id);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onRetryAllFailed() {
    if (busy || failed.length === 0) return;
    setBusy(true);
    try {
      for (const g of failed) await requeueGeneration(g.id);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  /** The thumbnail to show for a row: the output for finished jobs, otherwise
   *  the source image (resolved from `source_id`). */
  function thumbFor(g: Generation): string | null {
    if (g.status === "succeeded" && g.output_path) {
      return convertFileSrc(g.output_path);
    }
    const src = g.source_id ? imgById.get(g.source_id) : undefined;
    return src ? convertFileSrc(src.path) : null;
  }

  /** Panel action: close the dialog and select this output image in the
   *  always-mounted assets library underneath (via router state, consumed by
   *  the selectPath effect in assets.tsx). */
  function onOpenImage(path: string) {
    onClose();
    navigate("/", { state: { selectPath: path } });
  }

  /** Panel action: retry a failed generation and *follow* the fresh job —
   *  `requeueGeneration` returns the new `queued` row, so select it and watch
   *  it run. The failed row is left in place. */
  async function onRetryFollow(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      const created = await requeueGeneration(id);
      await refresh();
      setSelectedId(created.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div
        style={{
          height: 52,
          flexShrink: 0,
          borderBottom: "1px solid var(--line-1)",
          display: "flex",
          alignItems: "center",
          padding: "0 20px",
          gap: 12,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-800)" }}>
          Antrean
        </div>
        <span
          style={{
            minWidth: 18,
            height: 18,
            padding: "0 6px",
            borderRadius: 9999,
            background: "var(--fill-1)",
            color: "var(--ink-500)",
            fontSize: 11,
            fontWeight: 600,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {visible.length}
        </span>

        <Segmented
          options={[
            { value: "all", label: "Semua" },
            { value: "queued", label: "Antre" },
            { value: "pending", label: "Berjalan" },
            { value: "succeeded", label: "Selesai" },
            { value: "failed", label: "Gagal" },
          ]}
          value={filter}
          onChange={setFilter}
        />

        <div style={{ flex: 1 }} />

        {filter === "failed" && failed.length > 0 && (
          <Button variant="outline" disabled={busy} onClick={onRetryAllFailed}>
            Ulangi semua gagal
          </Button>
        )}
        {queuedCount > 0 && (
          <Button variant="danger" disabled={busy} onClick={onClearQueue}>
            Kosongkan antrean
          </Button>
        )}

        <div
          onClick={onClose}
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: "var(--ink-400)",
          }}
        >
          <IconX size={12} />
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div
          style={{
            flex: panelOpen ? "0 0 520px" : 1,
            overflow: "auto",
            minWidth: 0,
          }}
        >
          {visible.length === 0 ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--ink-400)",
              fontSize: 13,
            }}
          >
            {generations.length === 0
              ? "Belum ada generasi."
              : "Tidak ada yang cocok dengan filter."}
          </div>
        ) : (
          <div style={{ padding: "0 0 32px" }}>
            {/* Column header — sticky so labels stay while the list scrolls. */}
            <div
              style={{
                position: "sticky",
                top: 0,
                zIndex: 1,
                display: "grid",
                gridTemplateColumns: GRID_COLS,
                alignItems: "center",
                gap: 16,
                padding: "11px 14px",
                background: "var(--surface-1)",
                borderBottom: "1px solid var(--line-3)",
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: ".06em",
                textTransform: "uppercase",
                color: "var(--ink-400)",
              }}
            >
              <div>Waktu</div>
              <div>Sumber</div>
              <div style={{ textAlign: "right" }}>Status</div>
            </div>

            {visible.map((g) => {
              const badge = statusStyle(g.status);
              const thumb = thumbFor(g);
              const active = g.status === "queued" || g.status === "pending";
              const isSelected = g.id === selectedId;
              const name = sourceName(g);
              const kind = fileKind(name);
              const chip = kindChipStyle(kind);
              return (
                <div
                  key={g.id}
                  className="gen-row"
                  onClick={() => setSelectedId(g.id)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: GRID_COLS,
                    alignItems: "center",
                    gap: 16,
                    padding: "10px 14px",
                    borderBottom: "1px solid var(--line-1)",
                    cursor: "pointer",
                    background: isSelected ? "var(--indigo-100)" : undefined,
                    boxShadow: isSelected
                      ? "inset 2px 0 0 var(--indigo-500)"
                      : undefined,
                  }}
                >
                  {/* Waktu */}
                  <div
                    style={{
                      fontSize: 11.5,
                      color: "var(--ink-400)",
                      fontVariantNumeric: "tabular-nums",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {fmtWhen(g.created_at)}
                  </div>

                  {/* Sumber: thumbnail + (type chip + nama) + prompt */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      minWidth: 0,
                    }}
                  >
                    <div
                      style={{
                        position: "relative",
                        width: 40,
                        height: 40,
                        flexShrink: 0,
                        borderRadius: "var(--r-badge-sm)",
                        overflow: "hidden",
                        border: "1px solid var(--line-3)",
                        background: "var(--fill-1)",
                      }}
                    >
                      {thumb && (
                        <img
                          src={thumb}
                          alt=""
                          loading="lazy"
                          style={{
                            position: "absolute",
                            inset: 0,
                            width: "100%",
                            height: "100%",
                            objectFit: "cover",
                            opacity: active ? 0.5 : 1,
                          }}
                        />
                      )}
                      {active && (
                        <div
                          style={{
                            position: "absolute",
                            inset: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <IconLoader2
                            size={16}
                            className="assets-spin"
                            stroke={2.5}
                            style={{ color: "var(--indigo-500)" }}
                          />
                        </div>
                      )}
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 7,
                          minWidth: 0,
                        }}
                      >
                        <span
                          style={{
                            flexShrink: 0,
                            fontSize: 9.5,
                            fontWeight: 700,
                            letterSpacing: ".03em",
                            padding: "2px 5px",
                            borderRadius: "var(--r-badge-sm)",
                            color: chip.color,
                            background: chip.bg,
                          }}
                        >
                          {kind}
                        </span>
                        <span
                          title={name}
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: 12,
                            fontWeight: 500,
                            color: "var(--ink-800)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {name}
                        </span>
                      </div>
                      <div
                        title={g.prompt}
                        style={{
                          marginTop: 3,
                          fontSize: 11.5,
                          color: "var(--ink-500)",
                          lineHeight: 1.4,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {g.status === "failed" && g.error ? (
                          <span style={{ color: "#b91c1c" }}>{errorLabel(g.error)}</span>
                        ) : (
                          shortPrompt(g.prompt)
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Status pill (+ inline retry for failures) */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "flex-end",
                      gap: 8,
                    }}
                  >
                    {g.status === "failed" && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRetry(g.id);
                        }}
                        style={{
                          flexShrink: 0,
                          height: 24,
                          padding: "0 9px",
                          border: "1px solid var(--line-4)",
                          borderRadius: "var(--r-button)",
                          background: "var(--surface-0)",
                          color: "var(--ink-700)",
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: busy ? "not-allowed" : "pointer",
                        }}
                      >
                        Ulangi
                      </button>
                    )}
                    <span
                      style={{
                        flexShrink: 0,
                        fontSize: 11,
                        fontWeight: 600,
                        letterSpacing: ".01em",
                        padding: "3px 10px",
                        borderRadius: 9999,
                        color: badge.color,
                        background: badge.bg,
                      }}
                    >
                      {badge.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          )}
        </div>

        {selectedGen && (
          <GenerationDetail
            gen={selectedGen}
            sourceImg={
              selectedGen.source_id
                ? imgById.get(selectedGen.source_id)
                : undefined
            }
            busy={busy}
            onClose={() => setSelectedId(null)}
            onOpenImage={onOpenImage}
            onViewImage={setViewerSrc}
            onRetry={onRetryFollow}
          />
        )}
      </div>

      {viewerSrc && (
        <ImageViewer src={viewerSrc} onClose={() => setViewerSrc(null)} />
      )}
    </>
  );
}
