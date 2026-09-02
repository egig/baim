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

/** Which call strategy a generation uses, orthogonal to `provider`. `"batch"`
 *  is Google's existing async Batch API; `"interactions"` is the synchronous
 *  Interactions API, exposed only as a Bulk Panel toggle today. */
export type ApiMode = "batch" | "interactions";

/** Enqueue a single generation (status `queued`) referencing its source image by
 *  id. The queue drainer submits it to the provider later. `mode` defaults to
 *  `"batch"` so existing (single-image) call sites are unaffected. */
export async function createPrediction(
  prompt: string,
  provider: string,
  sourceId?: string,
  mode: ApiMode = "batch"
): Promise<Generation> {
  return invoke<Generation>("create_prediction", {
    prompt,
    provider,
    sourceId: sourceId ?? null,
    mode,
  });
}

/** Enqueue one generation per prompt in a single backend call, sharing one
 *  source image, provider and mode. Powers batch (template / bulk)
 *  generation. `mode` defaults to `"batch"` so existing call sites are
 *  unaffected. */
export async function createPredictions(
  prompts: string[],
  provider: string,
  sourceId?: string,
  mode: ApiMode = "batch"
): Promise<Generation[]> {
  return invoke<Generation[]>("create_predictions", {
    prompts,
    provider,
    sourceId: sourceId ?? null,
    mode,
  });
}

/** Result of a queue drain pass: the advanced records, plus whether any
 *  submission in the batch was rate-limited by its provider. `rate_limited`
 *  drives the AIMD engine's backoff (see queries.ts) — it is not a failure,
 *  rate-limited rows are reverted to `queued` server-side and retried later. */
export interface SubmitOutcome {
  generations: Generation[];
  rate_limited: boolean;
}

/** Drain the queue: submit up to `limit` of the oldest queued jobs to their
 *  provider, promoting them to `pending`. Called each poll tick with the number
 *  of free in-flight slots so concurrency stays capped. */
export async function submitQueued(limit: number): Promise<SubmitOutcome> {
  return invoke<SubmitOutcome>("submit_queued", { limit });
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

/** Delete multiple images at once (bulk-select "Delete"). Best-effort on the
 *  backend: a failure on one path doesn't stop the rest from being deleted. */
export async function deleteImages(paths: string[]): Promise<void> {
  return invoke<void>("delete_images", { paths });
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
  /** Which call strategy produced (or will produce) this row. Defaults to
   *  `"batch"` for legacy rows. */
  api_mode: ApiMode;
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

/** The user-configured ceiling for adaptive generation concurrency (defaults
 *  to 10 when unset). The AIMD engine in queries.ts ramps `k` up toward this
 *  and never past it. */
export async function getMaxConcurrency(): Promise<number> {
  return invoke<number>("get_max_concurrency");
}

/** Persist the concurrency ceiling (clamped 1-100 on both ends). */
export async function setMaxConcurrency(value: number): Promise<void> {
  return invoke<void>("set_max_concurrency", { value });
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

/** A user-picked folder holding its own images/generations catalog. Display
 *  `name` is always the live folder basename, never a stored/editable name. */
export interface WorkspaceInfo {
  path: string;
  name: string;
  last_opened_at: number;
}

/** Known workspaces, most-recently-opened first. */
export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  return invoke<WorkspaceInfo[]>("list_workspaces");
}

/** The currently active workspace. */
export async function getActiveWorkspace(): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("get_active_workspace");
}

/** Open (or switch to) a workspace folder, creating its catalog the first
 *  time it's opened. */
export async function openWorkspace(path: string): Promise<WorkspaceInfo> {
  return invoke<WorkspaceInfo>("open_workspace", { path });
}

/** Remove a workspace from the recents list. Does not touch any files. */
export async function forgetWorkspace(path: string): Promise<void> {
  return invoke<void>("forget_workspace", { path });
}

/** A user-saved prompt template: a reusable name + prompt, with a preview
 *  image copied into app-wide storage so it survives its source workspace
 *  being moved/renamed/deleted. */
export interface Template {
  id: string;
  name: string;
  prompt: string;
  preview_path: string;
  created_at: number;
}

/** User-saved prompt templates, most-recently-created first. */
export async function listTemplates(): Promise<Template[]> {
  return invoke<Template[]>("list_templates");
}

/** Save a prompt as a reusable template, copying `sourceImagePath`'s image in
 *  as its preview. */
export async function saveTemplate(
  name: string,
  prompt: string,
  sourceImagePath: string
): Promise<Template> {
  return invoke<Template>("save_template", {
    name,
    prompt,
    sourceImagePath,
  });
}

/** Create a template from scratch (Templat page "Tambah templat"): a name +
 *  prompt, with an optional preview image as a client-normalized PNG data URI.
 *  With no preview, the card falls back to a placeholder icon. */
export async function createTemplate(
  name: string,
  prompt: string,
  previewDataUri?: string
): Promise<Template> {
  return invoke<Template>("create_template", {
    name,
    prompt,
    previewDataUri: previewDataUri ?? null,
  });
}

/** Edit an existing template's name and prompt, and — when `previewDataUri` is
 *  given — replace its preview image (the old preview file is removed). */
export async function updateTemplate(
  id: string,
  name: string,
  prompt: string,
  previewDataUri?: string
): Promise<void> {
  return invoke<void>("update_template", {
    id,
    name,
    prompt,
    previewDataUri: previewDataUri ?? null,
  });
}

/** Delete a saved template and its preview file. */
export async function deleteTemplate(id: string): Promise<void> {
  return invoke<void>("delete_template", { id });
}

/** Rename an existing saved template. */
export async function renameTemplate(id: string, name: string): Promise<void> {
  return invoke<void>("rename_template", { id, name });
}
