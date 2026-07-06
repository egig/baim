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

function fmtWhen(seconds: number): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString("id-ID", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Visual treatment per status: label + colors for the badge. */
function statusStyle(status: Generation["status"]): {
  label: string;
  color: string;
  bg: string;
} {
  switch (status) {
    case "queued":
      return { label: "Antre", color: "var(--ink-600)", bg: "var(--fill-1)" };
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

export default function Generations() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: generations = [] } = useQuery(generationsQuery);
  const { data: images = [] } = useQuery(imagesQuery);

  const [filter, setFilter] = useState<StatusFilter>("all");
  const [busy, setBusy] = useState(false);

  const imgById = new Map<string, ImageEntry>();
  for (const img of images) imgById.set(img.id, img);

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

      <div style={{ flex: 1, overflow: "auto", padding: "16px 20px 32px" }}>
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
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {visible.map((g) => {
              const badge = statusStyle(g.status);
              const thumb = thumbFor(g);
              const active = g.status === "queued" || g.status === "pending";
              const clickable = g.status === "succeeded" && !!g.output_path;
              return (
                <div
                  key={g.id}
                  onClick={clickable ? () => openOutput(g) : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "8px 10px",
                    borderRadius: "var(--r-card)",
                    border: "1px solid var(--line-3)",
                    background: "var(--surface-0)",
                    cursor: clickable ? "pointer" : "default",
                  }}
                >
                  <div
                    style={{
                      position: "relative",
                      width: 48,
                      height: 48,
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
                          width="18"
                          height="18"
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

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--ink-800)",
                        lineHeight: 1.4,
                        overflow: "hidden",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                      }}
                    >
                      {g.prompt}
                    </div>
                    <div
                      style={{
                        marginTop: 3,
                        fontSize: 11,
                        color: "var(--ink-400)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {fmtWhen(g.created_at)}
                      {g.status === "failed" && g.error ? ` · ${g.error}` : ""}
                    </div>
                  </div>

                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: ".02em",
                      padding: "3px 7px",
                      borderRadius: "var(--r-badge-sm)",
                      color: badge.color,
                      background: badge.bg,
                    }}
                  >
                    {badge.label}
                  </span>

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
                        height: 26,
                        padding: "0 10px",
                        border: "1px solid var(--line-4)",
                        borderRadius: "var(--r-button)",
                        background: "var(--surface-0)",
                        color: "var(--ink-700)",
                        fontSize: 11.5,
                        fontWeight: 600,
                        cursor: busy ? "not-allowed" : "pointer",
                      }}
                    >
                      Ulangi
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
