import { useState } from "react";

const STORAGE_KEY = "replicate_api_key";

export default function Setup() {
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem(STORAGE_KEY) ?? ""
  );
  const [saved, setSaved] = useState(false);

  function handleSave() {
    if (!apiKey.trim()) return;
    localStorage.setItem(STORAGE_KEY, apiKey.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handleClear() {
    localStorage.removeItem(STORAGE_KEY);
    setApiKey("");
  }

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white mb-1">
          Replicate API Key
        </h2>
        <p className="text-sm text-gray-400">
          Your key is stored locally in your browser and never sent anywhere
          except directly to Replicate's API.
        </p>
      </div>

      <div className="space-y-3">
        <label
          htmlFor="api-key"
          className="block text-sm font-medium text-gray-300"
        >
          API Key
        </label>
        <input
          id="api-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="r8_..."
          className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>

      <div className="flex gap-3">
        <button
          onClick={handleSave}
          disabled={!apiKey.trim()}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saved ? "Saved!" : "Save"}
        </button>
        <button
          onClick={handleClear}
          className="px-4 py-2 bg-gray-800 text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors"
        >
          Clear
        </button>
      </div>

      <p className="text-xs text-gray-500">
        Don't have a key?{" "}
        <a
          href="https://replicate.com/account/api-tokens"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:text-blue-300"
        >
          Get one from Replicate
        </a>
      </p>
    </div>
  );
}
