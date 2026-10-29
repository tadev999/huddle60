import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { GeminiModel } from "../adapters/gemini.js";
import { GitBranchEvidenceStore } from "../adapters/git-evidence.js";
import { connectRepository, octokitFromToken } from "../adapters/github.js";
import { createJsonLogger } from "../adapters/memory.js";
import { AiDlcError } from "../core/errors.js";
import { POLICY_PATH, parsePolicy } from "../core/policy.js";
import { systemClock } from "../ports.js";
import { LocalApp } from "./local-app.js";
import { createAppHandler } from "./server.js";

/** GitHub token of the person running the app: env first, then the GitHub CLI. */
export function resolveGitHubToken(): string {
  const fromEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (token) return token;
  } catch {
    // fall through
  }
  throw new AiDlcError("E_CONFIG", "No GitHub token. Run `gh auth login`, or export GH_TOKEN.");
}

/** Gemini key from env, or the macOS Keychain item `huddle60-gemini`. Optional. */
export function resolveGeminiKey(): string | null {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
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
  owner: string;
  repo: string;
  port: number;
  open: boolean;
  uiDir?: string;
}

export async function startLocalApp(options: StartOptions): Promise<void> {
  const logger = createJsonLogger({ component: "huddle60-ui" });
  const octokit = octokitFromToken(resolveGitHubToken());
  const github = await connectRepository(octokit, options.owner, options.repo);
  const policySource = await github.readFile(POLICY_PATH, await github.getDefaultBranch());
  if (!policySource)
    throw new AiDlcError(
      "E_POLICY_INVALID",
      `Missing ${POLICY_PATH}. Run \`huddle60 init\` first.`,
    );
  const policy = parsePolicy(policySource);
  const geminiKey = resolveGeminiKey();
  const app = new LocalApp({
    github,
    evidence: new GitBranchEvidenceStore(
      octokit,
      options.owner,
      options.repo,
      policy.evidence.branch,
    ),
    model: geminiKey
      ? new GeminiModel({
          apiKey: geminiKey,
          model: process.env.AI_DLC_MODEL ?? "gemini-2.5-flash",
          timeoutMs: 120_000,
          maxRetries: 1,
        })
      : null,
    clock: systemClock,
    logger,
  });
  const viewer = await app.viewer();
  const token = randomBytes(32).toString("base64url");
  const uiDir = options.uiDir ?? fileURLToPath(new URL("../ui/", import.meta.url));
  const server = createServer(createAppHandler({ app, token, port: options.port, uiDir, logger }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${options.port}/#token=${token}`;
  process.stdout.write(
    [
      `huddle60 · AI-DLC for ${options.owner}/${options.repo} (signed in as ${viewer.login})`,
      `Planner: ${geminiKey ? "Gemini ready" : "disabled (set GEMINI_API_KEY)"}`,
      "",
      `  ${url}`,
      "",
      "Keep this URL private: it carries the session token. Press Ctrl+C to stop.",
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
