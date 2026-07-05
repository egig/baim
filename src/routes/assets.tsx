import { useRef, useState, useCallback, memo, type ReactNode } from "react";
import { Link } from "react-router";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  createPrediction,
  deleteImage,
  saveImage,
  getActiveProvider,
  listProviders,
  hasApiKey,
  type ImageEntry,
  type Generation,
} from "../lib/tauri";
import { assetsQuery } from "../lib/queries";
import { Button } from "../root";

// ---------- helpers ----------

type Dims = { w: number; h: number };

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1).replace(".", ",") + " MB";
  }
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

function fmtDate(seconds: number): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function kindOf(filename: string): string {
  const m = filename.match(/\.([^.]+)$/);
  return (m ? m[1] : "IMG").toUpperCase();
}

/** Read a saved image file's bytes back as a data URI, losslessly, so it can be
 *  sent to Replicate as the source for a new variant. */
async function assetToDataUri(path: string): Promise<string> {
  const res = await fetch(convertFileSrc(path));
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** Normalize a picked file to a PNG data URI. */
function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")!.drawImage(img, 0, 0);
      const dataUri = canvas.toDataURL("image/png");
      URL.revokeObjectURL(url);
      resolve(dataUri);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Gagal membaca gambar."));
    };
    img.src = url;
  });
}

const ImageCard = memo(function ImageCard({
  img,
  selected,
  dim,
  onSelect,
  onLoad,
}: {
  img: ImageEntry;
  selected: boolean;
  dim: Dims | undefined;
  onSelect: (path: string) => void;
  onLoad: (path: string, w: number, h: number) => void;
}) {
  return (
    <div
      onClick={() => onSelect(img.path)}
      style={{ cursor: "pointer", position: "relative" }}
    >
      <div
        style={{
          position: "relative",
          aspectRatio: "1",
          borderRadius: "var(--r-card)",
          overflow: "hidden",
          border: "1px solid var(--line-3)",
          background: "var(--fill-1)",
        }}
      >
        <img
          src={convertFileSrc(img.path)}
          alt={img.filename}
          loading="lazy"
          onLoad={(e) => {
            const el = e.currentTarget;
            onLoad(img.path, el.naturalWidth, el.naturalHeight);
          }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
        <span
          style={{
            position: "absolute",
            bottom: 7,
            right: 7,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: ".02em",
            padding: "2px 5px",
            borderRadius: "var(--r-badge-sm)",
            background: "rgba(255,255,255,.92)",
            color: "var(--ink-700)",
          }}
        >
          {kindOf(img.filename)}
        </span>
        {selected && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              border: "1.5px solid var(--indigo-500)",
              borderRadius: "var(--r-card)",
              boxShadow: "0 0 0 1.5px var(--indigo-100)",
            }}
          />
        )}
      </div>
      <div
        style={{
          marginTop: 7,
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          fontWeight: 500,
          color: "var(--ink-700)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {img.filename}
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--ink-400)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {dim ? `${dim.w}\u00d7${dim.h}` : "\u00a0"}
      </div>
    </div>
  );
});

/** An in-progress generation: the source image dimmed under a spinning icon,
 *  shown until polling replaces it with the finished result. */
const PendingCard = memo(function PendingCard({ gen }: { gen: Generation }) {
  return (
    <div style={{ position: "relative" }}>
      <div
        style={{
          position: "relative",
          aspectRatio: "1",
          borderRadius: "var(--r-card)",
          overflow: "hidden",
          border: "1px solid var(--line-3)",
          background: "var(--fill-1)",
        }}
      >
        <img
          src={gen.input_data_uri}
          alt=""
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: 0.35,
          }}
        />
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
            width="22"
            height="22"
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
      </div>
      <div
        style={{
          marginTop: 7,
          fontSize: 11.5,
          fontWeight: 500,
          color: "var(--ink-400)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        Menghasilkan…
      </div>
    </div>
  );
});

// ---------- route ----------

/** Prefetch the asset library into the query cache so navigation to "/" is
 *  gated on the first load only; repeat visits render instantly from cache. */
export const loader = (qc: QueryClient) => async () => {
  await qc.ensureQueryData(assetsQuery);
  return null;
};

export default function Assets() {
  const fileRef = useRef<HTMLInputElement>(null);

  const qc = useQueryClient();
  const { data } = useQuery(assetsQuery);
  const { images, gens, pending } = data ?? {
    images: [],
    gens: {},
    pending: [],
  };

  /** Re-fetch after a mutation. `invalidateQueries` resolves once the refetch
   *  settles, so callers can safely select the newly-created asset afterward. */
  const refresh = useCallback(
    () => qc.invalidateQueries({ queryKey: assetsQuery.queryKey }),
    [qc]
  );

  const [dims, setDims] = useState<Record<string, Dims>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const [variantOpen, setVariantOpen] = useState(false);
  const [variantPrompt, setVariantPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The globally-selected provider drives which API key we read and send.
  const { data: providerCtx } = useQuery({
    queryKey: ["activeProvider"],
    queryFn: async () => {
      const [id, providers] = await Promise.all([
        getActiveProvider(),
        listProviders(),
      ]);
      const info = providers.find((p) => p.id === id) ?? null;
      return { id, label: info?.label ?? id };
    },
    staleTime: 30_000,
  });
  const providerId = providerCtx?.id ?? "replicate";
  const providerLabel = providerCtx?.label ?? "AI";

  // Whether the active provider has a key saved in the backend. Drives the
  // "set your key" banner and gates generation.
  const { data: apiKey } = useQuery({
    queryKey: ["hasApiKey", providerId],
    queryFn: () => hasApiKey(providerId),
    staleTime: 30_000,
  });

  const selectAsset = useCallback((path: string) => {
    setSelectedPath(path);
    setVariantOpen(false);
    setVariantPrompt("");
    setError(null);
  }, []);

  const handleImageLoad = useCallback((path: string, w: number, h: number) => {
    setDims((prev) =>
      prev[path] ? prev : { ...prev, [path]: { w, h } }
    );
  }, []);

  function close() {
    setSelectedPath(null);
    setVariantOpen(false);
    setVariantPrompt("");
  }

  function toggleVariant() {
    setVariantOpen((v) => !v);
    setVariantPrompt("");
  }

  function onUploadClick() {
    fileRef.current?.click();
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !file.type.startsWith("image/")) return;
    setError(null);
    try {
      const dataUri = await fileToDataUri(file);
      const saved = await saveImage(dataUri);
      await refresh();
      setSelectedPath(saved.path);
      setVariantOpen(true);
      setVariantPrompt("");
    } catch (err) {
      setError(String(err));
    }
  }

  async function generate() {
    if (generating) return;
    if (!apiKey) {
      setError(`Kunci API ${providerLabel} belum diatur.`);
      return;
    }
    if (!variantPrompt.trim()) return;
    if (!selectedPath) return;

    setGenerating(true);
    setError(null);
    try {
      const src = await assetToDataUri(selectedPath!);
      // Fire the prediction in async mode and return immediately. The backend
      // records it as `pending`; the frontend does not block until it's done.
      // The API key is read from the backend settings, not passed from here.
      await createPrediction(src, variantPrompt.trim(), providerId);
      await refresh();
      setVariantOpen(false);
      setVariantPrompt("");
    } catch (err) {
      setError(String(err));
    } finally {
      setGenerating(false);
    }
  }

  async function del() {
    if (!selectedPath || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteImage(selectedPath);
      await refresh();
      setSelectedPath(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setDeleting(false);
    }
  }

  const selectedImage = selectedPath
    ? images.find((i) => i.path === selectedPath) ?? null
    : null;
  const hasSelection = !!selectedImage;

  const detail = selectedImage
    ? {
        preview: convertFileSrc(selectedImage.path),
        name: selectedImage.filename,
        kind: kindOf(selectedImage.filename),
        dims: dims[selectedImage.path]
          ? `${dims[selectedImage.path].w}×${dims[selectedImage.path].h}`
          : "…",
        sizeText: fmtSize(selectedImage.size_bytes),
        added: fmtDate(selectedImage.created_at),
        prompt: gens[selectedImage.path]?.prompt,
      }
      : null;

  const generateDisabled = generating || !variantPrompt.trim();
  const generateLabel = generating ? "Menghasilkan…" : "Hasilkan varian";

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        onChange={onFilePicked}
        style={{ display: "none" }}
      />
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
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-800)" }}>Daftar Gambar</div>
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
            {images.length}
          </span>
          <div style={{ flex: 1 }} />
          <Button variant="outline" onClick={onUploadClick}>
            <svg width="14" height="14" viewBox="0 0 15 15">
              <path
                d="M7.5 9.6V2.4M4.6 5.1 7.5 2.2l2.9 2.9"
                stroke="var(--ink-700)"
                strokeWidth={1.3}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M2.6 9.4v2.2a1 1 0 0 0 1 1h7.8a1 1 0 0 0 1-1V9.4"
                stroke="var(--ink-700)"
                strokeWidth={1.3}
                fill="none"
                strokeLinecap="round"
              />
            </svg>
            Unggah gambar
          </Button>
        </div>

        {!apiKey && (
          <div
            style={{
              padding: "9px 20px",
              background: "var(--indigo-100)",
              borderBottom: "1px solid var(--line-1)",
              fontSize: 12,
              color: "var(--ink-700)",
            }}
          >
            Kunci API {providerLabel} belum diatur — pembuatan varian butuh
            kunci.{" "}
            <Link
              to="/settings"
              style={{ color: "var(--indigo-600)", fontWeight: 600 }}
            >
              Atur sekarang
            </Link>
            .
          </div>
        )}

        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          {/* Grid */}
          <div style={{ flex: 1, overflow: "auto", padding: "20px 22px 32px", minWidth: 0 }}>
            {images.length === 0 ? (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                  color: "var(--ink-400)",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 13, color: "var(--ink-500)" }}>Belum ada aset.</div>
                <div style={{ fontSize: 12 }}>
                  Unggah gambar produk untuk membuat varian pertama.
                </div>
                <div style={{ marginTop: 4 }}>
                  <Button variant="primary" onClick={onUploadClick}>
                    Unggah gambar
                  </Button>
                </div>
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill,minmax(98px,1fr))",
                  gap: 10,
                  alignContent: "start",
                }}
              >
                {pending.map((gen) => (
                  <PendingCard key={gen.id} gen={gen} />
                ))}
                {images.map((img) => (
                  <ImageCard
                    key={img.path}
                    img={img}
                    selected={img.path === selectedPath}
                    dim={dims[img.path]}
                    onSelect={selectAsset}
                    onLoad={handleImageLoad}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Detail panel */}
          {hasSelection && detail && (
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
                  onClick={close}
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
                  <svg width="12" height="12" viewBox="0 0 12 12">
                    <path
                      d="M2.5 2.5l7 7M9.5 2.5l-7 7"
                      stroke="currentColor"
                      strokeWidth={1.4}
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              </div>

              <div style={{ padding: "16px 18px" }}>
                <div
                  style={{
                    position: "relative",
                    height: 230,
                    borderRadius: "var(--r-card)",
                    overflow: "hidden",
                    border: "1px solid var(--line-3)",
                    background: "var(--fill-1)",
                  }}
                >
                  <img
                    src={detail.preview}
                    alt={detail.name}
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: "100%",
                      height: "100%",
                      objectFit: "contain",
                    }}
                  />
                </div>

                <div
                  style={{
                    marginTop: 14,
                    fontFamily: "var(--font-mono)",
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "var(--ink-900)",
                    wordBreak: "break-all",
                  }}
                >
                  {detail.name}
                </div>

                <div
                  style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 9 }}
                >
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
                      {detail.kind}
                    </span>
                  </DetailRow>
                  <DetailRow label="Dimensi">
                    <Mono>{detail.dims} px</Mono>
                  </DetailRow>
                  <DetailRow label="Ukuran">
                    <Mono>{detail.sizeText}</Mono>
                  </DetailRow>
                  <DetailRow label="Ditambahkan">
                    <Mono>{detail.added}</Mono>
                  </DetailRow>
                </div>

                {detail.prompt && (
                  <div style={{ marginTop: 14 }}>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: "var(--ink-500)",
                        marginBottom: 5,
                      }}
                    >
                      Prompt asal
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
                      {detail.prompt}
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

                {variantOpen ? (
                  <div>
                    <textarea
                      placeholder="Jelaskan perubahannya. mis. ganti latar jadi putih bersih, tambah bayangan lembut"
                      value={variantPrompt}
                      onChange={(e) => setVariantPrompt(e.target.value)}
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
                      <Button variant="primary" disabled={generateDisabled} onClick={generate}>
                        <svg width="14" height="14" viewBox="0 0 15 15">
                          <path
                            d="M7.5 1.8l1.3 3.4 3.4 1.3-3.4 1.3L7.5 11.2 6.2 7.8 2.8 6.5 6.2 5.2Z"
                            fill="#fff"
                          />
                        </svg>
                        {generateLabel}
                      </Button>
                      <Button variant="ghost" disabled={generating} onClick={toggleVariant}>
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
                    onClick={toggleVariant}
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
                    <svg width="16" height="16" viewBox="0 0 15 15">
                      <path
                        d="M7.5 1.8l1.3 3.4 3.4 1.3-3.4 1.3L7.5 11.2 6.2 7.8 2.8 6.5 6.2 5.2Z"
                        fill="var(--indigo-500)"
                      />
                    </svg>
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
                  <Button variant="danger" disabled={deleting} onClick={del}>
                    <svg width="14" height="14" viewBox="0 0 15 15">
                      <path
                        d="M3 4h9M6 4V2.8h3V4M4.2 4l.6 8a1 1 0 0 0 1 .95h3.4a1 1 0 0 0 1-.95l.6-8"
                        stroke="var(--red-600)"
                        strokeWidth={1.2}
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    {deleting ? "Menghapus…" : "Hapus aset"}
                  </Button>
                </div>
            </div>
          )}
        </div>
    </>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <span style={{ fontSize: 11.5, color: "var(--ink-500)" }}>{label}</span>
      {children}
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
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
