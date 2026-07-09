export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  QUEUE: Queue<{ jobId: string }>;
}
