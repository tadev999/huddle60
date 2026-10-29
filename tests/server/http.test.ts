import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryPlanStore, silentLogger } from "../../src/adapters/memory.js";
import type { PlannerJob } from "../../src/ports.js";
import { createRequestHandler, toPlannerJob, verifySignature } from "../../src/server/http.js";

const SECRET = "test-webhook-secret-123";
const TASK_TOKEN = "t".repeat(40);

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

const base = {
  installation: { id: 7 },
  repository: { name: "shop", owner: { login: "acme" } },
  sender: { type: "User" },
};

const requestOpened = {
  ...base,
  action: "opened",
  issue: { number: 5, labels: [{ name: "ai-dlc:request" }] },
};

describe("toPlannerJob", () => {
  it("routes request Issues, edits and planner commands", () => {
    expect(toPlannerJob("issues", "d1", requestOpened)?.type).toBe("request");
    expect(toPlannerJob("issues", "d2", { ...requestOpened, action: "edited" })?.type).toBe(
      "request-edited",
    );
    expect(
      toPlannerJob("issues", "d3", {
        ...base,
        action: "labeled",
        label: { name: "ai-dlc:request" },
        issue: { number: 5 },
      })?.type,
    ).toBe("request");
    const comment = {
      ...base,
      action: "created",
      issue: { number: 5 },
      comment: { id: 9, body: "/ai-dlc create-plan plan=p hash=h", user: { type: "User" } },
    };
    expect(toPlannerJob("issue_comment", "d4", comment)).toMatchObject({
      type: "command",
      commentId: 9,
    });
  });

  it("ignores bots, PRs, deterministic commands and unrelated Issues", () => {
    expect(toPlannerJob("issues", "x", { ...requestOpened, sender: { type: "Bot" } })).toBeNull();
    expect(
      toPlannerJob("issues", "x", {
        ...requestOpened,
        issue: { ...requestOpened.issue, pull_request: {} },
      }),
    ).toBeNull();
    expect(
      toPlannerJob("issues", "x", { ...base, action: "opened", issue: { number: 5, labels: [] } }),
    ).toBeNull();
    const deterministic = {
      ...base,
      action: "created",
      issue: { number: 5 },
      comment: { id: 9, body: "/ai-dlc approve baseline=b hash=h", user: { type: "User" } },
    };
    expect(toPlannerJob("issue_comment", "x", deterministic)).toBeNull();
  });
});

describe("verifySignature", () => {
  it("accepts the right signature and rejects others", () => {
    const body = Buffer.from('{"a":1}');
    expect(verifySignature(SECRET, body, sign('{"a":1}'))).toBe(true);
    expect(verifySignature(SECRET, body, sign('{"a":2}'))).toBe(false);
    expect(verifySignature(SECRET, body, undefined)).toBe(false);
    expect(verifySignature(SECRET, body, "sha1=abc")).toBe(false);
  });
});

describe("HTTP server", () => {
  let server: Server;
  let url: string;
  let queued: PlannerJob[];
  let ran: PlannerJob[];
  let store: MemoryPlanStore;
  let failQueue: boolean;

  beforeEach(async () => {
    queued = [];
    ran = [];
    failQueue = false;
    store = new MemoryPlanStore();
    server = createServer(
      createRequestHandler({
        webhookSecret: SECRET,
        taskToken: TASK_TOKEN,
        store,
        queue: {
          enqueue: async (job) => {
            if (failQueue) throw new Error("queue down");
            queued.push(job);
          },
        },
        runJob: async (job) => {
          ran.push(job);
        },
        logger: silentLogger,
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const deliver = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${url}/webhook`, {
      method: "POST",
      body,
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": sign(body),
        ...headers,
      },
    });

  it("rejects unsigned webhooks", async () => {
    const response = await deliver(JSON.stringify(requestOpened), {
      "x-hub-signature-256": "sha256=bad",
    });
    expect(response.status).toBe(401);
    expect(queued).toHaveLength(0);
  });

  it("queues a request once and ignores duplicate deliveries", async () => {
    const body = JSON.stringify(requestOpened);
    expect((await deliver(body)).status).toBe(202);
    expect((await (await deliver(body)).json()) as object).toEqual({ duplicate: true });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      type: "request",
      issueNumber: 5,
      installationId: 7,
      owner: "acme",
    });
  });

  it("releases the delivery when the queue fails so GitHub can redeliver", async () => {
    failQueue = true;
    expect((await deliver(JSON.stringify(requestOpened))).status).toBe(500);
    failQueue = false;
    expect((await deliver(JSON.stringify(requestOpened))).status).toBe(202);
    expect(queued).toHaveLength(1);
  });

  it("protects the task endpoint with a token", async () => {
    const job = JSON.stringify({
      type: "request",
      deliveryId: "d",
      installationId: 7,
      owner: "acme",
      repo: "shop",
      issueNumber: 5,
    });
    expect((await fetch(`${url}/tasks/planner`, { method: "POST", body: job })).status).toBe(401);
    const ok = await fetch(`${url}/tasks/planner`, {
      method: "POST",
      body: job,
      headers: { "x-ai-dlc-task-token": TASK_TOKEN },
    });
    expect(ok.status).toBe(200);
    expect(ran).toHaveLength(1);
  });

  it("answers health checks and 404s", async () => {
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect((await fetch(`${url}/nope`)).status).toBe(404);
  });
});
