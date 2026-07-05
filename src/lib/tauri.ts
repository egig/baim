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
  apiKey: string
): Promise<Generation> {
  return invoke<Generation>("create_prediction", {
    dataUri,
    prompt,
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
  status: "pending" | "succeeded" | "failed";
  poll_url: string | null;
  output_path: string | null;
  error: string | null;
  created_at: number;
}

export async function getGenerations(): Promise<Generation[]> {
  return invoke<Generation[]>("get_generations");
}

export async function saveImage(dataUri: string): Promise<ImageEntry> {
  return invoke<ImageEntry>("save_uploaded_image", { dataUri });
}
