interface ImageCardProps {
  src: string;
  filename: string;
  created?: string;
}

export default function ImageCard({ src, filename, created }: ImageCardProps) {
  return (
    <div className="group relative bg-gray-900 rounded-xl overflow-hidden border border-gray-800">
      <img
        src={src}
        alt={filename}
        className="w-full h-48 object-cover"
        loading="lazy"
      />
      <div className="p-3 space-y-1">
        <p className="text-sm text-gray-300 truncate">{filename}</p>
        {created && (
          <p className="text-xs text-gray-500">{created}</p>
        )}
      </div>
    </div>
  );
}
