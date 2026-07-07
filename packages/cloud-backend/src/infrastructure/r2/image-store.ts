import type { ImageStore } from "../../domain/ports";

export class R2ImageStore implements ImageStore {
  constructor(private bucket: R2Bucket) {}

  async upload(key: string, data: ArrayBuffer, contentType: string): Promise<string> {
    await this.bucket.put(key, data, { httpMetadata: { contentType } });
    return key;
  }

  getDownloadUrl(key: string): string {
    // Returns a URL that the desktop app can use to download the image.
    // In production, this could be a signed URL. For now, the desktop will
    // download via the GET /api/images/:key endpoint.
    return `/api/images/${key}`;
  }
}
