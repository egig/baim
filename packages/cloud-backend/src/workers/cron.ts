import type { Env } from "../env";
import type { Job } from "../domain/job";
import type { JobRepository, ImageStore } from "../domain/ports";
import { D1JobRepository } from "../infrastructure/d1/job-repository";
import { R2ImageStore } from "../infrastructure/r2/image-store";
import { getProviderClient } from "../infrastructure/providers/provider-registry";

export async function handleCron(env: Env): Promise<void> {
  const jobRepo: JobRepository = new D1JobRepository(env.DB);
  const imageStore: ImageStore = new R2ImageStore(env.IMAGES);
  const pending = await jobRepo.findPending();

  for (const job of pending) {
    try {
      if (!job.pollUrl) {
        await failJob(jobRepo, job, "Pending job has no poll URL");
        continue;
      }

      const client = getProviderClient(job.provider);
      const result = await client.poll(job.pollUrl, "");

      switch (result.type) {
        case "pending":
          break;

        case "done": {
          const ext = result.ext;
          const key = `${job.id}.${ext}`;
          const contentType = mimeForExt(ext);
          await imageStore.upload(key, result.imageBytes, contentType);

          job.status = "succeeded";
          job.outputPath = key;
          job.pollUrl = null;
          await jobRepo.update(job);
          break;
        }

        case "failed":
          await failJob(jobRepo, job, result.error);
          break;
      }
    } catch (err) {
      console.error(`Cron: error polling job ${job.id}:`, err);
    }
  }
}

async function failJob(jobRepo: JobRepository, job: Job, error: string): Promise<void> {
  console.error(`Job ${job.id} failed: ${error}`);
  job.status = "failed";
  job.error = error;
  job.pollUrl = null;
  await jobRepo.update(job);
}

function mimeForExt(ext: string): string {
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "png":
    default:
      return "image/png";
  }
}
