import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createJsonLogger } from "../adapters/memory.js";
import { readConfigSync } from "../core/config.js";
import { AiDlcError } from "../core/errors.js";
import { createAppHandler } from "./server.js";

/** GitHub token of the person running the app: env first, then config.json, then the GitHub CLI. */
export function resolveGitHubToken(): string {
  const fromEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  const fromConfig = readConfigSync().githubToken;
  if (fromConfig) return fromConfig;
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (token) return token;
  } catch {
    // fall through
  }
  throw new AiDlcError(
    "E_CONFIG",
    "No GitHub token. Run `gh auth login`, export GH_TOKEN, or configure in huddle60 settings.",
  );
}

/** Gemini key from env, config.json, or the macOS Keychain item `huddle60-gemini`. Optional. */
export function resolveGeminiKey(): string | null {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const fromConfig = readConfigSync().geminiApiKey;
  if (fromConfig) return fromConfig;
  if (process.platform !== "darwin") return null;
  try {
    const key = execFileSync("security", ["find-generic-password", "-s", "huddle60-gemini", "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return key || null;
  } catch {
    return null;
  }
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  execFile(command, args as string[], () => undefined);
}

export interface StartOptions {
  owner?: string;
  repo?: string;
  host?: string;
  port: number;
  open: boolean;
  uiDir?: string;
}

export async function startLocalApp(options: StartOptions): Promise<void> {
  const logger = createJsonLogger({ component: "huddle60-ui" });
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const uiDir = options.uiDir ?? fileURLToPath(new URL("../ui/", import.meta.url));

  const explicitRepo =
    options.owner && options.repo ? `${options.owner}/${options.repo}` : undefined;
  const server = createServer(createAppHandler({ host, port: options.port, uiDir, logger }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, resolve);
  });
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const url = explicitRepo
    ? `http://${displayHost}:${options.port}/${explicitRepo}`
    : `http://${displayHost}:${options.port}/app`;

  process.stdout.write(
    [
      "huddle60 · browser engine (local and SaaS share the same runtime)",
      "",
      `  ${url}`,
      "",
      "Sign in and configure keys in the browser. Press Ctrl+C to stop.",
      "",
    ].join("\n"),
  );
  if (options.open) openBrowser(url);
  await new Promise<void>((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
