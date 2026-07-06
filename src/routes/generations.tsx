import { useState } from "react";
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
import { Button } from "../root";
import { Segmented } from "./assets";

/** Which generation states the list is filtered to. */
type StatusFilter = "all" | "queued" | "pending" | "succeeded" | "failed";

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

export default function Generations() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: generations = [] } = useQuery(generationsQuery);
  const { data: images = [] } = useQuery(imagesQuery);

  const [filter, setFilter] = useState<StatusFilter>("all");
  const [busy, setBusy] = useState(false);

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

  function openOutput(g: Generation) {
    if (g.status !== "succeeded" || !g.output_path) return;
    // Hand the target path to the assets page, which selects it on mount.
    navigate("/", { state: { selectPath: g.output_path } });
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
      </div>

      <div style={{ flex: 1, overflow: "auto" }}>
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
              const clickable = g.status === "succeeded" && !!g.output_path;
              const name = sourceName(g);
              const kind = fileKind(name);
              const chip = kindChipStyle(kind);
              return (
                <div
                  key={g.id}
                  className="gen-row"
                  onClick={clickable ? () => openOutput(g) : undefined}
                  style={{
                    display: "grid",
                    gridTemplateColumns: GRID_COLS,
                    alignItems: "center",
                    gap: 16,
                    padding: "10px 14px",
                    borderBottom: "1px solid var(--line-1)",
                    cursor: clickable ? "pointer" : "default",
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
                          <svg
                            className="assets-spin"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            style={{ color: "var(--indigo-500)" }}
                          >
                            <path
                              d="M21 12a9 9 0 1 1-6.219-8.56"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                            />
                          </svg>
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
                          <span style={{ color: "#b91c1c" }}>{g.error}</span>
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
    </>
  );
}
