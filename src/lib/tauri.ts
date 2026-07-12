import { invoke } from "@tauri-apps/api/core";

export interface ImageEntry {
  path: string;
  /** Stable id used to link generations back to this image as their source. */
  id: string;
  filename: string;
  /** Human-readable name for search/display (original upload name), distinct
   *  from the on-disk uuid `filename`. `null` on pre-title rows — fall back to
   *  `filename`. */
  title: string | null;
  created_at: number;
  size_bytes: number;
}

/** Enqueue a single generation (status `queued`) referencing its source image by
 *  id. The queue drainer submits it to the provider later. */
export async function createPrediction(
  prompt: string,
  provider: string,
  sourceId?: string
): Promise<Generation> {
  return invoke<Generation>("create_prediction", {
    prompt,
    provider,
    sourceId: sourceId ?? null,
  });
}

/** Enqueue one generation per prompt in a single backend call, sharing one
 *  source image and provider. Powers batch (template / bulk) generation. */
export async function createPredictions(
  prompts: string[],
  provider: string,
  sourceId?: string
): Promise<Generation[]> {
  return invoke<Generation[]>("create_predictions", {
    prompts,
    provider,
    sourceId: sourceId ?? null,
  });
}

/** Drain the queue: submit up to `limit` of the oldest queued jobs to their
 *  provider, promoting them to `pending`. Called each poll tick with the number
 *  of free in-flight slots so concurrency stays capped. */
export async function submitQueued(limit: number): Promise<Generation[]> {
  return invoke<Generation[]>("submit_queued", { limit });
}

/** Drop every queued job ("Clear queue"). In-flight jobs finish. */
export async function clearQueue(): Promise<void> {
  return invoke<void>("clear_queue");
}

/** Re-enqueue an existing generation (Retry) as a fresh queued job. */
export async function requeueGeneration(id: string): Promise<Generation> {
  return invoke<Generation>("requeue_generation", { id });
}

export async function refreshGeneration(id: string): Promise<Generation> {
  return invoke<Generation>("refresh_generation", { id });
}

export async function getImages(): Promise<ImageEntry[]> {
  return invoke<ImageEntry[]>("get_images");
}

export async function deleteImage(path: string): Promise<void> {
  return invoke<void>("delete_image", { path });
}

export interface Generation {
  id: string;
  prompt: string;
  input_data_uri: string;
  provider: string;
  status: "queued" | "pending" | "succeeded" | "failed";
  poll_url: string | null;
  output_path: string | null;
  error: string | null;
  /** The id of the image this was generated from, or null for legacy rows. */
  source_id: string | null;
  /** The provider's latest log blob, refreshed on every poll. Google's Batch
   *  API has none (null). Null for legacy/queued rows. */
  logs: string | null;
  created_at: number;
}

export async function getGenerations(): Promise<Generation[]> {
  return invoke<Generation[]>("get_generations");
}

/** Describes an available image provider, driving the settings UI. */
export interface ProviderInfo {
  id: string;
  label: string;
  /** Placeholder for the API-key input (e.g. Google's `AIza...`). */
  key_hint: string;
  /** Where to obtain a key for this provider. */
  key_url: string;
}

export async function listProviders(): Promise<ProviderInfo[]> {
  return invoke<ProviderInfo[]>("list_providers");
}

export async function getActiveProvider(): Promise<string> {
  return invoke<string>("get_active_provider");
}

export async function setActiveProvider(id: string): Promise<void> {
  return invoke<void>("set_active_provider", { id });
}

/** Whether the given provider has an API key saved in the backend. The key
 *  value itself never leaves the backend. */
export async function hasApiKey(providerId: string): Promise<boolean> {
  return invoke<boolean>("has_api_key", { provider: providerId });
}

/** Persist (or, with an empty string, clear) a provider's API key. */
export async function setApiKey(
  providerId: string,
  key: string
): Promise<void> {
  return invoke<void>("set_api_key", { provider: providerId, key });
}

/** Save an uploaded image. `title` is the original picked file name, kept for
 *  search/display (the on-disk name is a collision-free uuid). */
export async function saveImage(
  dataUri: string,
  title?: string
): Promise<ImageEntry> {
  return invoke<ImageEntry>("save_uploaded_image", {
    dataUri,
    title: title ?? null,
  });
}

/** The remaining credit balance on the configured Recraftory API key. */
export async function getRecraftoryCreditBalance(): Promise<number> {
  return invoke<number>("get_recraftory_credit_balance");
}

/** The configured Recraftory backend endpoint URL, or `null` if unset. */
export async function getRecraftoryEndpoint(): Promise<string | null> {
  return invoke<string | null>("get_recraftory_endpoint");
}

/** Persist the Recraftory backend endpoint URL. */
export async function setRecraftoryEndpoint(endpoint: string): Promise<void> {
  return invoke<void>("set_recraftory_endpoint", { endpoint });
}

export async function getStorageDir(): Promise<string> {
  return invoke<string>("get_storage_dir");
}

export async function setStorageDir(path: string): Promise<string> {
  return invoke<string>("set_storage_dir", { path });
}
