import { useCallback, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Generation, ImageEntry } from "../../lib/tauri";
import { Button } from "../../root";
import { IconBookmarkPlus, IconSparkles, IconTrash, IconX } from "../../lib/icons";
import { DetailRow } from "./DetailRow";
import { Mono } from "./Mono";
import { SaveTemplateDialog } from "./SaveTemplateDialog";
import { TemplatePicker } from "./TemplatePicker";
import { VariantTile } from "./VariantTile";
import { displayName, fmtDate, fmtSize, kindOf } from "./helpers";
import type { Dims } from "./types";

/** Detail panel width (px) at or above which its header switches to two
 *  columns — image preview on the left, metadata on the right. Below this
 *  (narrow windows / small screens) it stays a single stacked column. */
const DETAIL_TWO_COL_MIN = 520;

/** Right-side panel for a single selected asset: preview, metadata, lineage
 *  (source + generated variants), and the "create variant" form (template
 *  picker or manual prompt). */
export function DetailPanel({
  image,
  dim,
  prompt,
  sourceImage,
  variants,
  onClose,
  onViewImage,
  onSelectSource,
  variantOpen,
  onToggleVariant,
  variantPrompt,
  onVariantPromptChange,
  selectedTemplates,
  onToggleTemplate,
  generating,
  generateDisabled,
  generateLabel,
  onGenerate,
  onGenerateFromTemplates,
  error,
  deleting,
  onDelete,
}: {
  image: ImageEntry;
  dim: Dims | undefined;
  prompt: string | undefined;
  sourceImage: ImageEntry | null;
  variants: Generation[];
  onClose: () => void;
  onViewImage: (src: string) => void;
  onSelectSource: (path: string) => void;
  variantOpen: boolean;
  onToggleVariant: () => void;
  variantPrompt: string;
  onVariantPromptChange: (v: string) => void;
  selectedTemplates: Set<string>;
  onToggleTemplate: (id: string) => void;
  generating: boolean;
  generateDisabled: boolean;
  generateLabel: string;
  onGenerate: () => void;
  onGenerateFromTemplates: () => void;
  error: string | null;
  deleting: boolean;
  onDelete: () => void;
}) {
  // Panel width, tracked via a callback ref: the panel mounts/unmounts with the
  // selection, so an effect-attached ResizeObserver would miss its element on
  // first open. Drives the responsive two-column (image | metadata) header.
  const [panelWidth, setPanelWidth] = useState(0);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const observerRef = useRef<ResizeObserver | null>(null);
  const panelRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    const measure = () => setPanelWidth(el.clientWidth);
    measure();
    observerRef.current = new ResizeObserver(measure);
    observerRef.current.observe(el);
  }, []);
  const detailTwoCol = panelWidth >= DETAIL_TWO_COL_MIN;

  const preview = convertFileSrc(image.path);
  const name = displayName(image);

  return (
    <div
      ref={panelRef}
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
          Detail aset
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
        {/* Header: image preview + metadata. Two columns side by side
            when the panel is wide enough, stacked otherwise. */}
        <div
          style={{
            display: "flex",
            flexDirection: detailTwoCol ? "row" : "column",
            gap: detailTwoCol ? 16 : 0,
            alignItems: detailTwoCol ? "flex-start" : "stretch",
          }}
        >
          <div
            onClick={() => onViewImage(preview)}
            style={{
              position: "relative",
              flex: detailTwoCol ? "1 1 0" : undefined,
              minWidth: 0,
              maxWidth: detailTwoCol ? 420 : undefined,
              height: detailTwoCol ? "auto" : 230,
              aspectRatio: detailTwoCol ? "1" : undefined,
              borderRadius: "var(--r-card)",
              overflow: "hidden",
              border: "1px solid var(--line-3)",
              background: "var(--fill-1)",
              cursor: "zoom-in",
            }}
          >
            <img
              src={preview}
              alt={name}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "contain",
              }}
            />
          </div>

          <div style={{ flex: detailTwoCol ? "1 1 0" : undefined, minWidth: 0 }}>
            <div
              style={{
                marginTop: detailTwoCol ? 0 : 14,
                fontFamily: "var(--font-mono)",
                fontSize: 12.5,
                fontWeight: 600,
                color: "var(--ink-900)",
                wordBreak: "break-all",
              }}
            >
              {name}
            </div>

            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 9 }}>
              <DetailRow label="Jenis">
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: ".02em",
                    padding: "2px 5px",
                    borderRadius: "var(--r-badge-sm)",
                    color: "var(--indigo-600)",
                    background: "var(--indigo-100)",
                  }}
                >
                  {kindOf(image.filename)}
                </span>
              </DetailRow>
              <DetailRow label="Dimensi">
                <Mono>{dim ? `${dim.w}×${dim.h}` : "…"} px</Mono>
              </DetailRow>
              <DetailRow label="Ukuran">
                <Mono>{fmtSize(image.size_bytes)}</Mono>
              </DetailRow>
              <DetailRow label="Ditambahkan">
                <Mono>{fmtDate(image.created_at)}</Mono>
              </DetailRow>
            </div>
            {(sourceImage || prompt) && (
              <div
                style={{
                  marginTop: 14,
                  display: "flex",
                  flexDirection: "row",
                  gap: 12,
                  padding: 12,
                  borderRadius: "var(--r-control)",
                  border: "1px solid var(--line-3)",
                  background: "var(--fill-1)",
                }}
              >
                {sourceImage && (
                  <div>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: "var(--ink-500)",
                        marginBottom: 7,
                      }}
                    >
                      Sumber
                    </div>
                    <div
                      onClick={() => onSelectSource(sourceImage.path)}
                      title={sourceImage.filename}
                      style={{
                        position: "relative",
                        width: 72,
                        height: 72,
                        borderRadius: "var(--r-card)",
                        overflow: "hidden",
                        border: "1px solid var(--line-3)",
                        background: "var(--fill-2, var(--fill-1))",
                        cursor: "pointer",
                      }}
                    >
                      <img
                        src={convertFileSrc(sourceImage.path)}
                        alt={sourceImage.filename}
                        loading="lazy"
                        style={{
                          position: "absolute",
                          inset: 0,
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                        }}
                      />
                    </div>
                  </div>
                )}

                {prompt && (
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: 5,
                        padding: "0 10px",
                      }}
                    >
                      <div style={{ fontSize: 11.5, color: "var(--ink-500)" }}>
                        Prompt
                      </div>
                      <div
                        onClick={() => setSavingTemplate(true)}
                        title="Simpan sebagai templat"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: 11,
                          fontWeight: 600,
                          color: "var(--indigo-600)",
                          cursor: "pointer",
                        }}
                      >
                        <IconBookmarkPlus size={11} />
                        Simpan sebagai templat
                      </div>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--ink-700)",
                        lineHeight: 1.45,
                        background: "var(--indigo-100)",
                        borderRadius: "var(--r-control)",
                        padding: "8px 10px",
                      }}
                    >
                      {prompt}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {variants.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--ink-500)",
                marginBottom: 7,
              }}
            >
              Varian dihasilkan
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              {variants.map((g) => (
                <VariantTile
                  key={g.id}
                  gen={g}
                  srcPath={image.path}
                  onOpen={(path) => onViewImage(convertFileSrc(path))}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div style={{ height: 1, background: "var(--line-1)", margin: "2px 0" }} />

      {/* Variant generation */}
      <div style={{ padding: "16px 18px" }}>
        <div
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: ".04em",
            color: "var(--ink-350)",
            textTransform: "uppercase",
            marginBottom: 10,
          }}
        >
          Buat varian
        </div>

        {/* Template picker — pick one or more, generate as a batch */}
        <TemplatePicker selected={selectedTemplates} onToggle={onToggleTemplate} />

        <Button
          variant="primary"
          disabled={generating || selectedTemplates.size === 0}
          onClick={onGenerateFromTemplates}
        >
          <IconSparkles size={14} color="#fff" />
          {generating ? "Menghasilkan…" : `Hasilkan ${selectedTemplates.size} varian`}
        </Button>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: "16px 0 12px",
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: ".04em",
            color: "var(--ink-350)",
            textTransform: "uppercase",
          }}
        >
          <div style={{ flex: 1, height: 1, background: "var(--line-1)" }} />
          atau prompt manual
          <div style={{ flex: 1, height: 1, background: "var(--line-1)" }} />
        </div>

        {variantOpen ? (
          <div>
            <textarea
              placeholder="Jelaskan perubahannya. mis. ganti latar jadi putih bersih, tambah bayangan lembut"
              value={variantPrompt}
              onChange={(e) => onVariantPromptChange(e.target.value)}
              style={{
                width: "100%",
                minHeight: 74,
                resize: "none",
                border: "1px solid var(--line-4)",
                borderRadius: "var(--r-button)",
                padding: "10px 11px",
                fontFamily: "var(--font-ui)",
                fontSize: 12,
                color: "var(--ink-800)",
                lineHeight: 1.45,
                outline: "none",
                background: "var(--surface-0)",
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
              <Button variant="primary" disabled={generateDisabled} onClick={onGenerate}>
                <IconSparkles size={14} color="#fff" />
                {generateLabel}
              </Button>
              <Button variant="ghost" disabled={generating} onClick={onToggleVariant}>
                Batal
              </Button>
            </div>
            <div
              style={{
                marginTop: 9,
                fontSize: 11,
                color: "var(--ink-400)",
                lineHeight: 1.45,
              }}
            >
              Varian disimpan sebagai aset baru dan ditautkan ke gambar sumber.
            </div>
          </div>
        ) : (
          <div
            onClick={onToggleVariant}
            style={{
              border: "1px dashed var(--line-5)",
              borderRadius: "var(--r-button)",
              padding: "13px 14px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              cursor: "pointer",
              background: "var(--indigo-100)",
            }}
          >
            <IconSparkles size={16} color="var(--indigo-500)" />
            <div style={{ flex: 1, lineHeight: 1.3 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--indigo-600)" }}>
                Buat varian dengan prompt
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-500)" }}>
                Hasilkan versi baru dari teks
              </div>
            </div>
          </div>
        )}

        {error && (
          <div
            style={{
              marginTop: 12,
              fontSize: 11.5,
              color: "var(--red-600)",
              lineHeight: 1.45,
            }}
          >
            {error}
          </div>
        )}
      </div>

      <div style={{ flex: 1 }} />

      <div style={{ padding: "14px 18px", borderTop: "1px solid var(--line-1)" }}>
        <Button variant="danger" disabled={deleting} onClick={onDelete}>
          <IconTrash size={14} color="var(--red-600)" stroke={1.2} />
          {deleting ? "Menghapus…" : "Hapus aset"}
        </Button>
      </div>

      {savingTemplate && prompt && (
        <SaveTemplateDialog
          initialPrompt={prompt}
          sourceImagePath={image.path}
          onClose={() => setSavingTemplate(false)}
          onSaved={() => setSavingTemplate(false)}
        />
      )}
    </div>
  );
}
