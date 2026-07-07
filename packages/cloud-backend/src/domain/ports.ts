import type { Job } from "./job";
import type { User, ApiKey } from "./user";

export interface JobRepository {
  create(job: Job): Promise<void>;
  findById(id: string): Promise<Job | null>;
  findQueued(limit: number): Promise<Job[]>;
  findPending(): Promise<Job[]>;
  findByUserId(userId: string): Promise<Job[]>;
  update(job: Job): Promise<void>;
}

export interface UserRepository {
  create(user: User): Promise<void>;
  findById(id: string): Promise<User | null>;
}

export interface ApiKeyRepository {
  create(key: ApiKey): Promise<void>;
  findByKeyHash(hash: string): Promise<ApiKey | null>;
}

export interface ImageStore {
  upload(key: string, data: ArrayBuffer, contentType: string): Promise<string>;
  getDownloadUrl(key: string): string;
}

export type ProviderCreateResult =
  | { type: "pending"; pollUrl: string }
  | { type: "done"; imageBytes: ArrayBuffer; ext: string };

export type ProviderPollResult =
  | { type: "pending" }
  | { type: "done"; imageBytes: ArrayBuffer; ext: string }
  | { type: "failed"; error: string };

export interface ProviderClient {
  create(prompt: string, imageDataUri: string, apiKey: string): Promise<ProviderCreateResult>;
  poll(pollUrl: string, apiKey: string): Promise<ProviderPollResult>;
}
