import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { chatMessagesQuery, dirListingQuery, generationsQuery } from "../lib/queries";
import { hasApiKey, sendChatMessage, type ChatMessage, type Generation } from "../lib/tauri";
import { useT } from "../lib/i18n";
import { useShell, ImageViewer } from "../root";
import { ApiKeyBanner } from "./ApiKeyBanner";
import {
  IconRobot,
  IconSend2,
  IconX,
  IconLoader2,
  IconSparkles,
  IconAlertTriangle,
} from "../lib/icons";

const CHAT_PROVIDER = "openai_compatible";
const PANE_WIDTH = 340;

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Inline status for an assistant turn that triggered a generation, tracked
 *  live via the shared generations query rather than the chat message's own
 *  (frozen-at-creation) content. */
function GenerationResult({
  generationId,
  onView,
}: {
  generationId: string;
  onView: (src: string) => void;
}) {
  const { t } = useT();
  const { data: generations = [] } = useQuery(generationsQuery);
  const gen = generations.find((g) => g.id === generationId);
  if (!gen) return null;

  if (gen.status === "queued" || gen.status === "pending") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 11.5, color: "var(--ink-500)" }}>
        <IconLoader2 size={12} className="assets-spin" />
        {t("chat.generating")}
      </div>
    );
  }
  if (gen.status === "failed") {
    return (
      <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--red-600)" }}>
        {gen.error ?? t("chat.generationFailed")}
      </div>
    );
  }
  if (gen.status === "succeeded" && gen.output_path) {
    const src = convertFileSrc(gen.output_path);
    return (
      <div
        onClick={() => onView(src)}
        style={{
          marginTop: 6,
          width: 140,
          height: 140,
          borderRadius: "var(--r-card)",
          overflow: "hidden",
          border: "1px solid var(--line-3)",
          cursor: "zoom-in",
          position: "relative",
        }}
      >
        <img
          src={src}
          alt={gen.prompt}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      </div>
    );
  }
  return null;
}

function Bubble({ msg, onView }: { msg: ChatMessage; onView: (src: string) => void }) {
  const isUser = msg.role === "user";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start" }}>
      {msg.attachments.length > 0 && (
        <div style={{ display: "flex", gap: 4, marginBottom: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {msg.attachments.map((path) => (
            <div
              key={path}
              title={fileName(path)}
              style={{
                width: 44,
                height: 44,
                borderRadius: "var(--r-control)",
                overflow: "hidden",
                border: "1px solid var(--line-3)",
                position: "relative",
                flexShrink: 0,
              }}
            >
              <img
                src={convertFileSrc(path)}
                alt=""
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
              />
            </div>
          ))}
        </div>
      )}
      {msg.content && (
        <div
          style={{
            maxWidth: "100%",
            padding: "8px 11px",
            borderRadius: "var(--r-card)",
            fontSize: 12.5,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            background: isUser ? "var(--indigo-500)" : "var(--fill-1)",
            color: isUser ? "#fff" : "var(--ink-800)",
          }}
        >
          {msg.content}
        </div>
      )}
      {msg.generation_id && <GenerationResult generationId={msg.generation_id} onView={onView} />}
    </div>
  );
}

/** Persistent AI chat pane, always mounted on the right — one continuous
 *  thread, saved to the backend and restored on relaunch. Files selected in
 *  the browser attach here as context chips (see `useShell`); sending a
 *  message may trigger a generation via the assistant's one tool, whose
 *  live status renders inline via `GenerationResult`. */
export function ChatPane() {
  const { t } = useT();
  const qc = useQueryClient();
  const { attachments, toggleAttachment, clearAttachments, currentPath, openSettings } = useShell();
  const { data: messages = [] } = useQuery(chatMessagesQuery);
  const { data: hasKey } = useQuery({
    queryKey: ["hasApiKey", CHAT_PROVIDER] as const,
    queryFn: () => hasApiKey(CHAT_PROVIDER),
    staleTime: 30_000,
  });

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  // A generation triggered from chat writes its output next to its source
  // image (see generation.rs::resolve_output_dir) — if that's the folder
  // currently being browsed, refresh the listing so the new file appears
  // without the user having to navigate away and back.
  const { data: generations = [] } = useQuery(generationsQuery);
  const succeededIds = useMemo(
    () => generations.filter((g: Generation) => g.status === "succeeded").map((g) => g.id).join(","),
    [generations]
  );
  useEffect(() => {
    if (currentPath) {
      void qc.invalidateQueries({ queryKey: dirListingQuery(currentPath).queryKey });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [succeededIds]);

  async function send() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    try {
      const created = await sendChatMessage(trimmed, attachments);
      qc.setQueryData<ChatMessage[]>(chatMessagesQuery.queryKey, (old) =>
        old ? [...old, ...created] : created
      );
      const lastGenId = created.find((m) => m.generation_id)?.generation_id;
      if (lastGenId) void qc.invalidateQueries({ queryKey: generationsQuery.queryKey });
      setText("");
      clearAttachments();
    } catch (err) {
      setError(String(err));
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div
      style={{
        width: PANE_WIDTH,
        flexShrink: 0,
        borderLeft: "1px solid var(--line-1)",
        background: "var(--surface-1)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {viewerSrc && <ImageViewer src={viewerSrc} onClose={() => setViewerSrc(null)} />}

      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--line-1)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <IconRobot size={16} color="var(--indigo-600)" />
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink-800)" }}>{t("chat.title")}</span>
      </div>

      {hasKey === false && (
        <ApiKeyBanner providerLabel="OpenAI-compatible" onOpenSettings={openSettings} />
      )}

      <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
        {messages.length === 0 && (
          <div style={{ margin: "auto", textAlign: "center", color: "var(--ink-400)", fontSize: 12, maxWidth: 220 }}>
            <IconSparkles size={20} color="var(--ink-350)" />
            <div style={{ marginTop: 8 }}>{t("chat.empty")}</div>
          </div>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} msg={m} onView={setViewerSrc} />
        ))}
        {sending && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--ink-400)" }}>
            <IconLoader2 size={12} className="assets-spin" />
            {t("chat.thinking")}
          </div>
        )}
      </div>

      {error && (
        <div style={{ padding: "0 14px 8px", fontSize: 11.5, color: "var(--red-600)", display: "flex", alignItems: "flex-start", gap: 5 }}>
          <IconAlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          {error}
        </div>
      )}

      <div style={{ padding: "10px 14px 14px", borderTop: "1px solid var(--line-1)", flexShrink: 0 }}>
        {attachments.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {attachments.map((path) => (
              <div
                key={path}
                title={path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "3px 6px 3px 8px",
                  borderRadius: "var(--r-badge)",
                  background: "var(--fill-1)",
                  fontSize: 11,
                  color: "var(--ink-700)",
                  maxWidth: 150,
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {fileName(path)}
                </span>
                <span
                  onClick={() => toggleAttachment(path)}
                  style={{ cursor: "pointer", display: "flex", color: "var(--ink-400)" }}
                >
                  <IconX size={11} />
                </span>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("chat.placeholder")}
            rows={2}
            style={{
              flex: 1,
              resize: "none",
              border: "1px solid var(--line-4)",
              borderRadius: "var(--r-button)",
              padding: "8px 10px",
              fontFamily: "var(--font-ui)",
              fontSize: 12.5,
              color: "var(--ink-800)",
              lineHeight: 1.4,
              outline: "none",
              background: "var(--surface-0)",
            }}
          />
          <button
            type="button"
            onClick={send}
            disabled={sending || !text.trim()}
            title={t("chat.send")}
            style={{
              width: 32,
              height: 32,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "var(--r-button)",
              border: "none",
              background: "var(--indigo-500)",
              color: "#fff",
              cursor: sending || !text.trim() ? "not-allowed" : "pointer",
              opacity: sending || !text.trim() ? 0.5 : 1,
            }}
          >
            <IconSend2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
