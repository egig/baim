import { useCallback, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Generation, ImageEntry } from "../../lib/tauri";
import { Button } from "../../root";
import { Segmented } from "../../components/Segmented";
import {
  IconBookmarkPlus,
  IconChevronDown,
  IconSparkles,
  IconTrash,
  IconX,
} from "../../lib/icons";
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

/** Height (px) shared by the "Buat varian" tab content — the template grid
 *  (one row of 120px tiles + label) and the manual-prompt textarea — so
 *  switching tabs doesn't resize the panel. */
const VARIAN_CONTENT_HEIGHT = 100;

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
  const [variantsExpanded, setVariantsExpanded] = useState(false);
  const [varianTab, setVarianTab] = useState<"template" | "prompt">("template");
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
        overflow: "hidden",
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
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            style={{
              height: 26,
              padding: "0 10px",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              borderRadius: "var(--r-button)",
              border: "1px solid var(--line-4)",
              background: "var(--surface-0)",
              color: "var(--red-600)",
              fontFamily: "var(--font-ui)",
              fontSize: 11.5,
              fontWeight: 600,
              lineHeight: 1,
              cursor: deleting ? "not-allowed" : "pointer",
              opacity: deleting ? 0.5 : 1,
            }}
          >
            <IconTrash size={12.5} stroke={1.2} />
            {deleting ? "Menghapus…" : "Hapus aset"}
          </button>
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
      </div>

      {/* Scrollable content: preview, metadata, lineage, and generated
          variants — everything except the "create variant" composer, which
          stays pinned at the bottom (chat-input style). */}
      <div style={{ flex: 1, overflow: "auto" }}>
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
                    alignItems: "flex-start",
                    gap: 12,
                    padding: 12,
                    borderRadius: "var(--r-control)",
                    border: "1px solid var(--line-3)",
                    background: "var(--fill-1)",
                  }}
                >
                  {sourceImage && (
                    <div style={{ flexShrink: 0 }}>
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
                          maxHeight: 120,
                          overflowY: "auto",
                          overflowWrap: "anywhere",
                          whiteSpace: "pre-wrap",
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
                onClick={() => setVariantsExpanded((v) => !v)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  cursor: "pointer",
                  userSelect: "none",
                  marginBottom: variantsExpanded ? 7 : 0,
                }}
              >
                <IconChevronDown
                  size={12}
                  color="var(--ink-400)"
                  style={{
                    transform: variantsExpanded ? "rotate(0deg)" : "rotate(-90deg)",
                    transition: "transform .12s ease",
                  }}
                />
                <span style={{ fontSize: 11.5, color: "var(--ink-500)" }}>
                  Varian dihasilkan ({variants.length})
                </span>
              </div>
              {variantsExpanded && (
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
              )}
            </div>
          )}
        </div>
      </div>

      {/* Variant generation — pinned at the bottom like a chat composer,
          rather than scrolling away with the rest of the panel. */}
      <div style={{ padding: "16px 18px", borderTop: "1px solid var(--line-1)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 10,
          }}
        >
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: ".04em",
              color: "var(--ink-350)",
              textTransform: "uppercase",
            }}
          >
            Buat varian
          </div>
          <Segmented
            options={[
              { value: "template", label: "Templat" },
              { value: "prompt", label: "Prompt manual" },
            ]}
            value={varianTab}
            onChange={setVarianTab}
          />
        </div>
        
        <div style={{flex: 1}}>
          {varianTab === "template" ? (
          <div>
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
          </div>
        ) : (
          <div>
            <textarea
              placeholder="Jelaskan perubahannya. mis. ganti latar jadi putih bersih, tambah bayangan lembut"
              value={variantPrompt}
              onChange={(e) => onVariantPromptChange(e.target.value)}
              style={{
                width: "100%",
                height: VARIAN_CONTENT_HEIGHT,
                boxSizing: "border-box",
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
                marginBottom: 12,
              }}
            />
            <Button variant="primary" disabled={generateDisabled} onClick={onGenerate}>
              <IconSparkles size={14} color="#fff" />
              {generateLabel}
            </Button>
            
          </div>
        )}
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
