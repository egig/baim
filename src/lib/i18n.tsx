import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import en from "../locales/en.json";
import id from "../locales/id.json";

/** The two shipped UI languages. Indonesian is the historical default. */
export type Lang = "en" | "id";

export const LANGS: Lang[] = ["en", "id"];

type Dict = Record<string, unknown>;
const DICTS: Record<Lang, Dict> = { en, id };
const STORAGE_KEY = "baim.lang";

/** Module-level mirror of the active language, kept in sync by `I18nProvider`.
 *  Lets non-component code (date/size formatters in `helpers.ts`) pick a locale
 *  without threading the value through every call. Components should use
 *  `useT()` so they re-render on a language switch. */
let currentLang: Lang = "id";

export function getLang(): Lang {
  return currentLang;
}

/** BCP-47 tag for `Intl` APIs (dates, number formatting, `localeCompare`). */
export function localeTag(lang: Lang = currentLang): string {
  return lang === "id" ? "id-ID" : "en-US";
}

function detectInitial(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "id") return stored;
  } catch {
    /* localStorage may be unavailable */
  }
  // No saved preference: the app historically shipped Indonesian-only, so
  // default to `id` unless the browser is explicitly English.
  const nav =
    typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "";
  return nav.startsWith("en") ? "en" : "id";
}

function lookup(dict: Dict, key: string): string | undefined {
  const value = key.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object") {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, dict);
  return typeof value === "string" ? value : undefined;
}

type Vars = Record<string, string | number>;

/** Resolve `key` in `lang`, falling back to Indonesian then the raw key.
 *  `{name}` placeholders in the string are filled from `vars`. */
export function translate(lang: Lang, key: string, vars?: Vars): string {
  const raw = lookup(DICTS[lang], key) ?? lookup(DICTS.id, key) ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in vars ? String(vars[name]) : `{${name}}`
  );
}

export type TFn = (key: string, vars?: Vars) => string;

interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: TFn;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitial);
  // Mirror synchronously so a formatter called during this same render picks
  // up the new language.
  currentLang = lang;

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Lang) => setLangState(next), []);
  const t = useCallback<TFn>((key, vars) => translate(lang, key, vars), [lang]);

  const value = useMemo<I18nValue>(
    () => ({ lang, setLang, t }),
    [lang, setLang, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT must be used within an I18nProvider");
  return ctx;
}
