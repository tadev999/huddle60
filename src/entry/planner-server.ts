import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Firestore } from "@google-cloud/firestore";
import { GeminiModel } from "../adapters/gemini.js";
import { connectRepository, octokitForInstallation } from "../adapters/github.js";
import { MemoryPlanStore, createJsonLogger } from "../adapters/memory.js";
import { FirestorePlanStore } from "../adapters/firestore.js";
import { CloudTasksQueue, InlineQueue } from "../adapters/queue.js";
import { loadServerConfig } from "../config.js";
import { PlannerService } from "../planner/service.js";
import { systemClock, type JobQueue, type PlanStore, type PlannerJob } from "../ports.js";
import { createRequestHandler } from "../server/http.js";

const config = loadServerConfig();
const logger = createJsonLogger({ service: "ai-dlc-planner", revision: config.K_REVISION });
const store: PlanStore =
  config.AI_DLC_STORE === "firestore"
    ? new FirestorePlanStore(new Firestore())
    : new MemoryPlanStore();
const model = new GeminiModel({
  apiKey: config.GEMINI_API_KEY,
  model: config.AI_DLC_MODEL,
  timeoutMs: config.AI_DLC_MODEL_TIMEOUT_MS,
  maxRetries: 2,
});
const leaseOwner = `${config.K_REVISION ?? "local"}-${randomUUID()}`;

async function runJob(job: PlannerJob): Promise<void> {
  const octokit = octokitForInstallation(
    config.GITHUB_APP_ID,
    config.GITHUB_APP_PRIVATE_KEY,
    job.installationId,
  );
  const github = await connectRepository(octokit, job.owner, job.repo);
  const planner = new PlannerService({
    github,
    model,
    store,
    clock: systemClock,
    logger,
    options: {
      enabled: config.AI_DLC_PLANNER_ENABLED,
      maxRevisions: config.AI_DLC_MAX_REVISIONS,
      leaseOwner,
    },
  });
  await planner.handle(job);
}

const queue: JobQueue =
  config.AI_DLC_QUEUE === "cloud-tasks"
    ? new CloudTasksQueue({
        project: config.GCP_PROJECT as string,
        location: config.GCP_LOCATION as string,
        queue: config.CLOUD_TASKS_QUEUE as string,
        workerUrl: config.AI_DLC_WORKER_URL as string,
        taskToken: config.AI_DLC_TASK_TOKEN as string,
      })
    : new InlineQueue(runJob, logger);

if (config.AI_DLC_STORE === "memory") {
  logger.warn(
    "using in-memory store: plans are lost on restart; use AI_DLC_STORE=firestore in production",
  );
}

const server = createServer(
  createRequestHandler({
    webhookSecret: config.GITHUB_WEBHOOK_SECRET,
    ...(config.AI_DLC_TASK_TOKEN ? { taskToken: config.AI_DLC_TASK_TOKEN } : {}),
    store,
    queue,
    runJob,
    logger,
  }),
);

server.listen(config.PORT, () =>
  logger.info("planner listening", {
    port: config.PORT,
    queue: config.AI_DLC_QUEUE,
    store: config.AI_DLC_STORE,
  }),
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logger.info("shutting down", { signal });
    server.close(() => process.exit(0));
  });
}
