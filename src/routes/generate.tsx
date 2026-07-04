import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { convertFileSrc } from "@tauri-apps/api/core";
import Dropzone from "../components/dropzone";
import {
  createPrediction,
  refreshGeneration,
  getGenerations,
  type Generation,
} from "../lib/tauri";

const STORAGE_KEY = "replicate_api_key";

export default function Generate() {
  const navigate = useNavigate();
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [resultPath, setResultPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<Generation[]>([]);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  // Synchronous re-entrancy guard. The button's `disabled` only takes effect on
  // the next render commit, so rapid/duplicate clicks can slip several
  // `startGeneration` calls through before then, each firing its own create.
  // A ref flips immediately, so any extra call bails out at once.
  const inFlight = useRef(false);

  const apiKey = localStorage.getItem(STORAGE_KEY);

  function loadRecent() {
    getGenerations().then(setRecent).catch(console.error);
  }

  useEffect(() => {
    loadRecent();
  }, []);

  function handleFile(uri: string, name: string) {
    setDataUri(uri);
    setImageName(name);
    setResultPath(null);
    setError(null);
  }

  async function startGeneration(uri: string, promptText: string) {
    if (inFlight.current) return;

    const key = localStorage.getItem(STORAGE_KEY);
    if (!key) {
      navigate("/");
      return;
    }

    inFlight.current = true;
    setGenerating(true);
    setError(null);
    setResultPath(null);

    try {
      // Async mode: this returns as soon as the prediction is queued. The new
      // record shows up in "Recent generations" as pending; the user refreshes
      // it to pull the finished image.
      await createPrediction(uri, promptText, key);
    } catch (err) {
      setError(String(err));
    } finally {
      // Whether it queued or failed at creation, a record was stored — reload
      // so the pending/failed entry appears.
      loadRecent();
      setGenerating(false);
      inFlight.current = false;
    }
  }

  function handleGenerate() {
    if (!dataUri || !prompt.trim()) return;
    startGeneration(dataUri, prompt.trim());
  }

  function regenerate(g: Generation) {
    setDataUri(g.input_data_uri);
    setImageName("Reused source image");
    setPrompt(g.prompt);
    startGeneration(g.input_data_uri, g.prompt);
  }

  async function refresh(g: Generation) {
    const key = localStorage.getItem(STORAGE_KEY);
    if (!key) {
      navigate("/");
      return;
    }

    setRefreshingId(g.id);
    setError(null);

    try {
      const updated = await refreshGeneration(g.id, key);
      if (updated.status === "succeeded" && updated.output_path) {
        setResultPath(updated.output_path);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      loadRecent();
      setRefreshingId(null);
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
          {generating ? "Starting..." : "Generate"}
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

      {recent.length > 0 && (
        <div className="space-y-3 pt-4 border-t border-gray-800">
          <h3 className="text-sm font-medium text-gray-300">
            Recent generations
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {recent.map((g) => {
              const pending = g.status === "pending";
              const failed = g.status === "failed";
              const dimmed = pending || failed;
              const thumb = g.output_path
                ? convertFileSrc(g.output_path)
                : g.input_data_uri;
              const isRefreshing = refreshingId === g.id;
              return (
                <div
                  key={g.id}
                  className="space-y-2 rounded-lg border border-gray-800 p-2"
                >
                  <div className="relative">
                    <img
                      src={thumb}
                      alt={g.prompt}
                      className={`w-full aspect-square rounded object-cover border border-gray-800 ${
                        dimmed ? "opacity-40" : ""
                      }`}
                    />
                    {pending && (
                      <span className="absolute top-1 left-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-900/80 text-amber-200">
                        Pending
                      </span>
                    )}
                    {failed && (
                      <span className="absolute top-1 left-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-red-900/80 text-red-200">
                        Failed
                      </span>
                    )}
                  </div>
                  <p
                    className="text-xs text-gray-400 line-clamp-2"
                    title={g.prompt}
                  >
                    {g.prompt}
                  </p>
                  {failed && g.error && (
                    <p
                      className="text-[10px] text-red-400 line-clamp-2"
                      title={g.error}
                    >
                      {g.error}
                    </p>
                  )}
                  {pending ? (
                    <button
                      onClick={() => refresh(g)}
                      disabled={isRefreshing || !apiKey}
                      className="w-full py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {isRefreshing ? "Refreshing..." : "Refresh status"}
                    </button>
                  ) : (
                    <button
                      onClick={() => regenerate(g)}
                      disabled={generating || !apiKey}
                      className="w-full py-1.5 text-xs bg-gray-800 text-gray-200 rounded hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {failed ? "Retry" : "Re-generate"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
