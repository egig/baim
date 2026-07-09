import type { Job } from "../domain/job";
import type { JobRepository, ImageStore } from "../domain/ports";

export type RetryValidation =
  | { ok: true; job: Job }
  | { ok: false; reason: "not_found" | "forbidden" | "not_retryable" };

export class JobService {
  constructor(
    private jobs: JobRepository,
    private images: ImageStore
  ) {}

  async getById(id: string): Promise<Job | null> {
    return this.jobs.findById(id);
  }

  async listByUser(userId: string): Promise<Job[]> {
    return this.jobs.findByUserId(userId);
  }

  /** Validates that `id` is a failed job owned by `callerUserId`. Does not
   *  create anything — the caller retries via the same charged-job-creation
   *  path as any new job (see paid-job-orchestrator.ts). */
  async validateRetry(id: string, callerUserId: string): Promise<RetryValidation> {
    const existing = await this.jobs.findById(id);
    if (!existing) return { ok: false, reason: "not_found" };
    if (existing.userId !== callerUserId) return { ok: false, reason: "forbidden" };
    if (existing.status !== "failed") return { ok: false, reason: "not_retryable" };
    return { ok: true, job: existing };
  }
}
