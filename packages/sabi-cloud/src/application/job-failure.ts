import type { Job } from "../domain/job";
import type { JobRepository } from "../domain/ports";
import type { CreditService } from "./credit-service";

export async function markJobFailed(
  jobs: JobRepository,
  credits: CreditService,
  job: Job,
  error: string
): Promise<void> {
  job.status = "failed";
  job.error = error;
  job.pollUrl = null;
  await jobs.update(job);
  await credits.refund(job.apiKeyId, job.id);
}
