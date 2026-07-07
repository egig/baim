import type { Job } from "../../domain/job";
import type { JobRepository } from "../../domain/ports";

export class D1JobRepository implements JobRepository {
  constructor(private db: D1Database) {}

  async create(job: Job): Promise<void> {
    const { id, userId, prompt, provider, providerApiKey, status, pollUrl, outputPath, error, logs, sourceDataUri, createdAt } = job;
    await this.db
      .prepare(
        `INSERT INTO jobs (id, user_id, prompt, provider, provider_api_key, status, poll_url, output_path, error, logs, source_data_uri, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, userId, prompt, provider, providerApiKey, status, pollUrl, outputPath, error, logs, sourceDataUri, createdAt)
      .run();
  }

  async findById(id: string): Promise<Job | null> {
    const row = await this.db
      .prepare(
        `SELECT id, user_id, prompt, provider, provider_api_key, status, poll_url, output_path, error, logs, source_data_uri, created_at
         FROM jobs WHERE id = ?`
      )
      .bind(id)
      .first();
    if (!row) return null;
    return rowToJob(row);
  }

  async findQueued(limit: number): Promise<Job[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, user_id, prompt, provider, provider_api_key, status, poll_url, output_path, error, logs, source_data_uri, created_at
         FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?`
      )
      .bind(limit)
      .all();
    return results.map(rowToJob);
  }

  async findPending(): Promise<Job[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, user_id, prompt, provider, provider_api_key, status, poll_url, output_path, error, logs, source_data_uri, created_at
         FROM jobs WHERE status = 'pending'`
      )
      .all();
    return results.map(rowToJob);
  }

  async findByUserId(userId: string): Promise<Job[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, user_id, prompt, provider, provider_api_key, status, poll_url, output_path, error, logs, source_data_uri, created_at
         FROM jobs WHERE user_id = ? ORDER BY created_at DESC`
      )
      .bind(userId)
      .all();
    return results.map(rowToJob);
  }

  async update(job: Job): Promise<void> {
    const { id, status, pollUrl, outputPath, error, logs } = job;
    await this.db
      .prepare(
        `UPDATE jobs SET status = ?, poll_url = ?, output_path = ?, error = ?, logs = ?
         WHERE id = ?`
      )
      .bind(status, pollUrl, outputPath, error, logs, id)
      .run();
  }
}

function rowToJob(row: unknown): Job {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string,
    userId: r.user_id as string,
    prompt: r.prompt as string,
    provider: r.provider as string,
    providerApiKey: r.provider_api_key as string,
    status: r.status as Job["status"],
    pollUrl: (r.poll_url as string | null) ?? null,
    outputPath: (r.output_path as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    logs: (r.logs as string | null) ?? null,
    sourceDataUri: r.source_data_uri as string,
    createdAt: r.created_at as string,
  };
}
