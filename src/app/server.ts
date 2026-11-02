import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Logger } from "../ports.js";
import { HttpError, errorResponse } from "./routes.js";

export { HttpError } from "./routes.js";

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

export const OAUTH_COOKIE = "huddle60_oauth";
const OAUTH_STATE_TTL_MS = 10 * 60_000;

const GITHUB_LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/iu;

export function normalizeTenant(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return GITHUB_LOGIN.test(trimmed) ? trimmed : null;
}

/** Only same-site relative paths, so the OAuth callback cannot become an open redirect. */
export function safeReturnUrl(value: string | null | undefined): string {
  if (!value || value.length > 2000) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value.split("#")[0] || "/";
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app": { file: "index.html", type: "text/html; charset=utf-8" },
  "/landing": { file: "landing.html", type: "text/html; charset=utf-8" },
  "/landing.html": { file: "landing.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/engine.js": { file: "engine.js", type: "text/javascript; charset=utf-8" },
  "/landing.js": { file: "landing.js", type: "text/javascript; charset=utf-8" },
  "/theme.js": { file: "theme.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};

const BASE_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};

/** The browser engine talks to GitHub and Gemini directly with the visitor's own credentials. */
export const HOSTED_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self' https://api.github.com https://uploads.github.com https://generativelanguage.googleapis.com https://models.github.ai; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface AppServerOptions {
  host?: string;
  port: number;
  uiDir: string;
  logger: Logger;
}

/**
 * Both local and SaaS serve static files plus a stateless OAuth exchange.
 * Credentials and application logic belong to each visitor's browser.
 */
export function createAppHandler(options: AppServerOptions) {
  const { host, port, uiDir, logger } = options;
  const securityHeaders = {
    ...BASE_HEADERS,
    "content-security-policy": HOSTED_CSP,
  };
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
      return isAllowedHost(new URL(origin).host);
    } catch {
      return false;
    }
  };

  const exchangeCode = async (code: string): Promise<string> => {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
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
        `GitHub sign-in failed: ${tokenData.error || "no token received"}`,
      );
    }
    return tokenData.access_token;
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const secureCookie = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
      // Tenant only routes to an owner's repositories; it never grants access.
      const cleanPath = url.pathname.replace(/\/+$/, "") || "/";
      let tenant =
        cleanPath === "/app"
          ? normalizeTenant(url.searchParams.get("tenant"))
          : normalizeTenant(extractSubdomain(req.headers.host));
      if (!tenant) {
        const headerTenant = req.headers["x-huddle60-tenant"];
        if (typeof headerTenant === "string") tenant = normalizeTenant(headerTenant);
      }
      if (!tenant) tenant = normalizeTenant(url.searchParams.get("tenant"));
      if (!tenant) {
        const firstSegment = cleanPath.split("/").filter(Boolean)[0];
        if (
          firstSegment &&
          !["api", "app", "landing", "index.html"].includes(firstSegment) &&
          !firstSegment.includes(".")
        ) {
          tenant = normalizeTenant(firstSegment);
        }
      }
      const explicitTenant = tenant;

      if (!isAllowedHost(req.headers.host ?? "")) throw new HttpError(421, "E_HOST", "Bad host.");
      if (!isAllowedOrigin(req.headers.origin))
        throw new HttpError(403, "E_ORIGIN", "Cross-origin requests are not allowed.");

      if (url.pathname === "/api/auth/github") {
        const clientId = process.env.GITHUB_CLIENT_ID;
        if (!clientId) {
          throw new HttpError(
            400,
            "E_OAUTH",
            "GitHub OAuth is not configured (GITHUB_CLIENT_ID is missing on the server).",
          );
        }
        const state = randomToken();
        const returnUrl = safeReturnUrl(url.searchParams.get("returnUrl"));
        const headers: Record<string, string> = {};
        const value = `${state}.${Buffer.from(returnUrl).toString("base64url")}`;
        headers["set-cookie"] =
          `${OAUTH_COOKIE}=${value}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=${OAUTH_STATE_TTL_MS / 1000}${secureCookie}`;
        const protocol = req.headers["x-forwarded-proto"] || "http";
        const redirectUri = `${protocol}://${req.headers.host}/api/auth/github/callback`;
        const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&scope=repo,read:user&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
        res.writeHead(302, { ...headers, Location: authUrl });
        res.end();
        return;
      }

      if (url.pathname === "/api/auth/github/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state") ?? "";
        const [cookieState, encodedReturn] = (getCookie(req, OAUTH_COOKIE) ?? "").split(".");
        if (!cookieState || !state || !safeEqual(cookieState, state))
          throw new HttpError(400, "E_OAUTH", "The GitHub sign-in session is invalid or expired.");
        if (!code) throw new HttpError(400, "E_OAUTH", "Missing GitHub authorization code.");
        const accessToken = await exchangeCode(code);
        const returnUrl = safeReturnUrl(
          Buffer.from(encodedReturn ?? "", "base64url").toString("utf8"),
        );
        // The token goes to the browser in the fragment, which is never sent to any server.
        res.writeHead(302, {
          "set-cookie": `${OAUTH_COOKIE}=; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie}`,
          Location: `${returnUrl}#gh_token=${encodeURIComponent(accessToken)}`,
        });
        res.end();
        return;
      }

      if (!url.pathname.startsWith("/api/")) {
        const cleanPath = url.pathname.replace(/\/+$/, "") || "/";
        let entry = STATIC_FILES[cleanPath];
        if (cleanPath === "/") {
          entry = explicitTenant ? STATIC_FILES["/"] : STATIC_FILES["/landing"];
        } else if (!entry && !cleanPath.includes(".")) {
          // SPA clean URL route, e.g. /skill_bento or /tadev999/skill_bento
          entry = STATIC_FILES["/"];
        }
        if (req.method !== "GET" || !entry) throw new HttpError(404, "E_NOT_FOUND", "Not found.");
        let content = await readFile(join(uiDir, entry.file));
        const isStaticAsset =
          cleanPath.endsWith(".css") || cleanPath.endsWith(".js") || cleanPath.endsWith(".svg");
        if (entry.type.startsWith("text/html")) {
          const meta = [
            `<meta name="huddle60-mode" content="browser" />`,
            `<meta name="huddle60-oauth" content="${process.env.GITHUB_CLIENT_ID ? "1" : "0"}" />`,
          ];
          if (tenant) meta.push(`<meta name="huddle60-tenant" content="${tenant}" />`);
          const html = content
            .toString("utf8")
            .replace("<head>", `<head>\n    ${meta.join("\n    ")}`);
          content = Buffer.from(html, "utf8");
        }
        res.writeHead(200, {
          ...securityHeaders,
          "content-type": entry.type,
          "cache-control": isStaticAsset
            ? "public, max-age=86400, stale-while-revalidate=3600"
            : "no-store",
        });
        res.end(content);
        return;
      }

      throw new HttpError(
        404,
        "E_BROWSER_MODE",
        "The app runs in your browser; the server has no data API.",
      );
    } catch (error) {
      const { status, body } = errorResponse(error, logger, req.url ?? "");
      sendJson(res, status, body, securityHeaders);
    }
  };
}

function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string>,
): void {
  res.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
