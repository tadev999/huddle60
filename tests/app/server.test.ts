import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { request as httpRequest, createServer, type Server } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "../../src/adapters/memory.js";
import { createAppHandler, extractSubdomain, HOSTED_CSP } from "../../src/app/server.js";

const uiDir = fileURLToPath(new URL("../../ui/", import.meta.url));

describe("local browser app server", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    if (!existsSync(join(uiDir, "engine.js"))) {
      await writeFile(join(uiDir, "engine.js"), "/* engine.js mock for tests */\n");
    }
    let handler: ReturnType<typeof createAppHandler>;
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    handler = createAppHandler({ port, uiDir, logger: silentLogger });
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const call = (path: string, headers: Record<string, string> = {}, method = "GET") =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path,
            method,
            headers: { host: `localhost:${port}`, ...headers },
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

  it("uses the same browser engine and CSP as SaaS without a session token", async () => {
    const response = await call("/app");
    expect(response.status).toBe(200);
    expect(response.body).toContain('<meta name="huddle60-mode" content="browser" />');
    expect(response.body).not.toContain("huddle60-session-token");
    expect(JSON.stringify(response.headers["set-cookie"] ?? [])).not.toContain("huddle60_token");
    expect(response.headers["content-security-policy"]).toBe(HOSTED_CSP);
    expect((await call("/engine.js")).status).toBe(200);
    expect((await call("/../package.json")).status).toBe(404);
  });

  it.each([
    ["GET", "/api/session"],
    ["GET", "/api/items?refresh=1"],
    ["GET", "/api/repos"],
    ["GET", "/api/policy/roles"],
    ["POST", "/api/settings"],
    ["POST", "/api/auth/gh-cli"],
    ["POST", "/api/issues/1/decisions"],
    ["PATCH", "/api/issues/1"],
  ])("has no Node data API for %s %s", async (method, path) => {
    const response = await call(path, {}, method);
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "E_BROWSER_MODE" } });
  });

  it("rejects foreign Host and Origin headers", async () => {
    expect((await call("/app", { host: "evil.example:80" })).status).toBe(421);
    expect((await call("/app", { origin: "https://evil.example" })).status).toBe(403);
  });

  it("serves landing, workspace and repo URLs without a token", async () => {
    expect((await call("/")).body).toContain("AI-DLC Platform for Startups");
    for (const [path, host, tenant] of [
      ["/", `congtya.localhost:${port}`, "congtya"],
      ["/skill_bento", `tadev999.localhost:${port}`, "tadev999"],
      ["/tadev999/skill_bento", `localhost:${port}`, "tadev999"],
    ]) {
      const response = await call(path!, { host: host! });
      expect(response.status).toBe(200);
      expect(response.body).toContain("<title>huddle60</title>");
      expect(response.body).toContain(`<meta name="huddle60-tenant" content="${tenant}" />`);
    }
    const root = await call("/", { cookie: "huddle60_tenant=congtya" });
    expect(root.body).toContain("AI-DLC Platform for Startups");
  });

  it("caches static assets but not HTML", async () => {
    for (const asset of ["/styles.css", "/app.js", "/engine.js", "/theme.js"]) {
      const response = await call(asset);
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toContain("public, max-age=86400");
    }
    expect((await call("/app")).headers["cache-control"]).toBe("no-store");
  });

  it("opens a neutral app without restoring the last workspace cookie", async () => {
    for (const host of [`localhost:${port}`, `tadev999.localhost:${port}`]) {
      const response = await call("/app", { host, cookie: "huddle60_tenant=tadev999" });
      expect(response.status).toBe(200);
      expect(response.body).not.toContain('name="huddle60-tenant"');
      expect(response.body).toContain("Choose workspace");
    }
  });

  it("switches workspace explicitly on the same origin, overriding old cookies and subdomains", async () => {
    const response = await call("/app?tenant=microsoft", {
      host: `tadev999.localhost:${port}`,
      cookie: "huddle60_tenant=tadev999",
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain('<meta name="huddle60-tenant" content="microsoft" />');
    expect(response.body).not.toContain('content="tadev999"');
  });

  it("extracts subdomains for workspace routing", () => {
    expect(extractSubdomain("congtya.huddle60.app")).toBe("congtya");
    expect(extractSubdomain("congtyb.localhost:4317")).toBe("congtyb");
    for (const host of ["huddle60.app", "www.huddle60.app", "localhost:4317", "127.0.0.1:4317"])
      expect(extractSubdomain(host)).toBeNull();
  });
});
