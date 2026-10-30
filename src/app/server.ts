import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import { isAiDlcError } from "../core/errors.js";
import type { Logger } from "../ports.js";
import type { LocalApp } from "./local-app.js";
import { LocalAppManager } from "./manager.js";

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function getCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(header);
  return match && match[1] ? decodeURIComponent(match[1]) : undefined;
}

export function extractSubdomain(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.split(":")[0]?.toLowerCase() ?? "";

  // Ignore raw IP addresses
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return null;

  // Localhost subdomains: e.g. congtyA.localhost
  if (host.endsWith(".localhost")) {
    const parts = host.slice(0, -".localhost".length).split(".");
    const sub = parts[parts.length - 1];
    return sub && sub !== "www" && sub !== "app" ? sub : null;
  }

  // Domain with at least 3 parts: e.g. congtyA.huddle60.app
  const parts = host.split(".");
  if (parts.length >= 3) {
    const sub = parts[0];
    if (sub && sub !== "www" && sub !== "app") return sub;
  }

  return null;
}

export const TOKEN_HEADER = "x-ai-dlc-token";
const MAX_BODY = 256 * 1024;

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app": { file: "index.html", type: "text/html; charset=utf-8" },
  "/landing": { file: "landing.html", type: "text/html; charset=utf-8" },
  "/landing.html": { file: "landing.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/landing.js": { file: "landing.js", type: "text/javascript; charset=utf-8" },
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

const SettingsInput = z.object({
  githubToken: z.string().optional(),
  repo: z.string().optional(),
  recentRepos: z.array(z.string()).optional(),
  geminiApiKey: z.string().optional(),
  geminiModel: z.string().optional(),
});
const TestGithubInput = z.object({
  token: z.string().optional(),
});
const TestGeminiInput = z.object({
  apiKey: z.string().optional(),
  model: z.string().optional(),
});
const UpdateIssueInput = z.object({
  title: z.string().min(1).max(256).optional(),
  body: z.string().max(65536).optional(),
  comment: z.string().max(10000).optional(),
});
const RefineIssueInput = z.object({
  instruction: z.string().min(1).max(5000),
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
  app?: LocalApp;
  manager?: LocalAppManager;
  token: string;
  host?: string;
  port: number;
  uiDir: string;
  logger: Logger;
}

/**
 * Request handler for the local app. It is bound to 127.0.0.1 by default and
 * additionally checks Host (DNS rebinding), Origin (CSRF) and a session token.
 */
export function createAppHandler(options: AppServerOptions) {
  const { app, manager, token, host, port, uiDir, logger } = options;
  const allowAllHosts = process.env.ALLOWED_HOSTS === "*";
  const customHosts = (process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    ...(host && host !== "0.0.0.0" && host !== "127.0.0.1" ? [`${host}:${port}`] : []),
    ...customHosts,
  ]);
  const allowedOrigins = new Set([
    ...[...allowedHosts].map((h) => `http://${h}`),
    ...[...allowedHosts].map((h) => `https://${h}`),
  ]);

  const isAllowedHost = (presentedHost: string): boolean => {
    if (allowAllHosts) return true;
    if (allowedHosts.has(presentedHost)) return true;
    const hostname = presentedHost.split(":")[0]?.toLowerCase() ?? "";
    if (hostname.endsWith(".localhost") || hostname === "localhost" || hostname === "127.0.0.1")
      return true;
    for (const allowed of allowedHosts) {
      const allowedDomain = allowed.split(":")[0]?.toLowerCase() ?? "";
      if (hostname.endsWith(`.${allowedDomain}`)) return true;
    }
    return false;
  };

  const isAllowedOrigin = (origin: string | undefined): boolean => {
    if (allowAllHosts || !origin) return true;
    if (allowedOrigins.has(origin)) return true;
    try {
      const originHost = new URL(origin).host;
      return isAllowedHost(originHost);
    } catch {
      return false;
    }
  };

  const tenantManagers = new Map<string, LocalAppManager>();

  const getManagerFor = async (tenant: string | null): Promise<LocalAppManager> => {
    if (!tenant) {
      if (manager) return manager;
      throw new HttpError(400, "E_NO_MANAGER", "Manager is not initialized.");
    }
    let tm = tenantManagers.get(tenant);
    if (!tm) {
      tm = new LocalAppManager({ tenant, logger });
      await tm.initialize();
      tenantManagers.set(tenant, tm);
    }
    return tm;
  };

  const getAppFor = async (tenant: string | null): Promise<LocalApp> => {
    if (app && !tenant) return app;
    const mgr = await getManagerFor(tenant);
    return mgr.app;
  };

  const routes: Array<{
    method: string;
    pattern: RegExp;
    handle: (
      match: RegExpExecArray,
      body: unknown,
      tenant: string | null,
      url: URL,
    ) => Promise<unknown>;
  }> = [
    {
      method: "GET",
      pattern: /^\/api\/session$/u,
      handle: async (_m, _b, tenant) => {
        const mgr = await getManagerFor(tenant).catch(() => null);
        return mgr ? mgr.session() : app ? app.session() : { status: "needs_setup", tenant };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/repos$/u,
      handle: async (_m, _b, tenant, url) => {
        const force = url.searchParams.get("refresh") === "true";
        const mgr = await getManagerFor(tenant).catch(() => null);
        return { repos: mgr ? await mgr.listUserRepos(force) : [] };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/settings$/u,
      handle: async (_m, _b, tenant) => (await getManagerFor(tenant)).getSettings(),
    },
    {
      method: "POST",
      pattern: /^\/api\/settings$/u,
      handle: async (_m, body, tenant) =>
        (await getManagerFor(tenant)).updateSettings(SettingsInput.parse(body)),
    },
    {
      method: "POST",
      pattern: /^\/api\/settings\/test-github$/u,
      handle: async (_m, body, tenant) => {
        const input = TestGithubInput.parse(body ?? {});
        return (await getManagerFor(tenant)).testGithub(input.token);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/settings\/test-gemini$/u,
      handle: async (_m, body, tenant) => {
        const input = TestGeminiInput.parse(body ?? {});
        return (await getManagerFor(tenant)).testGemini(input.apiKey, input.model);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/repo\/init$/u,
      handle: async (_m, _b, tenant) => (await getManagerFor(tenant)).initRepo(),
    },
    {
      method: "POST",
      pattern: /^\/api\/plans$/u,
      handle: async (_m, body, tenant) => {
        const input = DraftInput.parse(body);
        return (await getAppFor(tenant)).draftPlan({
          request: input.request,
          ...(input.title ? { title: input.title } : {}),
        });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/plans\/([\w-]{1,64})\/refine$/u,
      handle: async (m, body, tenant) =>
        (await getAppFor(tenant)).refinePlan(m[1] as string, RefineInput.parse(body).clarification),
    },
    {
      method: "POST",
      pattern: /^\/api\/plans\/([\w-]{1,64})\/create$/u,
      handle: async (m, _b, tenant) => (await getAppFor(tenant)).createPlan(m[1] as string),
    },
    {
      method: "GET",
      pattern: /^\/api\/items$/u,
      handle: async (_m, _b, tenant) => (await getAppFor(tenant)).listItems(),
    },
    {
      method: "GET",
      pattern: /^\/api\/builds$/u,
      handle: async (_m, _b, tenant) => (await getAppFor(tenant)).builds(),
    },
    {
      method: "POST",
      pattern: /^\/api\/issues\/(\d{1,9})\/decisions$/u,
      handle: async (m, body, tenant) => {
        const input = DecideInput.parse(body);
        return (await getAppFor(tenant)).decide(Number(m[1]), {
          action: input.action,
          ...(input.lane ? { lane: input.lane } : {}),
          ...(input.runId ? { runId: input.runId } : {}),
        });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/issues\/(\d{1,9})\/replies\/(\d{1,15})$/u,
      handle: async (m, _b, tenant) => (await getAppFor(tenant)).reply(Number(m[1]), Number(m[2])),
    },
    {
      method: "GET",
      pattern: /^\/api\/issues\/(\d{1,9})\/context$/u,
      handle: async (m, _b, tenant) => ({
        markdown: await (await getAppFor(tenant)).context(Number(m[1])),
      }),
    },
    {
      method: "GET",
      pattern: /^\/api\/issues\/(\d{1,9})$/u,
      handle: async (m, _b, tenant) => (await getAppFor(tenant)).getIssueDetails(Number(m[1])),
    },
    {
      method: "PATCH",
      pattern: /^\/api\/issues\/(\d{1,9})$/u,
      handle: async (m, body, tenant) =>
        (await getAppFor(tenant)).updateIssueDetails(Number(m[1]), UpdateIssueInput.parse(body)),
    },
    {
      method: "POST",
      pattern: /^\/api\/issues\/(\d{1,9})\/ai-refine$/u,
      handle: async (m, body, tenant) =>
        (await getAppFor(tenant)).refineIssueWithAi(
          Number(m[1]),
          RefineIssueInput.parse(body).instruction,
        ),
    },
    {
      method: "GET",
      pattern: /^\/api\/auth\/status$/u,
      handle: async (_m, _b, tenant) => ({
        oauthEnabled: Boolean(process.env.GITHUB_CLIENT_ID),
        clientId: process.env.GITHUB_CLIENT_ID || null,
        tenant,
      }),
    },
  ];

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const tenant = extractSubdomain(req.headers.host);
      if (!isAllowedHost(req.headers.host ?? "")) throw new HttpError(421, "E_HOST", "Bad host.");
      const origin = req.headers.origin;
      if (!isAllowedOrigin(origin))
        throw new HttpError(403, "E_ORIGIN", "Cross-origin requests are not allowed.");
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      // Public GitHub OAuth endpoints (no session token required)
      if (url.pathname === "/api/auth/github") {
        const clientId = process.env.GITHUB_CLIENT_ID;
        if (!clientId) {
          throw new HttpError(
            400,
            "E_OAUTH",
            "GitHub OAuth chưa được cấu hình (thiếu GITHUB_CLIENT_ID trên server).",
          );
        }
        const statePayload = Buffer.from(
          JSON.stringify({ tenant, returnUrl: url.searchParams.get("returnUrl") || "/" }),
        ).toString("base64url");
        const protocol = req.headers["x-forwarded-proto"] || "http";
        const redirectUri = `${protocol}://${req.headers.host}/api/auth/github/callback`;
        const authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&scope=repo,read:user&redirect_uri=${encodeURIComponent(redirectUri)}&state=${statePayload}`;
        res.writeHead(302, { Location: authUrl });
        res.end();
        return;
      }

      if (url.pathname === "/api/auth/github/callback") {
        const code = url.searchParams.get("code");
        const stateRaw = url.searchParams.get("state");
        if (!code) throw new HttpError(400, "E_OAUTH", "Thiếu mã xác thực từ GitHub.");
        let stateData: { tenant?: string; returnUrl?: string } = {};
        try {
          if (stateRaw) {
            stateData = JSON.parse(Buffer.from(stateRaw, "base64url").toString("utf8"));
          }
        } catch {}

        const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            client_id: process.env.GITHUB_CLIENT_ID,
            client_secret: process.env.GITHUB_CLIENT_SECRET,
            code,
          }),
        });
        const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
        if (!tokenData.access_token) {
          throw new HttpError(
            400,
            "E_OAUTH",
            `Đăng nhập GitHub thất bại: ${tokenData.error || "không nhận được token"}`,
          );
        }

        const targetTenant = stateData.tenant || tenant;
        const mgr = await getManagerFor(targetTenant);
        await mgr.updateSettings({ githubToken: tokenData.access_token });

        const returnUrl = stateData.returnUrl || "/";
        const redirectDest = returnUrl.includes("#") ? returnUrl : `${returnUrl}#token=${token}`;
        res.writeHead(302, { Location: redirectDest });
        res.end();
        return;
      }

      if (!url.pathname.startsWith("/api/")) {
        let entry = STATIC_FILES[url.pathname];
        if (url.pathname === "/") {
          entry = tenant ? STATIC_FILES["/"] : STATIC_FILES["/landing"];
        }
        if (req.method !== "GET" || !entry) throw new HttpError(404, "E_NOT_FOUND", "Not found.");
        let content = await readFile(join(uiDir, entry.file));

        const headers: Record<string, string> = {
          ...SECURITY_HEADERS,
          "content-type": entry.type,
          "set-cookie": `huddle60_token=${token}; Path=/; SameSite=Lax`,
        };

        if (entry.type.startsWith("text/html")) {
          const html = content.toString("utf8");
          const injected = html.replace(
            "<head>",
            `<head>\n    <meta name="huddle60-session-token" content="${token}" />`,
          );
          content = Buffer.from(injected, "utf8");
        }

        res.writeHead(200, headers);
        res.end(content);
        return;
      }

      const cookieToken = getCookie(req, "huddle60_token");
      const presented = req.headers[TOKEN_HEADER] || cookieToken;
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
      if (req.method === "POST" || req.method === "PATCH") {
        if (!(req.headers["content-type"] ?? "").startsWith("application/json"))
          throw new HttpError(415, "E_CONTENT_TYPE", "Expected application/json.");
        body = await readJson(req);
      }
      const result = await route.handle(
        route.pattern.exec(url.pathname) as RegExpExecArray,
        body,
        tenant,
        url,
      );
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
