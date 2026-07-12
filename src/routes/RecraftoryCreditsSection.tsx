import { useEffect, useState } from "react";
import { getRecraftoryCreditBalance } from "../lib/tauri";

const styles = {
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  label: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--ink-700)",
  },
  balance: {
    fontSize: 13,
    fontFamily: "var(--font-mono)",
    color: "var(--ink-800)",
  },
  refresh: {
    fontSize: 11.5,
    fontWeight: 600,
    color: "var(--indigo-500)",
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
  },
  error: {
    fontSize: 11.5,
    color: "var(--red-600)",
    margin: 0,
  },
};

export default function RecraftoryCreditsSection() {
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    getRecraftoryCreditBalance()
      .then(setBalance)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  return (
    <div style={styles.row}>
      <span style={styles.label}>Remaining credits</span>
      {error ? (
        <p style={styles.error}>{error}</p>
      ) : (
        <div style={styles.row}>
          <span style={styles.balance}>{loading ? "…" : balance}</span>
          <button onClick={load} style={styles.refresh}>
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}
