import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GeminiModel } from "../adapters/gemini.js";
import { GitBranchEvidenceStore } from "../adapters/git-evidence.js";
import { connectRepository, octokitFromToken } from "../adapters/github.js";
import { silentLogger } from "../adapters/memory.js";
import { LABEL_COLORS } from "../app/local-app.js";
import { resolveGitHubToken, startLocalApp } from "../app/start.js";
import { canonicalJson } from "../core/canonical.js";
import { isAiDlcError } from "../core/errors.js";
import {
  PLAN_SCHEMA_VERSION,
  buildPlanId,
  computePlanHash,
  computeRequestDigest,
  modelPlanJsonSchema,
  parseModelPlan,
  type PlanRecord,
} from "../core/plan.js";
import { POLICY_PATH, LEGACY_POLICY_PATH, parsePolicy } from "../core/policy.js";
import { renderPlanComment } from "../core/render.js";
import {
  PLANNER_SYSTEM_INSTRUCTION,
  PROMPT_VERSION,
  buildPlannerPrompt,
} from "../planner/prompt.js";
import { systemClock } from "../ports.js";
import { renderAgentContext } from "../workflow/context.js";
import { WorkflowService } from "../workflow/service.js";

const USAGE = `Usage: huddle60 <command> [options]

Commands:
  ui [--host 127.0.0.1] [--port 4317] [--no-open]   Open the web app for PO and DEV (plans, approvals, context)
  init                            Create AI-DLC labels and the evidence branch (once per repository)
  context --issue <n> [--draft]   Print the approved baseline of an Issue for a coding agent
  init-evidence                   Create only the protected evidence branch
  validate-policy [file]          Validate ${POLICY_PATH} (default path) offline
  plan-preview "<request>"        Ask Gemini for a plan locally; nothing is written to GitHub

Options:
  --repo owner/name               Repository (default: GITHUB_REPOSITORY or git remote origin)

Environment:
  GH_TOKEN / GITHUB_TOKEN          GitHub token (default: \`gh auth token\`)
  GEMINI_API_KEY, AI_DLC_MODEL     Gemini settings for planning (macOS: Keychain item "huddle60-gemini")
`;

function detectRepo(explicit: string | undefined): [string, string] {
  let value = explicit ?? process.env.GITHUB_REPOSITORY;
  if (!value) {
    try {
      const remote = execFileSync("git", ["remote", "get-url", "origin"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      value = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/u.exec(remote)?.[1];
    } catch {
      value = undefined;
    }
  }
  const match = /^([\w.-]+)\/([\w.-]+)$/u.exec(value ?? "");
  if (!match) throw new Error("Cannot determine the repository. Pass --repo owner/name.");
  return [match[1] as string, match[2] as string];
}

function token(): string {
  return resolveGitHubToken();
}

async function context(
  repoArg: string | undefined,
  issueArg: string | undefined,
  draft: boolean,
): Promise<string> {
  const issueNumber = Number(issueArg);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0)
    throw new Error("--issue must be an Issue number.");
  const [owner, repo] = detectRepo(repoArg);
  const octokit = octokitFromToken(token());
  const github = await connectRepository(octokit, owner, repo);
  let policySource = await github.readFile(POLICY_PATH, await github.getDefaultBranch());
  if (!policySource) {
    policySource = await github.readFile(LEGACY_POLICY_PATH, await github.getDefaultBranch());
  }
  if (!policySource) throw new Error(`Missing ${POLICY_PATH} in ${owner}/${repo}.`);
  const policy = parsePolicy(policySource);
  const evidence = new GitBranchEvidenceStore(octokit, owner, repo, policy.evidence.branch);
  const workflow = new WorkflowService({
    github,
    evidence,
    clock: systemClock,
    logger: silentLogger,
    enabled: true,
  });
  return renderAgentContext({ github, evidence, workflow }, policy, issueNumber, draft);
}

function resolveTemplatesDir(): string {
  const distRelative = fileURLToPath(new URL("../templates", import.meta.url));
  if (existsSync(distRelative)) return distRelative;
  const srcRelative = fileURLToPath(new URL("../../templates", import.meta.url));
  if (existsSync(srcRelative)) return srcRelative;
  throw new Error("Cannot find templates directory.");
}

async function scaffoldTemplates(
  destDir: string,
  viewer: { id: number; login: string },
): Promise<{ created: string[]; skipped: string[] }> {
  const templatesDir = resolveTemplatesDir();
  const created: string[] = [];
  const skipped: string[] = [];

  async function walk(currentSrc: string, currentDest: string) {
    const entries = await readdir(currentSrc, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(currentSrc, entry.name);
      const destPath = join(currentDest, entry.name);

      if (entry.isDirectory()) {
        await walk(srcPath, destPath);
      } else if (entry.isFile()) {
        const rel = relative(destDir, destPath);
        if (existsSync(destPath)) {
          skipped.push(rel);
          continue;
        }
        await mkdir(dirname(destPath), { recursive: true });
        let content = await readFile(srcPath, "utf8");

        if (entry.name === "policy.yml") {
          content = content
            .replace(
              /roles:[\s\S]*?maintainer:\s*\[\]/u,
              `roles:\n  po:\n    - id: ${viewer.id}\n      login: ${viewer.login}\n  dev:\n    - id: ${viewer.id}\n      login: ${viewer.login}\n  maintainer:\n    - id: ${viewer.id}\n      login: ${viewer.login}`,
            )
            .replace(
              /project:\s*\n\s*owner:\s*your-org\s*\n\s*number:\s*1/u,
              `# project:\n#   owner: your-org\n#   number: 1`,
            );
        } else if (entry.name === "huddle60.yml" || entry.name === "ai-dlc.yml") {
          content = content.replace("your-org/huddle60@v0", "tadev999/huddle60@main");
        }

        await writeFile(destPath, content, "utf8");
        created.push(rel);
      }
    }
  }

  const githubSrc = join(templatesDir, ".github");
  if (existsSync(githubSrc)) {
    await walk(githubSrc, join(destDir, ".github"));
  }

  const agentsSrc = join(templatesDir, "AGENTS.md");
  const agentsDest = join(destDir, "AGENTS.md");
  if (existsSync(agentsSrc)) {
    if (existsSync(agentsDest)) {
      skipped.push("AGENTS.md");
    } else {
      const content = await readFile(agentsSrc, "utf8");
      await writeFile(agentsDest, content, "utf8");
      created.push("AGENTS.md");
    }
  }

  return { created, skipped };
}

async function initEvidence(repoArg: string | undefined): Promise<string> {
  const [owner, repo] = detectRepo(repoArg);
  const octokit = octokitFromToken(token());
  const github = await connectRepository(octokit, owner, repo);
  let policySource = await github.readFile(POLICY_PATH, await github.getDefaultBranch());
  if (!policySource) {
    policySource = await github.readFile(LEGACY_POLICY_PATH, await github.getDefaultBranch());
  }
  const branch = policySource ? parsePolicy(policySource).evidence.branch : "huddle60-evidence";
  const result = await new GitBranchEvidenceStore(octokit, owner, repo, branch).initialize();
  return result === "created"
    ? `✓ Created branch ${branch}. Protect it with a ruleset that blocks force-push and deletion.`
    : `✓ Branch ${branch} already exists.`;
}

async function init(repoArg: string | undefined): Promise<string> {
  const [owner, repo] = detectRepo(repoArg);
  const github = await connectRepository(octokitFromToken(token()), owner, repo);
  const viewer = await github.viewer();

  const createdLabels: string[] = [];
  for (const [name, meta] of Object.entries(LABEL_COLORS)) {
    if ((await github.ensureLabel({ name, ...meta })) === "created") createdLabels.push(name);
  }

  const lines = [
    `✓ Authenticated as ${viewer.login} (id: ${viewer.id}).`,
    createdLabels.length > 0
      ? `✓ Created labels: ${createdLabels.join(", ")}`
      : "✓ Labels already exist.",
    await initEvidence(repoArg),
  ];

  try {
    const { created, skipped } = await scaffoldTemplates(process.cwd(), viewer);
    if (created.length > 0) {
      lines.push(
        `✓ Scaffolding completed (${created.length} files created):`,
        ...created.map((f) => `    + ${f}`),
      );
    }
    if (skipped.length > 0) {
      lines.push(`ℹ Kept existing files (${skipped.length}): ${skipped.join(", ")}`);
    }

    lines.push(
      "",
      `Setup complete! Next steps:`,
      `  1. Commit and push templates to default branch:`,
      `     git add .github AGENTS.md && git commit -m "chore: setup huddle60" && git push`,
      `  2. Start the local app:`,
      `     npx huddle60 ui`,
    );
  } catch {
    const policy = await github.readFile(POLICY_PATH, await github.getDefaultBranch());
    if (!policy) {
      lines.push(
        `Next: commit templates/.github/** (policy with user id ${viewer.id}) to the default branch.`,
      );
    }
  }

  return lines.join("\n");
}

async function ui(
  repoArg: string | undefined,
  portArg: string | undefined,
  hostArg: string | undefined,
  open: boolean,
) {
  let owner: string | undefined;
  let repo: string | undefined;
  if (repoArg) {
    [owner, repo] = detectRepo(repoArg);
  }
  const port = Number(portArg ?? process.env.AI_DLC_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535)
    throw new Error("--port must be between 1024 and 65535.");
  const host = hostArg ?? process.env.HOST ?? "127.0.0.1";
  await startLocalApp({ owner, repo, host, port, open });
}

async function validatePolicy(file: string | undefined): Promise<string> {
  const policy = parsePolicy(await readFile(file ?? POLICY_PATH, "utf8"));
  return `Policy is valid: ${policy.roles.po.length} PO, ${policy.roles.dev.length} DEV, ${policy.roles.maintainer.length} maintainer.`;
}

async function planPreview(request: string | undefined): Promise<string> {
  if (!request)
    throw new Error('Pass the request text, e.g. huddle60 plan-preview "Login with Google".');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Set GEMINI_API_KEY to call Gemini.");
  const model = new GeminiModel({
    apiKey,
    model: process.env.AI_DLC_MODEL ?? "gemini-3.8-flash",
    timeoutMs: 120_000,
    maxRetries: 1,
  });
  const result = await model.generateJson({
    system: PLANNER_SYSTEM_INSTRUCTION,
    user: buildPlannerPrompt({ title: request.slice(0, 80), request, clarifications: [] }),
    jsonSchema: modelPlanJsonSchema(),
  });
  const plan = parseModelPlan(result.text, { maxNodes: 60 });
  const digest = computeRequestDigest(request.slice(0, 80), request);
  const planHash = computePlanHash(digest, plan);
  const now = systemClock.now();
  const record: PlanRecord = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: buildPlanId(0, 1, planHash),
    revision: 1,
    status: "draft",
    source: {
      repositoryId: 0,
      owner: "local",
      repo: "preview",
      issueNumber: 0,
      issueNodeId: "",
      requestDigest: digest,
    },
    model: `${model.modelId} (${PROMPT_VERSION})`,
    plan,
    planHash,
    clarifications: [],
    requestedBy: 0,
    createdAt: now.toISOString(),
    expiresAt: now.toISOString(),
  };
  return `${renderPlanComment(record)}\n\n<!-- tokens in=${result.usage.inputTokens} out=${result.usage.outputTokens} -->\n${process.env.AI_DLC_DEBUG ? canonicalJson(plan) : ""}`;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      issue: { type: "string" },
      draft: { type: "boolean", default: false },
      host: { type: "string" },
      port: { type: "string" },
      "no-open": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, argument] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }
  let output: string;
  switch (command) {
    case "ui":
      await ui(values.repo, values.port, values.host, !values["no-open"]);
      return;
    case "init":
      output = await init(values.repo);
      break;
    case "context":
      output = await context(values.repo, values.issue, values.draft ?? false);
      break;
    case "init-evidence":
      output = await initEvidence(values.repo);
      break;
    case "validate-policy":
      output = await validatePolicy(argument);
      break;
    case "plan-preview":
      output = await planPreview(argument);
      break;
    default:
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
  process.stdout.write(`${output}\n`);
}

main().catch((error: unknown) => {
  const message = isAiDlcError(error)
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
  process.stderr.write(`huddle60: ${message}\n`);
  process.exitCode = 1;
});
