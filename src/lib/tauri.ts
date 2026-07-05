import { invoke } from "@tauri-apps/api/core";

export interface ImageEntry {
  path: string;
  filename: string;
  created_at: number;
  size_bytes: number;
}

export async function createPrediction(
  dataUri: string,
  prompt: string,
  provider: string,
  apiKey: string
): Promise<Generation> {
  return invoke<Generation>("create_prediction", {
    dataUri,
    prompt,
    provider,
    apiKey,
  });
}

export async function refreshGeneration(
  id: string,
  apiKey: string
): Promise<Generation> {
  return invoke<Generation>("refresh_generation", { id, apiKey });
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
  status: "pending" | "succeeded" | "failed";
  poll_url: string | null;
  output_path: string | null;
  error: string | null;
  created_at: number;
}

export async function getGenerations(): Promise<Generation[]> {
  return invoke<Generation[]>("get_generations");
}

/** Describes an available image provider, driving the settings UI. */
export interface ProviderInfo {
  id: string;
  label: string;
  /** Placeholder for the API-key input (e.g. Replicate's `r8_...`). */
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

/** localStorage key holding a given provider's API key. `replicate` keeps its
 *  historical `replicate_api_key` value so existing keys need no migration. */
export function apiKeyStorageKey(providerId: string): string {
  return `${providerId}_api_key`;
}

export async function saveImage(dataUri: string): Promise<ImageEntry> {
  return invoke<ImageEntry>("save_uploaded_image", { dataUri });
}

export async function getStorageDir(): Promise<string> {
  return invoke<string>("get_storage_dir");
}

export async function setStorageDir(path: string): Promise<string> {
  return invoke<string>("set_storage_dir", { path });
}
