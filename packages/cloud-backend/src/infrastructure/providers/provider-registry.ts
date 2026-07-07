import type { ProviderClient } from "../../domain/ports";
import { GeminiClient } from "./gemini";

export interface ProviderInfo {
  id: string;
  label: string;
  keyHint: string;
  keyUrl: string;
}

export function allProviders(): ProviderInfo[] {
  return [
    {
      id: "google",
      label: "Google",
      keyHint: "AIza...",
      keyUrl: "https://aistudio.google.com/apikey",
    },
  ];
}

export function getProviderClient(id: string): ProviderClient {
  switch (id) {
    case "google":
      return new GeminiClient();
    default:
      throw new Error(`Unknown provider: ${id}`);
  }
}
