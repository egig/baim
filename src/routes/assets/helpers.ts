import type { ImageEntry } from "../../lib/tauri";
import type { SortDir, SortKey } from "./types";

/** The four sort states offered by the dropdown, in menu order. Each maps a
 *  stable `value` (encoded `key-dir`) to its key, direction, and label. */
export const SORT_OPTIONS: {
  value: string;
  label: string;
  key: SortKey;
  dir: SortDir;
}[] = [
  { value: "date-desc", label: "Terbaru", key: "date", dir: "desc" },
  { value: "date-asc", label: "Terlama", key: "date", dir: "asc" },
  { value: "name-asc", label: "Nama A–Z", key: "name", dir: "asc" },
  { value: "name-desc", label: "Nama Z–A", key: "name", dir: "desc" },
];

export function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1).replace(".", ",") + " MB";
  }
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

export function fmtDate(seconds: number): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function kindOf(filename: string): string {
  const m = filename.match(/\.([^.]+)$/);
  return (m ? m[1] : "IMG").toUpperCase();
}

/** The name shown and searched for an image: its human `title` when present
 *  (uploads keep their original picked name; seeded files use their on-disk
 *  name), falling back to the on-disk `filename` (a uuid for new uploads, or a
 *  real name on legacy/pre-title rows). */
export function displayName(img: ImageEntry): string {
  return img.title ?? img.filename;
}

/** Largest edge (px) we keep for an uploaded source image. Anything bigger is
 *  downscaled — a full-res photo re-encoded to PNG produces a huge payload that
 *  is slow to encode and to ship across the `invoke()` bridge, without helping
 *  generation quality. Bump this if you need more source detail. */
export const MAX_UPLOAD_DIMENSION = 2048;

/** Normalize a picked file to a PNG data URI without freezing the UI: decode
 *  off the main thread (`createImageBitmap`), downscale oversized images, and
 *  encode asynchronously (`toBlob`) instead of the synchronous `toDataURL`. */
export function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("Gagal membaca gambar."));
    createImageBitmap(file)
      .then((bitmap) => {
        const scale = Math.min(
          1,
          MAX_UPLOAD_DIMENSION / Math.max(bitmap.width, bitmap.height)
        );
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
        bitmap.close();
        canvas.toBlob((blob) => {
          if (!blob) {
            fail();
            return;
          }
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result as string);
          fr.onerror = fail;
          fr.readAsDataURL(blob);
        }, "image/png");
      })
      .catch(fail);
  });
}
