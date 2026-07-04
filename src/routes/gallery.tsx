import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getImages, type ImageEntry } from "../lib/tauri";
import ImageCard from "../components/image-card";

export default function Gallery() {
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getImages()
      .then(setImages)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white mb-1">Gallery</h2>
        <p className="text-sm text-gray-400">
          Previously generated product images.
        </p>
      </div>

      {loading && (
        <p className="text-gray-500 text-sm">Loading...</p>
      )}

      {!loading && images.length === 0 && (
        <p className="text-gray-500 text-sm">
          No images generated yet. Go to the Generate page to create one.
        </p>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {images.map((img) => (
          <ImageCard
            key={img.path}
            src={convertFileSrc(img.path)}
            filename={img.filename}
            created={
              img.created_at
                ? new Date(img.created_at * 1000).toLocaleDateString()
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}
