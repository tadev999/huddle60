import { describe, expect, it } from "vitest";
import { silentLogger } from "../../src/adapters/memory.js";
import type { LocalAppManager } from "../../src/app/manager.js";
import { LocalAppManager as RealManager } from "../../src/app/manager.js";
import type { Huddle60Config } from "../../src/core/config.js";
import { createBrowserEngine, type KeyValueStore } from "../../src/web/engine.js";
import { CredentialStorage } from "../../src/web/credentials.js";

class MapStore implements KeyValueStore {
  readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

class FakeManager {
  constructor(public config: Huddle60Config) {}
  get isSignedIn() {
    return Boolean(this.config.githubToken);
  }
  async session() {
    return { status: "ready", viewer: this.isSignedIn ? { login: "me" } : null, roles: [] };
  }
  async updateSettings(patch: Huddle60Config) {
    this.config = { ...this.config, ...patch };
    return { hasGithubToken: this.isSignedIn };
  }
  get app() {
    return { decide: async () => ({ commentId: 7, command: "/huddle60 approve" }) };
  }
}

function setup() {
  const session = new MapStore();
  const prefs = new MapStore();
  const secrets = new CredentialStorage(session, prefs);
  const created: FakeManager[] = [];
  const engine = createBrowserEngine({
    secrets,
    prefs,
    oauthEnabled: true,
    logger: silentLogger,
    createManager: async (_tenant, config) => {
      const manager = new FakeManager(config);
      created.push(manager);
      return manager as unknown as LocalAppManager;
    },
  });
  return { engine, secrets, session, prefs, created };
}

describe("browser engine (hosted app)", () => {
  it("keeps secrets in session storage and preferences in local storage", async () => {
    const { engine, secrets, prefs } = setup();
    const result = await engine.call(
      "POST",
      "/api/settings",
      { githubToken: "gho_me", geminiApiKey: "AIza-key", repo: "tadev999/shop" },
      "tadev999",
    );
    expect(result.status).toBe(200);
    expect(secrets.getItem("huddle60:githubToken")).toBe("gho_me");
    expect(secrets.getItem("huddle60:geminiApiKey")).toBe("AIza-key");
    expect([...prefs.map.values()].join()).not.toContain("gho_me");
    expect([...prefs.map.values()].join()).not.toContain("AIza-key");
    expect(prefs.getItem("huddle60:tadev999:repo")).toBe("tadev999/shop");
  });

  it("restores the sign-in from storage when the tab reloads", async () => {
    const { secrets, prefs } = setup();
    secrets.setItem("huddle60:githubToken", "gho_saved");
    prefs.setItem("huddle60:tadev999:repo", "tadev999/shop");
    const created: FakeManager[] = [];
    const engine = createBrowserEngine({
      secrets,
      prefs,
      oauthEnabled: false,
      logger: silentLogger,
      createManager: async (_tenant, config) => {
        const manager = new FakeManager(config);
        created.push(manager);
        return manager as unknown as LocalAppManager;
      },
    });
    await engine.call("GET", "/api/session", undefined, "tadev999");
    expect(created[0]?.config).toMatchObject({ githubToken: "gho_saved", repo: "tadev999/shop" });
  });

  it("requires the visitor's own sign-in for write actions", async () => {
    const { engine } = setup();
    const denied = await engine.call(
      "POST",
      "/api/issues/1/decisions",
      { action: "approve" },
      null,
    );
    expect(denied.status).toBe(401);
    expect(denied.body).toMatchObject({ error: { code: "E_AUTH" } });

    await engine.call("POST", "/api/settings", { githubToken: "gho_me" }, null);
    const allowed = await engine.call(
      "POST",
      "/api/issues/1/decisions",
      { action: "approve" },
      null,
    );
    expect(allowed).toMatchObject({ status: 200, body: { commentId: 7 } });
  });

  it("forgets credentials on sign-out and reports unknown routes", async () => {
    const { engine, secrets, session } = setup();
    await engine.call("POST", "/api/settings", { githubToken: "gho_me", geminiApiKey: "k" }, null);
    await engine.call("POST", "/api/auth/disconnect", {}, null);
    expect(session.map.size).toBe(0);
    expect(secrets.getItem("huddle60:githubToken")).toBeNull();
    expect((await engine.call("GET", "/api/nope", undefined, null)).status).toBe(404);
    expect((await engine.call("GET", "/api/auth/status", undefined, null)).body).toMatchObject({
      oauthEnabled: true,
    });
  });

  it("rebuilds cached managers after credentials change in another tab", async () => {
    const { engine, secrets, prefs, created } = setup();
    engine.setRememberCredentials(true);
    await engine.call(
      "POST",
      "/api/settings",
      { githubToken: "gho_first", geminiApiKey: "key" },
      null,
    );
    expect(engine.rememberCredentials).toBe(true);
    const other = new CredentialStorage(new MapStore(), prefs);
    expect(other.getItem("huddle60:githubToken")).toBe("gho_first");
    other.setItem("huddle60:githubToken", "gho_second");
    engine.invalidateCredentials();
    await engine.call("GET", "/api/session", undefined, null);
    expect(created.at(-1)?.config.githubToken).toBe("gho_second");
    other.clear();
    secrets.handleStorageChange("huddle60:sign-out");
    engine.invalidateCredentials();
    const result = await engine.call(
      "POST",
      "/api/issues/1/decisions",
      { action: "approve" },
      null,
    );
    expect(result.status).toBe(401);
    expect(created.at(-1)?.config.geminiApiKey).toBeUndefined();
  });
});

describe("ephemeral manager", () => {
  it("ignores server credentials and never shells out", async () => {
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "operator-token";
    try {
      const manager = new RealManager({ logger: silentLogger, ephemeral: true });
      await manager.initialize();
      const settings = await manager.getSettings();
      expect(settings.hasGithubToken).toBe(false);
      expect(settings.missing).toContain("missing_repo");
      await expect(manager.connectFromGhCli()).rejects.toMatchObject({ code: "E_CONFIG" });
    } finally {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
    }
  });
});
