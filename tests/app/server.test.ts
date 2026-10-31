import { request as httpRequest, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryEvidenceStore, silentLogger } from "../../src/adapters/memory.js";
import { LocalApp } from "../../src/app/local-app.js";
import { createAppHandler, extractSubdomain } from "../../src/app/server.js";
import { LABELS } from "../../src/core/vocabulary.js";
import { FakeGitHub, FakeModel, PO, fixedClock } from "../helpers/fakes.js";
import { storyBody } from "../helpers/fixtures.js";

const TOKEN = "t".repeat(43);
const uiDir = fileURLToPath(new URL("../../ui/", import.meta.url));

describe("local app server", () => {
  let server: Server;
  let port: number;
  let github: FakeGitHub;

  beforeAll(async () => {
    github = new FakeGitHub();
    github.addIssue({ title: "[Story] Login", body: storyBody(), labels: [LABELS.story] });
    const app = new LocalApp({
      github,
      evidence: new MemoryEvidenceStore(),
      model: new FakeModel(),
      clock: fixedClock,
      logger: silentLogger,
    });
    let handler: ReturnType<typeof createAppHandler> | null = null;
    server = createServer((req, res) => void handler?.(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    handler = createAppHandler({ app, token: TOKEN, port, uiDir, logger: silentLogger });
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const call = (
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path,
            method: options.method ?? "GET",
            headers: { host: `127.0.0.1:${port}`, ...options.headers },
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
        req.end(options.body);
      },
    );

  const auth = { "x-ai-dlc-token": TOKEN };

  it("serves the UI with a strict CSP", async () => {
    const response = await call("/");
    expect(response.status).toBe(200);
    expect(response.body).toContain("huddle60");
    expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
    expect((await call("/../package.json")).status).toBe(404);
  });

  it("requires the session token for the API", async () => {
    expect((await call("/api/session")).status).toBe(401);
    expect((await call("/api/session", { headers: { "x-ai-dlc-token": "wrong" } })).status).toBe(
      401,
    );
    const ok = await call("/api/session", { headers: auth });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ viewer: { login: PO.login }, roles: ["po"] });
  });

  it("rejects foreign Host and Origin headers (DNS rebinding, CSRF)", async () => {
    expect(
      (await call("/api/session", { headers: { ...auth, host: "evil.example:80" } })).status,
    ).toBe(421);
    expect(
      (await call("/api/session", { headers: { ...auth, origin: "https://evil.example" } })).status,
    ).toBe(403);
  });

  it("validates POST bodies", async () => {
    const json = { ...auth, "content-type": "application/json" };
    expect(
      (await call("/api/issues/1/decisions", { method: "POST", headers: auth, body: "{}" })).status,
    ).toBe(415);
    const bad = await call("/api/issues/1/decisions", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ action: "merge" }),
    });
    expect(bad.status).toBe(400);
    const posted = await call("/api/issues/1/decisions", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ action: "approve" }),
    });
    expect(posted.status).toBe(200);
    expect(JSON.parse(posted.body).command).toMatch(/^\/(?:huddle60|ai-dlc) approve /u);
    const domain = await call("/api/issues/1/decisions", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ action: "ready", lane: "fast" }),
    });
    expect(domain.status).toBe(422);
    expect(JSON.parse(domain.body).error.code).toBe("E_ROLE");
  });

  it("supports GET /api/issues/:number and PATCH /api/issues/:number", async () => {
    const json = { ...auth, "content-type": "application/json" };
    const getRes = await call("/api/issues/1", { headers: auth });
    expect(getRes.status).toBe(200);
    expect(JSON.parse(getRes.body)).toMatchObject({
      number: 1,
      title: "[Story] Login",
      canEdit: true,
    });

    const patchRes = await call("/api/issues/1", {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({
        title: "[Story] Login updated",
        comment: "Note from user",
      }),
    });
    expect(patchRes.status).toBe(200);
    const patched = JSON.parse(patchRes.body);
    expect(patched.title).toBe("[Story] Login updated");
  });

  it("extracts subdomains for multi-tenant routing", () => {
    expect(extractSubdomain("congtya.huddle60.app")).toBe("congtya");
    expect(extractSubdomain("congtyb.localhost:4317")).toBe("congtyb");
    expect(extractSubdomain("huddle60.app")).toBeNull();
    expect(extractSubdomain("www.huddle60.app")).toBeNull();
    expect(extractSubdomain("localhost:4317")).toBeNull();
    expect(extractSubdomain("127.0.0.1:4317")).toBeNull();
  });

  it("reports auth status via /api/auth/status", async () => {
    const res = await call("/api/auth/status", { headers: auth });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(typeof data.oauthEnabled).toBe("boolean");
  });

  it("serves landing page on root and index on subdomain, injecting session token and cookie", async () => {
    // Root domain -> landing page
    const rootRes = await call("/", { headers: { host: `localhost:${port}` } });
    expect(rootRes.status).toBe(200);
    expect(rootRes.body).toContain("AI-DLC Platform for Startups");
    expect(rootRes.body).toContain(`<meta name="huddle60-session-token" content="${TOKEN}" />`);
    expect(rootRes.headers["set-cookie"]).toBeDefined();

    // Subdomain -> app index page
    const subRes = await call("/", { headers: { host: `congtya.localhost:${port}` } });
    expect(subRes.status).toBe(200);
    expect(subRes.body).toContain("<title>huddle60</title>");
    expect(subRes.body).toContain(`<meta name="huddle60-session-token" content="${TOKEN}" />`);
  });

  it("authenticates via cookie when x-ai-dlc-token header is omitted", async () => {
    const res = await call("/api/session", {
      headers: {
        cookie: `huddle60_token=${TOKEN}`,
      },
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.repo.owner).toBe("acme");
  });

  it("serves the app index page on clean SPA repo routes", async () => {
    const res = await call("/skill_bento", { headers: { host: `tadev999.localhost:${port}` } });
    expect(res.status).toBe(200);
    expect(res.body).toContain("<title>huddle60</title>");
    expect(res.body).toContain(`<meta name="huddle60-session-token" content="${TOKEN}" />`);

    const fullPathRes = await call("/tadev999/skill_bento", {
      headers: { host: `localhost:${port}` },
    });
    expect(fullPathRes.status).toBe(200);
    expect(fullPathRes.body).toContain("<title>huddle60</title>");
  });

  it("sets long-lived public cache headers for static assets and no-store for html", async () => {
    const cssRes = await call("/styles.css");
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers["cache-control"]).toContain("public, max-age=86400");

    const jsRes = await call("/app.js");
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers["cache-control"]).toContain("public, max-age=86400");

    const htmlRes = await call("/");
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers["cache-control"]).toBe("no-store");
  });

  it("caches items in-memory for GET /api/items and supports ?refresh=1", async () => {
    const res1 = await call("/api/items", { headers: auth });
    expect(res1.status).toBe(200);
    const items1 = JSON.parse(res1.body);
    expect(Array.isArray(items1)).toBe(true);

    // Call again, served from cache
    const res2 = await call("/api/items", { headers: auth });
    expect(res2.status).toBe(200);

    // Call with force refresh
    const res3 = await call("/api/items?refresh=1", { headers: auth });
    expect(res3.status).toBe(200);
  });

  it("lists repos via GET /api/repos and handles tenant domains, headers, and paths", async () => {
    const res = await call("/api/repos", { headers: auth });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(Array.isArray(data.repos)).toBe(true);

    // 1. Subdomain tenant
    const tenantRes = await call("/api/repos", {
      headers: { ...auth, host: `tochucA.localhost:${port}` },
    });
    expect(tenantRes.status).toBe(200);
    const tenantData = JSON.parse(tenantRes.body);
    expect(Array.isArray(tenantData.repos)).toBe(true);

    // 2. Header tenant
    const headerRes = await call("/api/repos", {
      headers: { ...auth, "x-huddle60-tenant": "tochucA" },
    });
    expect(headerRes.status).toBe(200);
    const headerData = JSON.parse(headerRes.body);
    expect(Array.isArray(headerData.repos)).toBe(true);

    // 3. Path-based tenant serving index.html with meta tag & cookie
    const pathHtmlRes = await call("/tochucA");
    expect(pathHtmlRes.status).toBe(200);
    expect(pathHtmlRes.body).toContain('<meta name="huddle60-tenant" content="tochucA" />');
  }, 15_000);

  it("handles /api/policy/roles endpoint", async () => {
    const res = await call("/api/policy/roles", { headers: auth });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty("canEdit");
  });
});
