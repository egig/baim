import type { Env } from "./env";
import { createApp } from "./workers/api";
import { handleCron } from "./workers/cron";
import { handleQueue } from "./workers/queue";

const app = createApp();

export default {
  fetch: app.fetch,

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleCron(env);
  },

  async queue(batch: MessageBatch<{ jobId: string }>, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleQueue(batch, env);
  },
};
