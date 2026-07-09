import type { Env } from "../env";
import type { JobRepository, ImageStore } from "../domain/ports";
import { D1JobRepository } from "../infrastructure/d1/job-repository";
import { R2ImageStore } from "../infrastructure/r2/image-store";
import { D1ApiKeyRepository } from "../infrastructure/d1/user-repository";
import { D1CreditLedgerRepository } from "../infrastructure/d1/credit-ledger-repository";
import { CreditService } from "../application/credit-service";
import { markJobFailed } from "../application/job-failure";
import { getProviderClient } from "../infrastructure/providers/provider-registry";

export async function handleCron(env: Env): Promise<void> {
  const jobRepo: JobRepository = new D1JobRepository(env.DB);
  const imageStore: ImageStore = new R2ImageStore(env.IMAGES);
  const creditService = new CreditService(new D1CreditLedgerRepository(env.DB), new D1ApiKeyRepository(env.DB));
  const pending = await jobRepo.findPending();

  for (const job of pending) {
    try {
      if (!job.pollUrl) {
        await markJobFailed(jobRepo, creditService, job, "Pending job has no poll URL");
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
          await markJobFailed(jobRepo, creditService, job, result.error);
          break;
      }
    } catch (err) {
      console.error(`Cron: error polling job ${job.id}:`, err);
    }
  }
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
