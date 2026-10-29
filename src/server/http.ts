import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  COMMAND_PREFIX,
  COMMAND_SPECS,
  looksLikeCommand,
  type CommandName,
} from "../core/command.js";
import { LABELS } from "../core/vocabulary.js";
import type { JobQueue, Logger, PlanStore, PlannerJob } from "../ports.js";

const MAX_BODY_BYTES = 1_000_000;

export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

interface Payload {
  action?: string;
  installation?: { id: number };
  repository?: { name: string; owner: { login: string } };
  issue?: { number: number; labels?: Array<{ name: string }>; pull_request?: unknown };
  label?: { name: string };
  comment?: { id: number; body?: string; user?: { type?: string } };
  sender?: { type?: string };
}

function plannerCommandName(body: string): CommandName | null {
  if (!looksLikeCommand(body)) return null;
  const name = body.trimStart().slice(COMMAND_PREFIX.length).trim().split(/\s+/u)[0] ?? "";
  if (!(name in COMMAND_SPECS)) return null;
  return COMMAND_SPECS[name as CommandName].handler === "planner" ? (name as CommandName) : null;
}

/** Maps a verified GitHub webhook to a planner job, or null when the event is not ours. */
export function toPlannerJob(
  event: string,
  deliveryId: string,
  payload: Payload,
): PlannerJob | null {
  const { installation, repository, issue } = payload;
  if (!installation || !repository || !issue || issue.pull_request) return null;
  if (payload.sender?.type === "Bot") return null;
  const base = {
    deliveryId,
    installationId: installation.id,
    owner: repository.owner.login,
    repo: repository.name,
    issueNumber: issue.number,
  };
  const isRequest = (issue.labels ?? []).some((label) => label.name === LABELS.request);
  if (event === "issues") {
    if (payload.action === "opened" && isRequest) return { type: "request", ...base };
    if (payload.action === "labeled" && payload.label?.name === LABELS.request)
      return { type: "request", ...base };
    if (payload.action === "edited" && isRequest) return { type: "request-edited", ...base };
    return null;
  }
  if (event === "issue_comment" && payload.action === "created" && payload.comment) {
    if (payload.comment.user?.type !== "User") return null;
    if (!plannerCommandName(payload.comment.body ?? "")) return null;
    return { type: "command", ...base, commentId: payload.comment.id };
  }
  return null;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Payload too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

export interface HttpAppDeps {
  webhookSecret: string;
  taskToken?: string;
  store: PlanStore;
  queue: JobQueue;
  runJob: (job: PlannerJob) => Promise<void>;
  logger: Logger;
}

export function createRequestHandler(deps: HttpAppDeps) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/healthz")
        return send(response, 200, { ok: true });
      if (request.method === "POST" && url.pathname === "/webhook")
        return await handleWebhook(deps, request, response);
      if (request.method === "POST" && url.pathname === "/tasks/planner")
        return await handleTask(deps, request, response);
      return send(response, 404, { error: "not found" });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      deps.logger.error("request failed", { path: url.pathname, status, error: String(error) });
      if (!response.headersSent)
        send(response, status, {
          error: status === 500 ? "internal error" : String((error as Error).message),
        });
    }
  };
}

async function handleWebhook(
  deps: HttpAppDeps,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  if (
    !verifySignature(
      deps.webhookSecret,
      body,
      request.headers["x-hub-signature-256"] as string | undefined,
    )
  ) {
    return send(response, 401, { error: "invalid signature" });
  }
  const event = String(request.headers["x-github-event"] ?? "");
  const deliveryId = String(request.headers["x-github-delivery"] ?? "");
  if (!deliveryId) return send(response, 400, { error: "missing delivery id" });
  if (event === "ping") return send(response, 200, { ok: true });
  const job = toPlannerJob(event, deliveryId, JSON.parse(body.toString("utf8")) as Payload);
  if (!job) return send(response, 202, { ignored: true });
  if (!(await deps.store.claimDelivery(deliveryId)))
    return send(response, 200, { duplicate: true });
  try {
    await deps.queue.enqueue(job);
  } catch (error) {
    await deps.store.releaseDelivery(deliveryId);
    throw error;
  }
  deps.logger.info("job queued", { type: job.type, deliveryId, issue: job.issueNumber });
  return send(response, 202, { queued: job.type });
}

async function handleTask(
  deps: HttpAppDeps,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const token = request.headers["x-ai-dlc-task-token"];
  if (!deps.taskToken || typeof token !== "string" || !safeEqual(token, deps.taskToken)) {
    return send(response, 401, { error: "unauthorized" });
  }
  const job = JSON.parse((await readBody(request)).toString("utf8")) as PlannerJob;
  // Unexpected errors propagate as 500 so that Cloud Tasks retries the job.
  await deps.runJob(job);
  return send(response, 200, { done: true });
}
