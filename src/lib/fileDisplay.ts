import { localeTag } from "./i18n";

export function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return (
      (bytes / (1024 * 1024)).toLocaleString(localeTag(), {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }) + " MB"
    );
  }
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

/** `modified_at`/`created_at` are unix seconds. */
export function fmtDate(seconds: number): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleDateString(localeTag(), {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** The file extension, uppercased, for a generic-file tile's badge (e.g.
 *  "PDF", "MP4") — falls back to "FILE" for extensionless names. */
export function kindOf(filename: string): string {
  const m = filename.match(/\.([^.]+)$/);
  return (m ? m[1] : "FILE").toUpperCase();
}
