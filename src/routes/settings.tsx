import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  listProviders,
  hasApiKey,
  setApiKey as saveApiKey,
  getActiveProvider,
  setActiveProvider,
  getMaxConcurrency,
  setMaxConcurrency,
  getOpenAiCompatibleConfig,
  setOpenAiCompatibleConfig,
  type ProviderInfo,
} from "../lib/tauri";
import { setConcurrencyCeiling } from "../lib/queries";
import { LANGS, useT } from "../lib/i18n";
import { Segmented } from "../components/Segmented";
import { IconX, IconChevronDown } from "../lib/icons";

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
  toggleRow: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    cursor: "pointer",
    userSelect: "none" as const,
  },
  toggleLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--ink-700)",
  },
};

function LanguageSection() {
  const { lang, setLang, t } = useT();
  return (
    <>
      <div>
        <div style={styles.heading}>{t("lang.label")}</div>
        <p style={styles.sub}>{t("lang.desc")}</p>
      </div>
      <Segmented
        options={LANGS.map((l) => ({ value: l, label: t(`lang.${l}`) }))}
        value={lang}
        onChange={setLang}
      />
    </>
  );
}

function ProviderSwitcher({
  providers,
  activeId,
  onChange,
}: {
  providers: ProviderInfo[];
  activeId: string;
  onChange: (id: string) => void;
}) {
  const { t } = useT();
  return (
    <>
      <div>
        <div style={styles.heading}>{t("settings.providerHeading")}</div>
        <p style={styles.sub}>{t("settings.providerDesc")}</p>
      </div>
      <Segmented
        options={providers.map((p) => ({ value: p.id, label: p.label }))}
        value={activeId}
        onChange={onChange}
      />
    </>
  );
}

/** Base URL + Model id inputs for the OpenAI-compatible provider — the only
 *  provider whose endpoint and model aren't fixed in code. */
function OpenAiCompatibleConfigSection() {
  const { t } = useT();
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getOpenAiCompatibleConfig()
      .then((cfg) => {
        if (cancelled) return;
        setBaseUrl(cfg.base_url ?? "");
        setModel(cfg.model ?? "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    if (!baseUrl.trim() || !model.trim()) return;
    setError(null);
    try {
      await setOpenAiCompatibleConfig(baseUrl.trim(), model.trim());
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <>
      <div>
        <label htmlFor="base-url" style={styles.label}>
          {t("settings.baseUrlLabel")}
        </label>
        <input
          id="base-url"
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={t("settings.baseUrlPlaceholder")}
          style={styles.input}
        />
        <p style={{ ...styles.sub, marginTop: 6 }}>{t("settings.baseUrlDesc")}</p>
      </div>

      <div>
        <label htmlFor="model-id" style={styles.label}>
          {t("settings.modelIdLabel")}
        </label>
        <input
          id="model-id"
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={t("settings.modelIdPlaceholder")}
          style={styles.input}
        />
        <p style={{ ...styles.sub, marginTop: 6 }}>{t("settings.modelIdDesc")}</p>
      </div>

      <div style={styles.row}>
        <button
          onClick={handleSave}
          disabled={!baseUrl.trim() || !model.trim()}
          style={{
            ...styles.btn,
            ...styles.btnPrimary,
            ...(baseUrl.trim() && model.trim() ? {} : styles.btnPrimaryDisabled),
          }}
        >
          {saved ? t("common.saved") : t("common.save")}
        </button>
      </div>

      {error && <p style={styles.error}>{error}</p>}
    </>
  );
}

function ApiKeySection({ provider }: { provider: ProviderInfo }) {
  const { t } = useT();
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
        <div style={styles.heading}>
          {t("settings.apiKeyHeading", { provider: provider.label })}
        </div>
        <p style={styles.sub}>
          {t("settings.apiKeyDesc", { provider: provider.label })}
        </p>
      </div>

      <div>
        <label htmlFor="api-key" style={styles.label}>
          {t("settings.apiKeyLabel")}
        </label>
        <input
          id="api-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            stored ? t("settings.savedPlaceholder") : provider.key_hint
          }
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
          {saved ? t("common.saved") : t("common.save")}
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
          {t("settings.clear")}
        </button>
      </div>

      {error && <p style={styles.error}>{error}</p>}

      {provider.key_url && (
        <div style={styles.footer}>
          {t("settings.noKeyQuestion")}{" "}
          <a
            href={provider.key_url}
            target="_blank"
            rel="noopener noreferrer"
            style={styles.link}
          >
            {t("settings.getKeyFrom", { provider: provider.label })}
          </a>
        </div>
      )}
    </>
  );
}

function AdvancedSection() {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState<number | "">("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getMaxConcurrency()
      .then(setValue)
      .catch(() => {});
  }, []);

  async function handleSave() {
    if (value === "") return;
    setError(null);
    try {
      await setMaxConcurrency(value);
      setConcurrencyCeiling(value);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <>
      <div
        onClick={() => setExpanded((v) => !v)}
        style={styles.toggleRow}
      >
        <IconChevronDown
          size={12}
          color="var(--ink-400)"
          style={{
            transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
            transition: "transform .12s ease",
          }}
        />
        <span style={styles.toggleLabel}>{t("settings.advanced")}</span>
      </div>

      {expanded && (
        <div
          style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 4 }}
        >
          <div>
            <label htmlFor="max-concurrency" style={styles.label}>
              {t("settings.maxConcurrent")}
            </label>
            <input
              id="max-concurrency"
              type="number"
              min={1}
              max={100}
              value={value}
              onChange={(e) =>
                setValue(e.target.value === "" ? "" : Number(e.target.value))
              }
              style={styles.input}
            />
            <p style={{ ...styles.sub, marginTop: 6 }}>
              {t("settings.maxConcurrentDesc")}
            </p>
          </div>

          <div style={styles.row}>
            <button
              onClick={handleSave}
              disabled={value === ""}
              style={{
                ...styles.btn,
                ...styles.btnPrimary,
                ...(value === "" ? styles.btnPrimaryDisabled : {}),
              }}
            >
              {saved ? t("common.saved") : t("common.save")}
            </button>
          </div>

          {error && <p style={styles.error}>{error}</p>}
        </div>
      )}
    </>
  );
}

export default function Settings({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listProviders(), getActiveProvider()])
      .then(([providers, active]) => {
        setProviders(providers);
        setActiveId(providers.some((p) => p.id === active) ? active : providers[0]?.id ?? null);
      })
      .catch(() => {});
  }, []);

  async function handleProviderChange(id: string) {
    setActiveId(id);
    try {
      await setActiveProvider(id);
    } catch {
      /* ignore — the picker still reflects the attempted choice */
    }
  }

  const provider = providers.find((p) => p.id === activeId) ?? null;

  return (
    <>
      <div style={styles.header}>
        <h1 style={styles.title}>{t("settings.title")}</h1>
        <div onClick={onClose} style={styles.closeBtn}>
          <IconX size={12} />
        </div>
      </div>
      <div style={styles.body}>
        <div style={styles.card}>
          <LanguageSection />
        </div>
        {providers.length > 1 && activeId && (
          <div style={styles.card}>
            <ProviderSwitcher
              providers={providers}
              activeId={activeId}
              onChange={handleProviderChange}
            />
          </div>
        )}
        {provider && (
          <div style={styles.card}>
            <ApiKeySection provider={provider} />
            {provider.id === "openai_compatible" && <OpenAiCompatibleConfigSection />}
          </div>
        )}
        <div style={styles.card}>
          <AdvancedSection />
        </div>
      </div>
    </>
  );
}
