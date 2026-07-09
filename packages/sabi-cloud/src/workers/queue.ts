import type { Env } from "../env";
import type { JobRepository } from "../domain/ports";
import { D1JobRepository } from "../infrastructure/d1/job-repository";
import { D1ApiKeyRepository } from "../infrastructure/d1/user-repository";
import { D1CreditLedgerRepository } from "../infrastructure/d1/credit-ledger-repository";
import { CreditService } from "../application/credit-service";
import { markJobFailed } from "../application/job-failure";
import { getProviderClient } from "../infrastructure/providers/provider-registry";

export async function handleQueue(batch: MessageBatch<{ jobId: string }>, env: Env): Promise<void> {
  const jobRepo: JobRepository = new D1JobRepository(env.DB);
  const creditService = new CreditService(new D1CreditLedgerRepository(env.DB), new D1ApiKeyRepository(env.DB));

  for (const msg of batch.messages) {
    const jobId = msg.body.jobId;
    try {
      const job = await jobRepo.findById(jobId);
      if (!job) {
        console.error(`Queue: job ${jobId} not found`);
        continue;
      }
      if (job.status !== "queued") {
        console.log(`Queue: job ${jobId} already processed (status=${job.status}), skipping`);
        continue;
      }

      if (!job.providerApiKey) {
        await markJobFailed(jobRepo, creditService, job, `No API key configured for ${job.provider}`);
        msg.retry({ delaySeconds: 10 });
        continue;
      }

      const client = getProviderClient(job.provider);
      let result;
      try {
        result = await client.create(job.prompt, job.sourceDataUri, job.providerApiKey);
      } catch (err) {
        // A rejected/invalid provider request is not transient — retrying via
        // the queue would just charge nothing further but leave the credit
        // stuck once Cloudflare's retry budget is exhausted (no dead-letter
        // queue is configured). Fail and refund immediately instead.
        await markJobFailed(jobRepo, creditService, job, `Provider error: ${String(err)}`);
        continue;
      }

      switch (result.type) {
        case "pending":
          job.status = "pending";
          job.pollUrl = result.pollUrl;
          await jobRepo.update(job);
          break;

        case "done":
          // Synchronous result (rare for Gemini, but supported)
          job.status = "pending";
          job.pollUrl = null;
          await jobRepo.update(job);
          // TODO: save image directly
          break;
      }
    } catch (err) {
      // Infra-level errors (D1 lookup, etc.) rather than provider rejections —
      // nothing was durably decided yet, so retrying at the queue level is safe.
      console.error(`Queue: error processing job ${jobId}:`, err);
      msg.retry({ delaySeconds: 30 });
    }
  }
}
