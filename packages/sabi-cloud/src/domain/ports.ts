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
  findById(id: string): Promise<ApiKey | null>;
  findByKeyHash(hash: string): Promise<ApiKey | null>;
}

export interface CreditLedgerRepository {
  /** Atomically decrements the key's balance by 1 iff balance > 0, recording
   *  a 'charge' ledger row on success. Returns false (no-op) if insufficient. */
  chargeOne(apiKeyId: string, jobId: string): Promise<boolean>;
  /** Idempotent: inserts a 'refund' row for (jobId, 'refund'); if that already
   *  exists, no-ops. Otherwise increments balance by 1 atomically with the insert. */
  refundOne(apiKeyId: string, jobId: string): Promise<void>;
  /** Records a 'grant' ledger row (job_id = null) and increments balance by `amount`. */
  grant(apiKeyId: string, amount: number): Promise<void>;
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
