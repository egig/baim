/** Largest edge (px) we keep for an image normalized client-side before it's
 *  shipped across the `invoke()` bridge. Anything bigger is downscaled — a
 *  full-res photo re-encoded to PNG produces a huge payload that is slow to
 *  encode and to transfer, without helping generation or preview quality. */
export const MAX_UPLOAD_DIMENSION = 2048;

/** Normalize a picked file to a PNG data URI without freezing the UI: decode
 *  off the main thread (`createImageBitmap`), downscale oversized images, and
 *  encode asynchronously (`toBlob`) instead of the synchronous `toDataURL`.
 *  Shared by the asset upload flow and the Templat page's preview picker. */
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
