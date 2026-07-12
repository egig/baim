import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  listProviders,
  hasApiKey,
  setApiKey as saveApiKey,
  type ProviderInfo,
} from "../lib/tauri";
import { IconX } from "../lib/icons";

const styles = {
  header: {
    height: 52,
    flexShrink: 0,
    padding: "0 20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: "1px solid var(--line-1)",
  },
  body: {
    flex: 1,
    overflow: "auto",
    padding: 20,
    display: "flex",
    flexDirection: "column" as const,
    gap: 16,
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
    fontSize: 14,
    fontWeight: 600,
    color: "var(--ink-800)",
    margin: 0,
  },
  closeBtn: {
    width: 24,
    height: 24,
    borderRadius: 6,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    color: "var(--ink-400)",
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

function ApiKeySection({ provider }: { provider: ProviderInfo }) {
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [stored, setStored] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setApiKey("");
    setStored(false);
    hasApiKey(provider.id)
      .then((has) => {
        if (!cancelled) setStored(has);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [provider.id]);

  async function handleSave() {
    if (!apiKey.trim()) return;
    setError(null);
    try {
      await saveApiKey(provider.id, apiKey.trim());
      setApiKey("");
      setStored(true);
      setSaved(true);
      qc.invalidateQueries({ queryKey: ["hasApiKey", provider.id] });
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleClear() {
    setError(null);
    try {
      await saveApiKey(provider.id, "");
      setApiKey("");
      setStored(false);
      qc.invalidateQueries({ queryKey: ["hasApiKey", provider.id] });
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <>
      <div>
        <div style={styles.heading}>{provider.label} API Key</div>
        <p style={styles.sub}>
          Your key is stored locally on this machine and never sent anywhere
          except directly to {provider.label}'s API.
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
          placeholder={stored ? "•••••••• (saved)" : provider.key_hint}
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
          disabled={!stored}
          style={{
            ...styles.btn,
            ...styles.btnOutline,
            ...(stored ? {} : styles.btnPrimaryDisabled),
          }}
        >
          Clear
        </button>
      </div>

      {error && <p style={styles.error}>{error}</p>}

      <div style={styles.footer}>
        Don't have a key?{" "}
        <a
          href={provider.key_url}
          target="_blank"
          rel="noopener noreferrer"
          style={styles.link}
        >
          Get one from {provider.label}
        </a>
      </div>
    </>
  );
}

export default function Settings({ onClose }: { onClose: () => void }) {
  const [provider, setProvider] = useState<ProviderInfo | null>(null);

  useEffect(() => {
    listProviders()
      .then((providers) => setProvider(providers[0] ?? null))
      .catch(() => {});
  }, []);

  return (
    <>
      <div style={styles.header}>
        <h1 style={styles.title}>Pengaturan</h1>
        <div onClick={onClose} style={styles.closeBtn}>
          <IconX size={12} />
        </div>
      </div>
      <div style={styles.body}>
        {provider && (
          <div style={styles.card}>
            <ApiKeySection provider={provider} />
          </div>
        )}
      </div>
    </>
  );
}
