import { invoke } from "@tauri-apps/api/core";

export interface ImageEntry {
  path: string;
  filename: string;
  created_at: number;
  size_bytes: number;
}

export async function generateImage(
  dataUri: string,
  prompt: string,
  apiKey: string
): Promise<string> {
  return invoke<string>("generate_image", {
    dataUri,
    prompt,
    apiKey,
  });
}

export async function getImages(): Promise<ImageEntry[]> {
  return invoke<ImageEntry[]>("get_images");
}
