import { appendFile, readFile } from "node:fs/promises";
import { GitBranchEvidenceStore } from "../adapters/git-evidence.js";
import { connectRepository, octokitFromToken } from "../adapters/github.js";
import { createJsonLogger } from "../adapters/memory.js";
import { POLICY_PATH, LEGACY_POLICY_PATH, parsePolicy } from "../core/policy.js";
import { systemClock } from "../ports.js";
import { WorkflowService } from "../workflow/service.js";

/** Runs inside GitHub Actions. Never checks out or executes pull request code. */
async function main(): Promise<void> {
  const eventName = requireEnv("GITHUB_EVENT_NAME");
  const payload = JSON.parse(await readFile(requireEnv("GITHUB_EVENT_PATH"), "utf8")) as {
    action?: string;
    issue?: { number: number; pull_request?: unknown };
    comment?: { id: number };
    pull_request?: { number: number };
    sender?: { type?: string };
  };
  const [owner, repo] = requireEnv("GITHUB_REPOSITORY").split("/") as [string, string];
  const logger = createJsonLogger({ component: "huddle60-action", event: eventName });
  const token =
    process.env.HUDDLE60_TOKEN ||
    process.env.AI_DLC_TOKEN ||
    requireEnv("HUDDLE60_TOKEN or AI_DLC_TOKEN");
  const octokit = octokitFromToken(token);
  const github = await connectRepository(octokit, owner, repo);
  let policySource = await github.readFile(POLICY_PATH, await github.getDefaultBranch());
  if (!policySource) {
    policySource = await github.readFile(LEGACY_POLICY_PATH, await github.getDefaultBranch());
  }
  const branch = policySource ? parsePolicy(policySource).evidence.branch : "huddle60-evidence";
  const workflow = new WorkflowService({
    github,
    evidence: new GitBranchEvidenceStore(octokit, owner, repo, branch),
    clock: systemClock,
    logger,
    enabled: process.env.HUDDLE60_ENABLED !== "false" && process.env.AI_DLC_ENABLED !== "false",
  });

  if (eventName === "issue_comment") {
    if (
      !payload.issue ||
      payload.issue.pull_request ||
      !payload.comment ||
      payload.sender?.type === "Bot"
    )
      return;
    const action = payload.action as "created" | "edited" | "deleted";
    await workflow.handleComment(payload.issue.number, payload.comment.id, action);
    return;
  }
  if (eventName === "pull_request_target" && payload.pull_request) {
    const result = await workflow.checkPullRequest(payload.pull_request.number);
    await summary([
      `### huddle60/baseline: ${result.state}`,
      "",
      result.description,
      ...result.details.map((line) => `> ${line}`),
    ]);
    return;
  }
  logger.info("event ignored");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

async function summary(lines: string[]): Promise<void> {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) await appendFile(file, `${lines.join("\n")}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `ai-dlc action failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
