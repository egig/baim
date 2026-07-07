import type { Job } from "../domain/job";
import type { JobRepository, ImageStore } from "../domain/ports";
import { getProviderClient } from "../infrastructure/providers/provider-registry";

export interface CreateJobInput {
  userId: string;
  prompt: string;
  sourceDataUri: string;
  provider: string;
  providerApiKey: string;
}

export class JobService {
  constructor(
    private jobs: JobRepository,
    private images: ImageStore
  ) {}

  async create(input: CreateJobInput): Promise<Job> {
    const job: Job = {
      id: crypto.randomUUID(),
      userId: input.userId,
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

    await this.jobs.create(job);
    return job;
  }

  async getById(id: string): Promise<Job | null> {
    return this.jobs.findById(id);
  }

  async listByUser(userId: string): Promise<Job[]> {
    return this.jobs.findByUserId(userId);
  }

  async retry(id: string): Promise<Job | null> {
    const existing = await this.jobs.findById(id);
    if (!existing || existing.status !== "failed") return null;

    const newJob: Job = {
      id: crypto.randomUUID(),
      userId: existing.userId,
      prompt: existing.prompt,
      provider: existing.provider,
      providerApiKey: existing.providerApiKey,
      status: "queued",
      pollUrl: null,
      outputPath: null,
      error: null,
      logs: null,
      sourceDataUri: existing.sourceDataUri,
      createdAt: new Date().toISOString(),
    };

    await this.jobs.create(newJob);
    return newJob;
  }
}
