import { useT } from "../../lib/i18n";

/** Banner shown when the active provider has no API key saved yet — generation
 *  is gated on it. `onOpenSettings` opens the shell's settings dialog. */
export function ApiKeyBanner({
  providerLabel,
  onOpenSettings,
}: {
  providerLabel: string;
  onOpenSettings: () => void;
}) {
  const { t } = useT();
  return (
    <div
      style={{
        padding: "9px 20px",
        background: "var(--indigo-100)",
        borderBottom: "1px solid var(--line-1)",
        fontSize: 12,
        color: "var(--ink-700)",
      }}
    >
      {t("assets.apiKeyBanner", { provider: providerLabel })}{" "}
      <span
        onClick={onOpenSettings}
        style={{
          color: "var(--indigo-600)",
          fontWeight: 600,
          cursor: "pointer",
          textDecoration: "underline",
        }}
      >
        {t("assets.apiKeyBannerAction")}
      </span>
      .
    </div>
  );
}
