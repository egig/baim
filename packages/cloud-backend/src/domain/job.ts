export type JobStatus = "queued" | "pending" | "succeeded" | "failed";

export interface Job {
  id: string;
  userId: string;
  prompt: string;
  provider: string;
  providerApiKey: string;
  status: JobStatus;
  pollUrl: string | null;
  outputPath: string | null;
  error: string | null;
  logs: string | null;
  sourceDataUri: string;
  createdAt: string;
}
