import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Huddle60Config {
  githubToken?: string;
  githubDisconnected?: boolean;
  repo?: string; // "owner/repo"
  recentRepos?: string[]; // list of repositories
  geminiApiKey?: string;
  geminiModel?: string;
  sessionToken?: string;
}

export function getConfigDir(): string {
  return process.env.HUDDLE60_CONFIG_DIR ?? join(homedir(), ".config", "huddle60");
}

export function getConfigPath(tenant?: string): string {
  if (tenant && tenant.trim().length > 0 && tenant !== "default" && tenant !== "www") {
    const safeTenant = tenant.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    return join(getConfigDir(), "tenants", `${safeTenant}.json`);
  }
  return join(getConfigDir(), "config.json");
}

export function readConfigSync(tenant?: string): Huddle60Config {
  const filePath = getConfigPath(tenant);
  try {
    if (!existsSync(filePath)) {
      if (tenant) {
        const global = readConfigSync();
        return {
          geminiApiKey: global.geminiApiKey,
          geminiModel: global.geminiModel,
        };
      }
      return {};
    }
    const content = readFileSync(filePath, "utf8");
    const data = JSON.parse(content) as Huddle60Config;
    if (tenant) {
      const global = readConfigSync();
      return {
        geminiApiKey: global.geminiApiKey,
        geminiModel: global.geminiModel,
        ...data,
      };
    }
    return data;
  } catch {
    return {};
  }
}

export async function readConfig(tenant?: string): Promise<Huddle60Config> {
  const filePath = getConfigPath(tenant);
  try {
    if (!existsSync(filePath)) {
      if (tenant) {
        const global = await readConfig();
        return {
          geminiApiKey: global.geminiApiKey,
          geminiModel: global.geminiModel,
        };
      }
      return {};
    }
    const content = await readFile(filePath, "utf8");
    const data = JSON.parse(content) as Huddle60Config;
    if (tenant) {
      const global = await readConfig();
      return {
        geminiApiKey: global.geminiApiKey,
        geminiModel: global.geminiModel,
        ...data,
      };
    }
    return data;
  } catch {
    return {};
  }
}

export async function writeConfig(
  patch: Partial<Huddle60Config>,
  tenant?: string,
): Promise<Huddle60Config> {
  const filePath = getConfigPath(tenant);
  let current: Huddle60Config = {};
  try {
    if (existsSync(filePath)) {
      current = JSON.parse(await readFile(filePath, "utf8")) as Huddle60Config;
    }
  } catch {
    current = {};
  }
  const next: Huddle60Config = { ...current };

  for (const [key, value] of Object.entries(patch) as Array<[keyof Huddle60Config, unknown]>) {
    if (value === undefined) {
      continue;
    } else if (key === "recentRepos") {
      if (Array.isArray(value)) {
        next.recentRepos = Array.from(
          new Set(value.filter((r): r is string => typeof r === "string" && r.trim().length > 0)),
        ).slice(0, 20);
      }
    } else if (key === "githubDisconnected") {
      if (Boolean(value)) {
        next.githubDisconnected = true;
      } else {
        delete next.githubDisconnected;
      }
    } else if (key === "githubToken") {
      if (typeof value === "string" && value.trim().length > 0) {
        next.githubToken = value.trim();
        delete next.githubDisconnected;
      } else {
        delete next.githubToken;
        next.githubDisconnected = true;
      }
    } else if (typeof value === "string") {
      if (value.trim() === "") {
        delete next[key];
      } else {
        next[key] = value.trim();
      }
    }
  }

  // Ensure current repo is always included at top of recentRepos
  if (next.repo && next.repo.trim().length > 0) {
    const repos = new Set([next.repo, ...(next.recentRepos ?? [])]);
    next.recentRepos = Array.from(repos).slice(0, 20);
  }

  const dir = tenant ? join(getConfigDir(), "tenants") : getConfigDir();
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, JSON.stringify(next, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });

  return next;
}

export function detectGitRemoteRepo(cwd = process.cwd()): string | undefined {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/u.exec(remote)?.[1];
  } catch {
    return undefined;
  }
}

export function getGhCliToken(): string | undefined {
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export function getMacKeychainGeminiKey(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const key = execFileSync("security", ["find-generic-password", "-s", "huddle60-gemini", "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return key || undefined;
  } catch {
    return undefined;
  }
}

export function parseRepoString(input: string | undefined): { owner: string; repo: string } | null {
  if (!input) return null;
  const match = /^([\w.-]+)\/([\w.-]+)$/u.exec(input.trim());
  if (!match) return null;
  return { owner: match[1] as string, repo: match[2] as string };
}

export function maskSecret(secret: string | undefined | null): string {
  if (!secret) return "";
  if (secret.length <= 8) return "••••";
  return `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}
