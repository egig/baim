import type { Env } from "../env";
import type { Job } from "../domain/job";
import type { JobRepository } from "../domain/ports";
import { D1JobRepository } from "../infrastructure/d1/job-repository";
import { getProviderClient } from "../infrastructure/providers/provider-registry";

export async function handleQueue(batch: MessageBatch<{ jobId: string }>, env: Env): Promise<void> {
  const jobRepo: JobRepository = new D1JobRepository(env.DB);

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
        await failJob(jobRepo, job, `No API key configured for ${job.provider}`);
        msg.retry({ delaySeconds: 10 });
        continue;
      }

      const client = getProviderClient(job.provider);
      const result = await client.create(job.prompt, job.sourceDataUri, job.providerApiKey);

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
      console.error(`Queue: error processing job ${jobId}:`, err);
      msg.retry({ delaySeconds: 30 });
    }
  }
}

async function failJob(jobRepo: JobRepository, job: Job, error: string): Promise<void> {
  console.error(`Job ${job.id} failed: ${error}`);
  job.status = "failed";
  job.error = error;
  await jobRepo.update(job);
}
