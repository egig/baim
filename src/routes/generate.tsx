import { useState } from "react";
import { useNavigate } from "react-router";
import { convertFileSrc } from "@tauri-apps/api/core";
import Dropzone from "../components/dropzone";
import { generateImage } from "../lib/tauri";

const STORAGE_KEY = "replicate_api_key";

export default function Generate() {
  const navigate = useNavigate();
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [resultPath, setResultPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apiKey = localStorage.getItem(STORAGE_KEY);

  function handleFile(uri: string, name: string) {
    setDataUri(uri);
    setImageName(name);
    setResultPath(null);
    setError(null);
  }

  async function handleGenerate() {
    if (!dataUri || !prompt.trim()) return;

    const key = localStorage.getItem(STORAGE_KEY);
    if (!key) {
      navigate("/");
      return;
    }

    setGenerating(true);
    setError(null);
    setResultPath(null);

    try {
      const path = await generateImage(dataUri, prompt.trim(), key);
      setResultPath(path);
    } catch (err) {
      setError(String(err));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white mb-1">
          Generate Product Image
        </h2>
        <p className="text-sm text-gray-400">
          Upload a product photo and describe the variation you want.
        </p>
      </div>

      <div className="space-y-4">
        {!dataUri ? (
          <Dropzone onFile={handleFile} disabled={generating} />
        ) : (
          <div className="space-y-3">
            <div className="relative inline-block">
              <img
                src={dataUri}
                alt={imageName}
                className="h-48 rounded-lg object-cover border border-gray-800"
              />
              <button
                onClick={() => {
                  setDataUri(null);
                  setResultPath(null);
                }}
                disabled={generating}
                className="absolute -top-2 -right-2 bg-gray-800 rounded-full p-1 hover:bg-gray-700 disabled:opacity-50"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <p className="text-sm text-gray-400">{imageName}</p>
          </div>
        )}

        <div className="space-y-2">
          <label
            htmlFor="prompt"
            className="block text-sm font-medium text-gray-300"
          >
            Prompt
          </label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. product on a wooden table with natural lighting"
            rows={3}
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
          />
        </div>

        <button
          onClick={handleGenerate}
          disabled={!dataUri || !prompt.trim() || generating || !apiKey}
          className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {generating ? "Generating..." : "Generate"}
        </button>

        {error && (
          <div className="p-3 bg-red-900/50 border border-red-800 rounded-lg text-sm text-red-300">
            {error}
          </div>
        )}

        {resultPath && (
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-gray-300">Result</h3>
            <img
              src={convertFileSrc(resultPath)}
              alt="Generated"
              className="max-w-full rounded-lg border border-gray-800"
            />
            <p className="text-xs text-gray-500 truncate">{resultPath}</p>
          </div>
        )}
      </div>
    </div>
  );
}
