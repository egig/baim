/** Banner shown when the active provider has no API key saved yet — generation
 *  is gated on it. `onOpenSettings` opens the shell's settings dialog. */
export function ApiKeyBanner({
  providerLabel,
  onOpenSettings,
}: {
  providerLabel: string;
  onOpenSettings: () => void;
}) {
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
      Kunci API {providerLabel} belum diatur — pembuatan varian butuh kunci.{" "}
      <span
        onClick={onOpenSettings}
        style={{
          color: "var(--indigo-600)",
          fontWeight: 600,
          cursor: "pointer",
          textDecoration: "underline",
        }}
      >
        Atur sekarang
      </span>
      .
    </div>
  );
}
