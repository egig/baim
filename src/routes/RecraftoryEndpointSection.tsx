import { useEffect, useState } from "react";
import { getRecraftoryEndpoint, setRecraftoryEndpoint } from "../lib/tauri";

const styles = {
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
  error: {
    fontSize: 11.5,
    color: "var(--red-600)",
    margin: 0,
  },
};

export default function RecraftoryEndpointSection() {
  const [endpoint, setEndpoint] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getRecraftoryEndpoint()
      .then((value) => setEndpoint(value ?? ""))
      .catch(() => {});
  }, []);

  async function handleSave() {
    if (!endpoint.trim()) return;
    setError(null);
    try {
      await setRecraftoryEndpoint(endpoint.trim());
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div>
      <label htmlFor="recraftory-endpoint" style={styles.label}>
        Backend endpoint
      </label>
      <div style={styles.row}>
        <input
          id="recraftory-endpoint"
          type="text"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="https://your-worker.example.workers.dev"
          style={styles.input}
        />
        <button
          onClick={handleSave}
          disabled={!endpoint.trim()}
          style={{
            ...styles.btn,
            ...styles.btnPrimary,
            ...(endpoint.trim() ? {} : styles.btnPrimaryDisabled),
          }}
        >
          {saved ? "Saved!" : "Save"}
        </button>
      </div>
      {error && <p style={styles.error}>{error}</p>}
    </div>
  );
}
