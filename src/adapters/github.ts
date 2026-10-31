import { createAppAuth } from "@octokit/auth-app";
import { retry } from "@octokit/plugin-retry";
import { Octokit } from "@octokit/rest";
import { AiDlcError } from "../core/errors.js";
import type {
  Actor,
  CommentData,
  CommitState,
  IssueData,
  LocalGitHubPort,
  PullRequestData,
  RepoRef,
  WorkflowRunData,
} from "../ports.js";

const RetryingOctokit = Octokit.plugin(retry);
export type GitHubClient = InstanceType<typeof RetryingOctokit>;

const USER_AGENT = "huddle60/0.1.0";

const defaultLog = process.env.AI_DLC_DEBUG
  ? undefined
  : {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };

export function octokitFromToken(token: string): GitHubClient {
  return new RetryingOctokit({ auth: token, userAgent: USER_AGENT, log: defaultLog });
}

export function octokitForInstallation(
  appId: string,
  privateKey: string,
  installationId: number,
): GitHubClient {
  return new RetryingOctokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey, installationId },
    userAgent: USER_AGENT,
    log: defaultLog,
  });
}

export function isStatus(error: unknown, ...statuses: number[]): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    statuses.includes((error as { status?: number }).status ?? -1)
  );
}

interface RawUser {
  id: number;
  login: string;
  type: string;
}

interface RawIssue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body?: string | null;
  state: string;
  state_reason?: string | null;
  labels: Array<string | { name?: string }>;
  user: RawUser | null;
  pull_request?: unknown;
}

function toActor(user: RawUser | null): IssueData["author"] {
  return user
    ? { id: user.id, login: user.login, type: user.type }
    : { id: 0, login: "ghost", type: "User" };
}

function toIssue(raw: RawIssue): IssueData {
  return {
    id: raw.id,
    nodeId: raw.node_id,
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state === "closed" ? "closed" : "open",
    stateReason: raw.state_reason ?? null,
    labels: raw.labels
      .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
      .filter(Boolean),
    author: toActor(raw.user),
    isPullRequest: raw.pull_request !== undefined && raw.pull_request !== null,
  };
}

export async function connectRepository(
  octokit: GitHubClient,
  owner: string,
  repo: string,
): Promise<OctokitGitHub> {
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return new OctokitGitHub(
    octokit,
    { owner, repo, repositoryId: data.id },
    data.default_branch,
    data.permissions,
  );
}

export class OctokitGitHub implements LocalGitHubPort {
  private readonly projectIds = new Map<string, string>();

  constructor(
    readonly octokit: GitHubClient,
    readonly repo: RepoRef,
    private defaultBranch?: string,
    readonly permissions?: {
      admin?: boolean;
      maintain?: boolean;
      push?: boolean;
      triage?: boolean;
      pull?: boolean;
    },
  ) {}

  canWrite(): boolean {
    return Boolean(this.permissions?.admin || this.permissions?.push || this.permissions?.maintain);
  }

  private get base() {
    return { owner: this.repo.owner, repo: this.repo.repo };
  }

  async getDefaultBranch(): Promise<string> {
    if (!this.defaultBranch) {
      const { data } = await this.octokit.rest.repos.get(this.base);
      this.defaultBranch = data.default_branch;
    }
    return this.defaultBranch;
  }

  async readFile(path: string, ref?: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        ...this.base,
        path,
        ...(ref ? { ref } : {}),
      });
      if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return null;
      return Buffer.from(data.content, "base64").toString("utf8");
    } catch (error) {
      if (isStatus(error, 404)) return null;
      throw error;
    }
  }

  async getIssue(number: number): Promise<IssueData> {
    try {
      const { data } = await this.octokit.rest.issues.get({ ...this.base, issue_number: number });
      return toIssue(data as RawIssue);
    } catch (error) {
      if (isStatus(error, 404, 410))
        throw new AiDlcError("E_GITHUB_API", `Issue #${number} was not found.`);
      throw error;
    }
  }

  async getCodebaseContext(): Promise<string> {
    try {
      const branch = await this.getDefaultBranch();
      const parts: string[] = [`Repository: ${this.repo.owner}/${this.repo.repo} (default branch: ${branch})`];

      // 1. Fetch file tree
      try {
        const { data } = await this.octokit.rest.git.getTree({
          ...this.base,
          tree_sha: branch,
          recursive: "1",
        });
        if (data.tree && Array.isArray(data.tree)) {
          const ignorePrefixes = [
            ".git/",
            "node_modules/",
            "dist/",
            "build/",
            ".next/",
            ".output/",
            "coverage/",
            ".gemini/",
            ".idea/",
            ".vscode/",
          ];
          const files = data.tree
            .filter((item) => item.type === "blob" && item.path)
            .map((item) => item.path as string)
            .filter((path) => !ignorePrefixes.some((prefix) => path.startsWith(prefix)))
            .filter(
              (path) =>
                !path.endsWith(".png") &&
                !path.endsWith(".jpg") &&
                !path.endsWith(".jpeg") &&
                !path.endsWith(".ico") &&
                !path.endsWith(".svg") &&
                !path.endsWith(".lock") &&
                !path.endsWith("-lock.json") &&
                !path.endsWith(".map"),
            )
            .slice(0, 150);

          if (files.length > 0) {
            parts.push(`Key files in repository (${files.length} files):\n${files.map((f) => `- ${f}`).join("\n")}`);
          }
        }
      } catch {
        // Fall back gracefully
      }

      // 2. Fetch package.json if exists
      const pkgJson = await this.readFile("package.json", branch);
      if (pkgJson) {
        try {
          const parsed = JSON.parse(pkgJson) as Record<string, unknown>;
          const manifestSummary: Record<string, unknown> = {};
          if (parsed.name) manifestSummary.name = parsed.name;
          if (parsed.description) manifestSummary.description = parsed.description;
          if (parsed.dependencies && typeof parsed.dependencies === "object") {
            manifestSummary.dependencies = Object.keys(parsed.dependencies);
          }
          if (parsed.devDependencies && typeof parsed.devDependencies === "object") {
            manifestSummary.devDependencies = Object.keys(parsed.devDependencies);
          }
          parts.push(`package.json summary:\n${JSON.stringify(manifestSummary, null, 2)}`);
        } catch {}
      }

      // 3. Fetch README.md if exists (first 1000 chars)
      const readme = await this.readFile("README.md", branch);
      if (readme) {
        parts.push(`README preview:\n${readme.slice(0, 1000).trim()}...`);
      }

      return parts.join("\n\n");
    } catch {
      return `Repository: ${this.repo.owner}/${this.repo.repo}`;
    }
  }

  async getComment(id: number): Promise<CommentData | null> {
    try {
      const { data } = await this.octokit.rest.issues.getComment({ ...this.base, comment_id: id });
      return { id: data.id, body: data.body ?? "", author: toActor(data.user as RawUser | null) };
    } catch (error) {
      if (isStatus(error, 404)) return null;
      throw error;
    }
  }

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<IssueData> {
    const { data } = await this.octokit.rest.issues.create({ ...this.base, ...input });
    return toIssue(data as RawIssue);
  }

  async updateIssue(
    issueNumber: number,
    patch: { title?: string; body?: string },
  ): Promise<IssueData> {
    const { data } = await this.octokit.rest.issues.update({
      ...this.base,
      issue_number: issueNumber,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
    });
    return toIssue(data as RawIssue);
  }

  async listIssuesWithLabel(label: string): Promise<IssueData[]> {
    const items = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      ...this.base,
      labels: label,
      state: "all",
      per_page: 100,
    });
    return (items as RawIssue[]).map(toIssue).filter((issue) => !issue.isPullRequest);
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    await this.octokit.rest.issues.addLabels({ ...this.base, issue_number: issueNumber, labels });
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.rest.issues.removeLabel({
        ...this.base,
        issue_number: issueNumber,
        name: label,
      });
    } catch (error) {
      if (!isStatus(error, 404)) throw error;
    }
  }

  async upsertComment(issueNumber: number, marker: string, body: string): Promise<void> {
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      ...this.base,
      issue_number: issueNumber,
      per_page: 100,
    });
    // Only our own bot comments are updated; users could paste a marker into theirs.
    const existing = comments.find(
      (comment) => comment.user?.type === "Bot" && (comment.body ?? "").includes(marker),
    );
    const text = body.includes(marker) ? body : `${body}\n${marker}`;
    if (existing) {
      await this.octokit.rest.issues.updateComment({
        ...this.base,
        comment_id: existing.id,
        body: text,
      });
    } else {
      await this.octokit.rest.issues.createComment({
        ...this.base,
        issue_number: issueNumber,
        body: text,
      });
    }
  }

  async closeIssue(issueNumber: number, reason: "completed" | "not_planned"): Promise<void> {
    await this.octokit.rest.issues.update({
      ...this.base,
      issue_number: issueNumber,
      state: "closed",
      state_reason: reason,
    });
  }

  async addSubIssue(parentNumber: number, childId: number): Promise<"linked" | "unsupported"> {
    try {
      await this.octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", {
        ...this.base,
        issue_number: parentNumber,
        sub_issue_id: childId,
      });
      return "linked";
    } catch (error) {
      if (isStatus(error, 404)) return "unsupported";
      throw error;
    }
  }

  private async projectId(owner: string, number: number): Promise<string> {
    const key = `${owner}/${number}`;
    const cached = this.projectIds.get(key);
    if (cached) return cached;
    const query = `query($owner: String!, $number: Int!) {
      organization(login: $owner) { projectV2(number: $number) { id } }
    }`;
    let id: string | undefined;
    try {
      const result = await this.octokit.graphql<{
        organization: { projectV2: { id: string } | null } | null;
      }>(query, { owner, number });
      id = result.organization?.projectV2?.id;
    } catch {
      const userQuery = `query($owner: String!, $number: Int!) { user(login: $owner) { projectV2(number: $number) { id } } }`;
      const result = await this.octokit.graphql<{
        user: { projectV2: { id: string } | null } | null;
      }>(userQuery, { owner, number });
      id = result.user?.projectV2?.id;
    }
    if (!id)
      throw new AiDlcError("E_GITHUB_API", `Project ${key} was not found or is not accessible.`);
    this.projectIds.set(key, id);
    return id;
  }

  async addToProject(
    project: { owner: string; number: number },
    contentNodeId: string,
  ): Promise<void> {
    const projectId = await this.projectId(project.owner, project.number);
    await this.octokit.graphql(
      `mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
      }`,
      { projectId, contentId: contentNodeId },
    );
  }

  async getPullRequest(number: number): Promise<PullRequestData> {
    const { data } = await this.octokit.rest.pulls.get({ ...this.base, pull_number: number });
    return {
      number: data.number,
      body: data.body ?? "",
      headSha: data.head.sha,
      labels: data.labels.map((label) => label.name),
    };
  }

  async listPullRequestFiles(number: number): Promise<string[]> {
    const files = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
      ...this.base,
      pull_number: number,
      per_page: 100,
    });
    return files.flatMap((file) =>
      file.previous_filename ? [file.filename, file.previous_filename] : [file.filename],
    );
  }

  async setCommitStatus(
    sha: string,
    status: { state: CommitState; context: string; description: string },
  ): Promise<void> {
    await this.octokit.rest.repos.createCommitStatus({ ...this.base, sha, ...status });
  }

  async getWorkflowRun(runId: number): Promise<WorkflowRunData | null> {
    try {
      const { data } = await this.octokit.rest.actions.getWorkflowRun({
        ...this.base,
        run_id: runId,
      });
      return toRun(data);
    } catch (error) {
      if (isStatus(error, 404)) return null;
      throw error;
    }
  }

  async viewer(): Promise<Actor> {
    const { data } = await this.octokit.rest.users.getAuthenticated();
    return { id: data.id, login: data.login, type: data.type };
  }

  async listOpenIssuesWithLabel(label: string): Promise<IssueData[]> {
    const items = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      ...this.base,
      labels: label,
      state: "open",
      per_page: 100,
    });
    return (items as RawIssue[]).map(toIssue).filter((issue) => !issue.isPullRequest);
  }

  async createComment(issueNumber: number, body: string): Promise<CommentData> {
    const { data } = await this.octokit.rest.issues.createComment({
      ...this.base,
      issue_number: issueNumber,
      body,
    });
    return { id: data.id, body: data.body ?? "", author: toActor(data.user as RawUser | null) };
  }

  async findBotComment(issueNumber: number, marker: string): Promise<CommentData | null> {
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      ...this.base,
      issue_number: issueNumber,
      per_page: 100,
    });
    const found = comments
      .filter((comment) => comment.user?.type === "Bot" && (comment.body ?? "").includes(marker))
      .at(-1);
    return found
      ? { id: found.id, body: found.body ?? "", author: toActor(found.user as RawUser | null) }
      : null;
  }

  async listSuccessfulRuns(
    workflowPath: string,
    branch: string,
    limit: number,
  ): Promise<WorkflowRunData[]> {
    try {
      const { data } = await this.octokit.rest.actions.listWorkflowRuns({
        ...this.base,
        workflow_id: workflowPath.split("/").pop() ?? workflowPath,
        branch,
        event: "push",
        status: "success",
        per_page: limit,
      });
      return data.workflow_runs.map(toRun);
    } catch (error) {
      if (isStatus(error, 404)) return [];
      throw error;
    }
  }

  async ensureLabel(label: {
    name: string;
    color: string;
    description: string;
  }): Promise<"created" | "exists"> {
    try {
      await this.octokit.rest.issues.createLabel({ ...this.base, ...label });
      return "created";
    } catch (error) {
      if (isStatus(error, 422)) return "exists";
      throw error;
    }
  }
}

interface RawRun {
  id: number;
  run_attempt?: number;
  path: string;
  event: string;
  head_branch: string | null;
  head_sha: string;
  status: string | null;
  conclusion: string | null;
  repository: { id: number };
}

function toRun(data: RawRun): WorkflowRunData {
  return {
    id: data.id,
    runAttempt: data.run_attempt ?? 1,
    path: data.path.split("@")[0] ?? data.path,
    event: data.event,
    headBranch: data.head_branch,
    headSha: data.head_sha,
    status: data.status,
    conclusion: data.conclusion,
    repositoryId: data.repository.id,
  };
}
