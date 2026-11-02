import { request as httpRequest, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../src/adapters/memory.js";
import {
  HOSTED_CSP,
  OAUTH_COOKIE,
  createAppHandler,
  normalizeTenant,
  safeReturnUrl,
} from "../../src/app/server.js";

const OPERATOR_TOKEN = "o".repeat(43);
const uiDir = fileURLToPath(new URL("../../ui/", import.meta.url));

describe("thin hosted server", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    let handler: ReturnType<typeof createAppHandler> | null = null;
    server = createServer((req, res) => void handler?.(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    handler = createAppHandler({
      port,
      uiDir,
      logger: silentLogger,
    });
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const call = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path,
            headers: { host: `tadev999.localhost:${port}`, ...headers },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      },
    );

  it("serves the app in browser mode without any server token or session", async () => {
    const page = await call("/");
    expect(page.status).toBe(200);
    expect(page.body).toContain('<meta name="huddle60-mode" content="browser" />');
    expect(page.body).toContain('<meta name="huddle60-tenant" content="tadev999" />');
    expect(page.body).not.toContain(OPERATOR_TOKEN);
    expect(page.body).not.toContain("huddle60-session-token");
    expect(JSON.stringify(page.headers["set-cookie"] ?? [])).not.toContain("huddle60_token");
    expect(page.headers["content-security-policy"]).toBe(HOSTED_CSP);
  });

  it("has no data API, even with the operator token", async () => {
    const response = await call("/api/session", { "x-ai-dlc-token": OPERATOR_TOKEN });
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe("E_BROWSER_MODE");
  });

  it("starts OAuth with a state cookie and hands the token back in the fragment", async () => {
    vi.stubEnv("GITHUB_CLIENT_ID", "client-1");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "secret-1");
    const start = await call("/api/auth/github?returnUrl=%2Ftadev999%2Fshop%23x");
    expect(start.status).toBe(302);
    const location = new URL(start.headers.location as string);
    const state = location.searchParams.get("state") ?? "";
    const cookie = ((start.headers["set-cookie"] as string[]) ?? [])[0] ?? "";
    expect(cookie).toContain(`${OAUTH_COOKIE}=${state}.`);
    expect(cookie).toContain("HttpOnly");

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ access_token: "gho_visitor" })));
    const callback = await call(`/api/auth/github/callback?code=abc&state=${state}`, {
      cookie: cookie.split(";")[0] as string,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe("/tadev999/shop#gh_token=gho_visitor");
  });

  it("rejects an OAuth callback whose state does not match this browser", async () => {
    vi.stubEnv("GITHUB_CLIENT_ID", "client-1");
    const start = await call("/api/auth/github");
    const cookie = ((start.headers["set-cookie"] as string[]) ?? [])[0] ?? "";
    const forged = await call("/api/auth/github/callback?code=abc&state=attacker", {
      cookie: cookie.split(";")[0] as string,
    });
    expect(forged.status).toBe(400);
    expect((await call("/api/auth/github/callback?code=abc&state=x")).status).toBe(400);
  });

  it("never reflects an invalid tenant into the page", async () => {
    const page = await call(`/?tenant=${encodeURIComponent('"><img src=x>')}`, {
      host: `127.0.0.1:${port}`,
    });
    expect(page.body).not.toContain("<img src=x>");
  });
});

describe("hosted helpers", () => {
  it("accepts only GitHub-like tenant names", () => {
    expect(normalizeTenant("TaDev999")).toBe("TaDev999");
    expect(normalizeTenant("skill_bento")).toBeNull();
    expect(normalizeTenant('"><script>')).toBeNull();
    expect(normalizeTenant("")).toBeNull();
  });

  it("allows only same-site relative return URLs without fragments", () => {
    expect(safeReturnUrl("/tadev999/shop#12")).toBe("/tadev999/shop");
    expect(safeReturnUrl("https://evil.example")).toBe("/");
    expect(safeReturnUrl("//evil.example")).toBe("/");
    expect(safeReturnUrl("/\\evil.example")).toBe("/");
  });
});
