import type { ProviderClient, ProviderCreateResult, ProviderPollResult } from "../../domain/ports";

const MODEL = "gemini-3.1-flash-image";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_ATTEMPTS = 3;

export class GeminiClient implements ProviderClient {
  async create(prompt: string, imageDataUri: string, apiKey: string): Promise<ProviderCreateResult> {
    const { mimeType, dataBase64 } = parseDataUri(imageDataUri);

    const payload = {
      batch: {
        display_name: "SABI",
        input_config: {
          requests: {
            requests: [
              {
                request: {
                  contents: [
                    {
                      parts: [
                        { text: prompt },
                        { inline_data: { mime_type: mimeType, data: dataBase64 } },
                      ],
                    },
                  ],
                  generation_config: {
                    response_modalities: ["TEXT", "IMAGE"],
                  },
                },
                metadata: { key: "variant" },
              },
            ],
          },
        },
      },
    };

    let lastErr: string | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const result = await doCreate(payload, apiKey);
        return result;
      } catch (err) {
        lastErr = (err as Error).message;
        if (attempt < MAX_ATTEMPTS && isRetryable(err)) {
          await sleep(Math.pow(2, attempt - 1) * 1000);
          continue;
        }
        throw err;
      }
    }

    throw new Error(`Gemini unavailable after ${MAX_ATTEMPTS} attempts: ${lastErr}`);
  }

  async poll(pollUrl: string, apiKey: string): Promise<ProviderPollResult> {
    const resp = await fetch(pollUrl, {
      headers: { "x-goog-api-key": apiKey },
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Gemini poll error (${resp.status}): ${body}`);
    }

    const parsed: Record<string, unknown> = await resp.json();
    const done = (parsed.done as boolean) || false;
    const state = findState(parsed);
    const error = findErrorMessage(parsed);

    const endsSuffix = (suffix: string) =>
      typeof state === "string" && state.endsWith(suffix);

    if (endsSuffix("FAILED") || endsSuffix("CANCELLED") || endsSuffix("EXPIRED") || (done && !!error)) {
      const msg = error || findText(parsed) || (state as string) || "Gemini batch job failed";
      return { type: "failed", error: msg };
    }

    if (done || endsSuffix("SUCCEEDED")) {
      const extracted = extractImage(parsed);
      if (!extracted) {
        const text = findText(parsed) || "no image in batch response";
        return { type: "failed", error: text };
      }
      return {
        type: "done",
        imageBytes: extracted.bytes,
        ext: extracted.ext,
      };
    }

    return { type: "pending" };
  }
}

async function doCreate(payload: unknown, apiKey: string): Promise<ProviderCreateResult> {
  const url = `${API_BASE}/models/${MODEL}:batchGenerateContent`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await resp.text();

  if (!resp.ok) {
    const msg = extractErrorMessage(body, resp.status);
    throw new Error(msg);
  }

  const parsed: Record<string, unknown> = JSON.parse(body);
  const name = parsed.name as string | undefined;

  if (!name) {
    throw new Error(`Batch job response had no operation name: ${body}`);
  }

  return {
    type: "pending",
    pollUrl: `${API_BASE}/${name}`,
  };
}

function extractErrorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body);
    const msg = findErrorMessage(parsed) || body;
    if (status === 429) return `Rate limited by Gemini (429): ${msg}`;
    return `Gemini API error (${status}): ${msg}`;
  } catch {
    return `Gemini API error (${status}): ${body}`;
  }
}

function isRetryable(err: unknown): boolean {
  const msg = (err as Error).message;
  if (msg.includes("502") || msg.includes("503") || msg.includes("504")) return true;
  if (msg.includes("Rate limited") && msg.includes("429")) return true;
  if (msg.includes("timeout") || msg.includes("Failed to reach")) return true;
  return false;
}

// ---- data URI parsing ----

function parseDataUri(uri: string): { mimeType: string; dataBase64: string } {
  const commaIdx = uri.indexOf(",");
  if (commaIdx === -1) throw new Error("Source image is not a data URI");
  const header = uri.substring(0, commaIdx);
  const dataBase64 = uri.substring(commaIdx + 1);
  const mimeType = header.replace("data:", "").split(";")[0] || "image/png";
  return { mimeType, dataBase64 };
}

// ---- JSON tree helpers ----

function findState(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = findState(item);
      if (s) return s;
    }
    return undefined;
  }
  const obj = v as Record<string, unknown>;
  if (typeof obj.state === "string") return obj.state;
  for (const val of Object.values(obj)) {
    const s = findState(val);
    if (s) return s;
  }
  return undefined;
}

function findErrorMessage(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = findErrorMessage(item);
      if (s) return s;
    }
    return undefined;
  }
  const obj = v as Record<string, unknown>;
  const err = obj.error as Record<string, unknown> | undefined;
  if (err && typeof err.message === "string") return err.message;
  for (const val of Object.values(obj)) {
    const s = findErrorMessage(val);
    if (s) return s;
  }
  return undefined;
}

function findText(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = findText(item);
      if (s) return s;
    }
    return undefined;
  }
  const obj = v as Record<string, unknown>;
  if (typeof obj.text === "string" && obj.text.length > 0) return obj.text;
  for (const val of Object.values(obj)) {
    const s = findText(val);
    if (s) return s;
  }
  return undefined;
}

function extractImage(v: unknown): { bytes: ArrayBuffer; ext: string } | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  if (Array.isArray(v)) {
    for (const item of v) {
      const result = extractImage(item);
      if (result) return result;
    }
    return undefined;
  }
  const obj = v as Record<string, unknown>;

  // Check for inline data at this level
  const inline =
    (obj.inline_data as Record<string, unknown>) ||
    (obj.inlineData as Record<string, unknown>);

  if (inline && typeof inline.data === "string") {
    const mimeType =
      (inline.mime_type as string) ||
      (inline.mimeType as string) ||
      "image/png";

    if (mimeType.startsWith("image/")) {
      const bytes = base64ToArrayBuffer(inline.data);
      const ext = extForMime(mimeType);
      return { bytes, ext };
    }
  }

  for (const val of Object.values(obj)) {
    const result = extractImage(val);
    if (result) return result;
  }

  return undefined;
}

function extForMime(mime: string): string {
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "png";
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
