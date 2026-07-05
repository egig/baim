import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getStorageDir, setStorageDir } from "../lib/tauri";

const STORAGE_KEY = "replicate_api_key";

const styles = {
  page: {
    maxWidth: 480,
    margin: "40px auto",
    display: "flex",
    flexDirection: "column" as const,
    gap: 20,
  },
  card: {
    padding: "24px 28px",
    background: "var(--surface-0)",
    border: "1px solid var(--line-3)",
    borderRadius: "var(--r-window)",
    display: "flex",
    flexDirection: "column" as const,
    gap: 18,
  },
  title: {
    fontSize: 18,
    fontWeight: 700,
    color: "var(--ink-900)",
    margin: "0 0 2px",
  },
  heading: {
    fontSize: 16,
    fontWeight: 600,
    color: "var(--ink-900)",
  },
  sub: {
    fontSize: 12,
    color: "var(--ink-500)",
    lineHeight: 1.45,
    margin: 0,
  },
  label: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--ink-700)",
    marginBottom: 6,
    display: "block",
  },
  input: {
    width: "100%",
    padding: "9px 11px",
    border: "1px solid var(--line-4)",
    borderRadius: "var(--r-control)",
    fontSize: 13,
    fontFamily: "var(--font-mono)",
    color: "var(--ink-800)",
    background: "var(--surface-0)",
    outline: "none",
    boxSizing: "border-box" as const,
  },
  pathBox: {
    flex: 1,
    padding: "9px 11px",
    border: "1px solid var(--line-4)",
    borderRadius: "var(--r-control)",
    fontSize: 12.5,
    fontFamily: "var(--font-mono)",
    color: "var(--ink-700)",
    background: "var(--surface-1)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    minWidth: 0,
  },
  row: {
    display: "flex",
    gap: 10,
    alignItems: "center",
  },
  btn: {
    height: 34,
    padding: "0 16px",
    borderRadius: "var(--r-button)",
    fontSize: 12.5,
    fontWeight: 600,
    border: "1px solid transparent",
    cursor: "pointer",
    transition: "background .12s",
    whiteSpace: "nowrap" as const,
  },
  btnPrimary: {
    background: "var(--indigo-500)",
    color: "#fff",
  },
  btnPrimaryDisabled: {
    opacity: 0.5,
    cursor: "not-allowed",
  },
  btnOutline: {
    background: "var(--surface-0)",
    borderColor: "var(--line-4)",
    color: "var(--ink-700)",
  },
  footer: {
    fontSize: 11.5,
    color: "var(--ink-400)",
  },
  link: {
    color: "var(--indigo-500)",
    fontWeight: 600,
    textDecoration: "none",
  },
  error: {
    fontSize: 11.5,
    color: "var(--red-600)",
    margin: 0,
  },
};

function ApiKeySection() {
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
    <div style={styles.card}>
      <div>
        <div style={styles.heading}>Replicate API Key</div>
        <p style={styles.sub}>
          Your key is stored locally in your browser and never sent anywhere
          except directly to Replicate's API.
        </p>
      </div>

      <div>
        <label htmlFor="api-key" style={styles.label}>
          API Key
        </label>
        <input
          id="api-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="r8_..."
          style={styles.input}
        />
      </div>

      <div style={styles.row}>
        <button
          onClick={handleSave}
          disabled={!apiKey.trim()}
          style={{
            ...styles.btn,
            ...styles.btnPrimary,
            ...(apiKey.trim() ? {} : styles.btnPrimaryDisabled),
          }}
        >
          {saved ? "Saved!" : "Save"}
        </button>
        <button
          onClick={handleClear}
          style={{ ...styles.btn, ...styles.btnOutline }}
        >
          Clear
        </button>
      </div>

      <div style={styles.footer}>
        Don't have a key?{" "}
        <a
          href="https://replicate.com/account/api-tokens"
          target="_blank"
          rel="noopener noreferrer"
          style={styles.link}
        >
          Get one from Replicate
        </a>
      </div>
    </div>
  );
}

function StorageSection() {
  const [dir, setDir] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getStorageDir()
      .then(setDir)
      .catch((e) => setError(String(e)));
  }, []);

  async function handleChoose() {
    setError(null);
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: dir || undefined,
    });
    if (typeof selected !== "string") return;

    setBusy(true);
    try {
      const resolved = await setStorageDir(selected);
      setDir(resolved);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.card}>
      <div>
        <div style={styles.heading}>Storage Location</div>
        <p style={styles.sub}>
          Where uploaded and generated images are saved on disk. Existing files
          in the chosen folder are imported automatically.
        </p>
      </div>

      <div>
        <label style={styles.label}>Images folder</label>
        <div style={styles.row}>
          <div style={styles.pathBox} title={dir}>
            {dir || "…"}
          </div>
          <button
            onClick={handleChoose}
            disabled={busy}
            style={{
              ...styles.btn,
              ...styles.btnOutline,
              ...(busy ? styles.btnPrimaryDisabled : {}),
            }}
          >
            {busy ? "Saving…" : saved ? "Saved!" : "Change…"}
          </button>
        </div>
      </div>

      {error && <p style={styles.error}>{error}</p>}
    </div>
  );
}

export default function Settings() {
  return (
    <div style={styles.page}>
      <h1 style={styles.title}>Settings</h1>
      <ApiKeySection />
      <StorageSection />
    </div>
  );
}
