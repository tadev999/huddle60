import { CloudTasksClient } from "@google-cloud/tasks";
import type { JobQueue, Logger, PlannerJob } from "../ports.js";

const ALREADY_EXISTS = 6;

export interface CloudTasksOptions {
  project: string;
  location: string;
  queue: string;
  workerUrl: string;
  taskToken: string;
}

/** Durable queue. Task names derive from the delivery id, so Cloud Tasks drops duplicates. */
export class CloudTasksQueue implements JobQueue {
  private readonly client = new CloudTasksClient();

  constructor(private readonly options: CloudTasksOptions) {}

  async enqueue(job: PlannerJob): Promise<void> {
    const parent = this.client.queuePath(
      this.options.project,
      this.options.location,
      this.options.queue,
    );
    const taskId = `${job.type}-${job.deliveryId}`.replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 500);
    try {
      await this.client.createTask({
        parent,
        task: {
          name: `${parent}/tasks/${taskId}`,
          httpRequest: {
            httpMethod: "POST",
            url: this.options.workerUrl,
            headers: {
              "Content-Type": "application/json",
              "X-AI-DLC-Task-Token": this.options.taskToken,
            },
            body: Buffer.from(JSON.stringify(job)).toString("base64"),
          },
        },
      });
    } catch (error) {
      if ((error as { code?: number }).code !== ALREADY_EXISTS) throw error;
    }
  }
}

/** Local development queue: runs jobs in-process after the webhook response. */
export class InlineQueue implements JobQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly run: (job: PlannerJob) => Promise<void>,
    private readonly logger: Logger,
  ) {}

  async enqueue(job: PlannerJob): Promise<void> {
    this.tail = this.tail
      .then(() => this.run(job))
      .catch((error: unknown) => this.logger.error("inline job failed", { error: String(error) }));
  }

  /** Resolves when all queued jobs have finished; used by tests. */
  async drain(): Promise<void> {
    await this.tail;
  }
}
