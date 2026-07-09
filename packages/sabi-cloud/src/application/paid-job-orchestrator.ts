import type { Job } from "../domain/job";
import type { JobRepository } from "../domain/ports";
import type { CreditService } from "./credit-service";
import { markJobFailed } from "./job-failure";

export interface ChargedJobInput {
  userId: string;
  apiKeyId: string;
  prompt: string;
  provider: string;
  providerApiKey: string;
  sourceDataUri: string;
}

export type PaidJobResult =
  | { ok: true; job: Job }
  | { ok: false; status: 402; error: "insufficient_credits" }
  | { ok: false; status: 502; error: string };

/**
 * Charge -> create job row -> enqueue -> compensating refund on enqueue failure.
 * Cloudflare Queues have no dequeue/cancel, so the charge must happen before
 * enqueueing; if the enqueue itself throws, the job is marked failed and the
 * same idempotent refund path (markJobFailed) reverses the charge.
 * Shared by job creation and retry so this sequencing exists exactly once.
 */
export async function createChargedJob(
  jobs: JobRepository,
  credits: CreditService,
  queue: Queue<{ jobId: string }>,
  input: ChargedJobInput
): Promise<PaidJobResult> {
  const id = crypto.randomUUID();

  const charged = await credits.charge(input.apiKeyId, id);
  if (!charged) {
    return { ok: false, status: 402, error: "insufficient_credits" };
  }

  const job: Job = {
    id,
    userId: input.userId,
    apiKeyId: input.apiKeyId,
    prompt: input.prompt,
    provider: input.provider,
    providerApiKey: input.providerApiKey,
    status: "queued",
    pollUrl: null,
    outputPath: null,
    error: null,
    logs: null,
    sourceDataUri: input.sourceDataUri,
    createdAt: new Date().toISOString(),
  };
  await jobs.create(job);

  try {
    await queue.send({ jobId: id });
  } catch (err) {
    await markJobFailed(jobs, credits, job, `Failed to enqueue: ${String(err)}`);
    return { ok: false, status: 502, error: "Failed to enqueue job" };
  }

  return { ok: true, job };
}
