import { Hono } from "hono";
import type { Env } from "../env";
import { JobService } from "../application/job-service";
import { AuthService } from "../application/auth-service";
import { CreditService } from "../application/credit-service";
import { createChargedJob } from "../application/paid-job-orchestrator";
import { D1JobRepository } from "../infrastructure/d1/job-repository";
import { D1UserRepository, D1ApiKeyRepository } from "../infrastructure/d1/user-repository";
import { D1CreditLedgerRepository } from "../infrastructure/d1/credit-ledger-repository";
import { R2ImageStore } from "../infrastructure/r2/image-store";
import { allProviders } from "../infrastructure/providers/provider-registry";

function createServices(env: Env) {
  const jobRepo = new D1JobRepository(env.DB);
  const userRepo = new D1UserRepository(env.DB);
  const apiKeyRepo = new D1ApiKeyRepository(env.DB);
  const creditLedgerRepo = new D1CreditLedgerRepository(env.DB);
  const imageStore = new R2ImageStore(env.IMAGES);
  return {
    jobRepo,
    authService: new AuthService(userRepo, apiKeyRepo),
    jobService: new JobService(jobRepo, imageStore),
    creditService: new CreditService(creditLedgerRepo, apiKeyRepo),
  };
}

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  async function requireAuth(c: { env: Env; req: { header: (n: string) => string | undefined } }): Promise<{ userId: string; apiKeyId: string } | Response> {
    const { authService } = createServices(c.env);
    const auth = c.req.header("Authorization");
    const user = await authService.authenticate(auth);
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return user;
  }

  // POST /api/auth/register — create a new API key
  app.post("/api/auth/register", async (c) => {
    const { authService } = createServices(c.env);
    const result = await authService.register();
    return c.json(result, 201);
  });

  // POST /api/jobs — enqueue a new generation job
  app.post("/api/jobs", async (c) => {
    const authCheck = await requireAuth(c);
    if (authCheck instanceof Response) return authCheck;

    const body = await c.req.json<{
      prompt: string;
      sourceDataUri: string;
      provider: string;
      providerApiKey: string;
    }>();

    const { jobRepo, creditService } = createServices(c.env);
    const result = await createChargedJob(jobRepo, creditService, c.env.QUEUE, {
      userId: authCheck.userId,
      apiKeyId: authCheck.apiKeyId,
      prompt: body.prompt,
      sourceDataUri: body.sourceDataUri,
      provider: body.provider,
      providerApiKey: body.providerApiKey,
    });

    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }

    const { job } = result;
    return c.json({
      id: job.id,
      prompt: job.prompt,
      provider: job.provider,
      status: job.status,
      createdAt: job.createdAt,
    }, 201);
  });

  // GET /api/jobs/:id — poll job status
  app.get("/api/jobs/:id", async (c) => {
    const authCheck = await requireAuth(c);
    if (authCheck instanceof Response) return authCheck;

    const { jobService } = createServices(c.env);
    const job = await jobService.getById(c.req.param("id"));
    if (!job) {
      return c.json({ error: "Job not found" }, 404);
    }
    if (job.userId !== authCheck.userId) {
      return c.json({ error: "Forbidden" }, 403);
    }

    return c.json({
      id: job.id,
      prompt: job.prompt,
      provider: job.provider,
      status: job.status,
      error: job.error,
      outputPath: job.outputPath,
      createdAt: job.createdAt,
    });
  });

  // GET /api/jobs — list user's jobs
  app.get("/api/jobs", async (c) => {
    const authCheck = await requireAuth(c);
    if (authCheck instanceof Response) return authCheck;

    const { jobService } = createServices(c.env);
    const jobs = await jobService.listByUser(authCheck.userId);
    return c.json(jobs.map((j) => ({
      id: j.id,
      prompt: j.prompt,
      provider: j.provider,
      status: j.status,
      error: j.error,
      outputPath: j.outputPath,
      createdAt: j.createdAt,
    })));
  });

  // POST /api/jobs/:id/retry — retry a failed job (charged like any new job)
  app.post("/api/jobs/:id/retry", async (c) => {
    const authCheck = await requireAuth(c);
    if (authCheck instanceof Response) return authCheck;

    const { jobService, jobRepo, creditService } = createServices(c.env);
    const validation = await jobService.validateRetry(c.req.param("id"), authCheck.userId);
    if (!validation.ok) {
      const status = validation.reason === "not_found" ? 404 : validation.reason === "forbidden" ? 403 : 400;
      return c.json({ error: validation.reason }, status);
    }

    const existing = validation.job;
    const result = await createChargedJob(jobRepo, creditService, c.env.QUEUE, {
      userId: authCheck.userId,
      apiKeyId: authCheck.apiKeyId,
      prompt: existing.prompt,
      sourceDataUri: existing.sourceDataUri,
      provider: existing.provider,
      providerApiKey: existing.providerApiKey,
    });

    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }

    const { job } = result;
    return c.json({
      id: job.id,
      prompt: job.prompt,
      provider: job.provider,
      status: job.status,
      createdAt: job.createdAt,
    }, 201);
  });

  // GET /api/credit-keys/me — current key's remaining balance
  app.get("/api/credit-keys/me", async (c) => {
    const authCheck = await requireAuth(c);
    if (authCheck instanceof Response) return authCheck;

    const { creditService } = createServices(c.env);
    const creditBalance = await creditService.getBalance(authCheck.apiKeyId);
    return c.json({ creditBalance });
  });

  // GET /api/images/:key — download generated image
  app.get("/api/images/:key", async (c) => {
    const key = c.req.param("key");
    const object = await c.env.IMAGES.get(key);
    if (!object) {
      return c.json({ error: "Image not found" }, 404);
    }
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    return new Response(object.body, { headers });
  });

  // GET /api/models — list available providers
  app.get("/api/models", (c) => {
    return c.json(allProviders());
  });

  return app;
}
