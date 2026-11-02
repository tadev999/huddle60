import { applyConfigPatch, type Huddle60Config } from "../core/config.js";
import type { Logger } from "../ports.js";
import { LocalAppManager } from "../app/manager.js";
import { createRoutes, dispatch, errorResponse, HttpError, type RouteDeps } from "../app/routes.js";
import type { CredentialStorage, KeyValueStore } from "./credentials.js";
export type { KeyValueStore } from "./credentials.js";

export interface BrowserEngineOptions {
  secrets: CredentialStorage;
  /** Non-secret preferences (repo, model, recent repos): localStorage. */
  prefs: KeyValueStore;
  oauthEnabled: boolean;
  logger?: Logger;
  createManager?: (tenant: string | null, config: Huddle60Config) => Promise<LocalAppManager>;
}

export interface EngineResponse {
  status: number;
  body: unknown;
}

const SECRET_KEYS = ["githubToken", "geminiApiKey"] as const;
const PREF_KEYS = ["repo", "geminiModel", "recentRepos"] as const;

const consoleLogger: Logger = {
  info: () => {},
  warn: (message, fields) => console.warn(message, fields ?? {}),
  error: (message, fields) => console.error(message, fields ?? {}),
};

/**
 * The local and SaaS backend, running inside the visitor's browser.
 * GitHub and Gemini data calls go directly to their APIs, not through the UI server.
 */
export function createBrowserEngine(options: BrowserEngineOptions) {
  const { secrets, prefs } = options;
  const logger = options.logger ?? consoleLogger;
  const managers = new Map<string, LocalAppManager>();
  let credentialVersion = 0;
  const prefKey = (tenant: string | null, key: string) => `huddle60:${tenant ?? "_"}:${key}`;

  const loadConfig = (tenant: string | null): Huddle60Config => {
    const config: Huddle60Config = {};
    for (const key of SECRET_KEYS) {
      const value = secrets.getItem(`huddle60:${key}`);
      if (value) config[key] = value;
    }
    const repo = prefs.getItem(prefKey(tenant, "repo"));
    if (repo) config.repo = repo;
    const model = prefs.getItem(prefKey(tenant, "geminiModel"));
    if (model) config.geminiModel = model;
    try {
      const recent = JSON.parse(prefs.getItem(prefKey(tenant, "recentRepos")) ?? "[]") as unknown;
      if (Array.isArray(recent)) config.recentRepos = recent.filter((r) => typeof r === "string");
    } catch {
      // ignore malformed preferences
    }
    return config;
  };

  const saveConfig = (tenant: string | null, config: Huddle60Config) => {
    for (const key of SECRET_KEYS) {
      const value = config[key];
      if (value) secrets.setItem(`huddle60:${key}`, value);
      else secrets.removeItem(`huddle60:${key}`);
    }
    for (const key of PREF_KEYS) {
      const value = config[key];
      if (value === undefined || (Array.isArray(value) && value.length === 0))
        prefs.removeItem(prefKey(tenant, key));
      else
        prefs.setItem(
          prefKey(tenant, key),
          typeof value === "string" ? value : JSON.stringify(value),
        );
    }
  };

  const createManager =
    options.createManager ??
    (async (tenant: string | null, config: Huddle60Config) => {
      const mgr = new LocalAppManager({
        ...(tenant ? { tenant } : {}),
        logger,
        ephemeral: true,
        initialConfig: config,
      });
      await mgr.initialize();
      return mgr;
    });

  const getManagerFor = async (tenant: string | null): Promise<LocalAppManager> => {
    const key = tenant ?? "";
    let mgr = managers.get(key);
    if (!mgr) {
      const version = credentialVersion;
      mgr = await createManager(tenant, loadConfig(tenant));
      if (version !== credentialVersion)
        throw new HttpError(409, "E_AUTH_CHANGED", "Credentials changed. Please retry.");
      managers.set(key, mgr);
    }
    return mgr;
  };

  const deps: RouteDeps = {
    getManagerFor,
    getAppFor: async (tenant) => (await getManagerFor(tenant)).app,
    onSettings: (tenant, patch) => {
      saveConfig(tenant, applyConfigPatch(loadConfig(tenant), patch));
      // Other tenants' managers hold the old token; rebuild them on next use.
      if (patch.githubToken !== undefined || patch.geminiApiKey !== undefined) {
        credentialVersion++;
        for (const key of [...managers.keys()]) if (key !== (tenant ?? "")) managers.delete(key);
      }
    },
    onDisconnect: async () => {
      secrets.clear();
      credentialVersion++;
      managers.clear();
      return { ok: true };
    },
    oauthEnabled: () => options.oauthEnabled,
    requireSignIn: true,
  };
  const routes = createRoutes(deps);

  return {
    get rememberCredentials() {
      return secrets.remember;
    },
    setRememberCredentials(remember: boolean) {
      secrets.setRemember(remember);
    },
    invalidateCredentials() {
      credentialVersion++;
      managers.clear();
    },
    async call(
      method: string,
      path: string,
      body: unknown,
      tenant: string | null,
    ): Promise<EngineResponse> {
      try {
        const url = new URL(path, "https://engine.invalid");
        const result = await dispatch(routes, deps, { method, url, body, tenant });
        return { status: 200, body: JSON.parse(JSON.stringify(result ?? null)) as unknown };
      } catch (error) {
        return errorResponse(error, logger, path);
      }
    },
  };
}

export type BrowserEngine = ReturnType<typeof createBrowserEngine>;
