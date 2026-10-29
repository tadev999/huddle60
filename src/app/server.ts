import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import { isAiDlcError } from "../core/errors.js";
import type { Logger } from "../ports.js";
import { safeEqual } from "../server/http.js";
import type { LocalApp } from "./local-app.js";

export const TOKEN_HEADER = "x-ai-dlc-token";
const MAX_BODY = 256 * 1024;

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};

const DraftInput = z.object({
  title: z.string().max(200).optional(),
  request: z.string().max(20_000),
});
const RefineInput = z.object({ clarification: z.string().max(5_000) });
const DecideInput = z.object({
  action: z.enum(["approve", "ready", "accept"]),
  lane: z.enum(["fast", "standard", "strict"]).optional(),
  runId: z.number().int().positive().optional(),
});

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AppServerOptions {
  app: LocalApp;
  token: string;
  port: number;
  uiDir: string;
  logger: Logger;
}

/**
 * Request handler for the local app. It is bound to 127.0.0.1 by the caller and
 * additionally checks Host (DNS rebinding), Origin (CSRF) and a per-run token.
 */
export function createAppHandler(options: AppServerOptions) {
  const { app, token, port, uiDir, logger } = options;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));

  const routes: Array<{
    method: string;
    pattern: RegExp;
    handle: (match: RegExpExecArray, body: unknown) => Promise<unknown>;
  }> = [
    { method: "GET", pattern: /^\/api\/session$/u, handle: () => app.session() },
    {
      method: "POST",
      pattern: /^\/api\/plans$/u,
      handle: (_m, body) => {
        const input = DraftInput.parse(body);
        return app.draftPlan({
          request: input.request,
          ...(input.title ? { title: input.title } : {}),
        });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/plans\/([\w-]{1,64})\/refine$/u,
      handle: (m, body) => app.refinePlan(m[1] as string, RefineInput.parse(body).clarification),
    },
    {
      method: "POST",
      pattern: /^\/api\/plans\/([\w-]{1,64})\/create$/u,
      handle: (m) => app.createPlan(m[1] as string),
    },
    { method: "GET", pattern: /^\/api\/items$/u, handle: () => app.listItems() },
    { method: "GET", pattern: /^\/api\/builds$/u, handle: () => app.builds() },
    {
      method: "POST",
      pattern: /^\/api\/issues\/(\d{1,9})\/decisions$/u,
      handle: (m, body) => {
        const input = DecideInput.parse(body);
        return app.decide(Number(m[1]), {
          action: input.action,
          ...(input.lane ? { lane: input.lane } : {}),
          ...(input.runId ? { runId: input.runId } : {}),
        });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/issues\/(\d{1,9})\/replies\/(\d{1,15})$/u,
      handle: (m) => app.reply(Number(m[1]), Number(m[2])),
    },
    {
      method: "GET",
      pattern: /^\/api\/issues\/(\d{1,9})\/context$/u,
      handle: async (m) => ({ markdown: await app.context(Number(m[1])) }),
    },
  ];

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!allowedHosts.has(req.headers.host ?? ""))
        throw new HttpError(421, "E_HOST", "Bad host.");
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.has(origin))
        throw new HttpError(403, "E_ORIGIN", "Cross-origin requests are not allowed.");
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (!url.pathname.startsWith("/api/")) {
        const entry = STATIC_FILES[url.pathname];
        if (req.method !== "GET" || !entry) throw new HttpError(404, "E_NOT_FOUND", "Not found.");
        const content = await readFile(join(uiDir, entry.file));
        res.writeHead(200, { ...SECURITY_HEADERS, "content-type": entry.type });
        res.end(content);
        return;
      }

      const presented = req.headers[TOKEN_HEADER];
      if (typeof presented !== "string" || !safeEqual(presented, token))
        throw new HttpError(
          401,
          "E_TOKEN",
          "Missing or invalid session token. Reopen the app URL.",
        );
      const route = routes.find(
        (candidate) => candidate.method === req.method && candidate.pattern.test(url.pathname),
      );
      if (!route) throw new HttpError(404, "E_NOT_FOUND", "Unknown endpoint.");
      let body: unknown = undefined;
      if (req.method === "POST") {
        if (!(req.headers["content-type"] ?? "").startsWith("application/json"))
          throw new HttpError(415, "E_CONTENT_TYPE", "Expected application/json.");
        body = await readJson(req);
      }
      const result = await route.handle(route.pattern.exec(url.pathname) as RegExpExecArray, body);
      sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message } });
      } else if (error instanceof z.ZodError) {
        sendJson(res, 400, { error: { code: "E_INPUT", message: z.prettifyError(error) } });
      } else if (isAiDlcError(error)) {
        sendJson(res, 422, { error: { code: error.code, message: error.message } });
      } else {
        logger.error("request failed", {
          path: req.url,
          error: error instanceof Error ? error.message : String(error),
        });
        sendJson(res, 500, {
          error: {
            code: "E_INTERNAL",
            message: "Unexpected error. See the terminal running huddle60 ui.",
          },
        });
      }
    }
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "E_TOO_LARGE", "Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "E_INPUT", "Body is not valid JSON.");
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
