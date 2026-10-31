import type {
  Actor,
  AttachmentPart,
  CommentData,
  CommitState,
  IssueData,
  LocalGitHubPort,
  ModelPort,
  ModelUsage,
  PullRequestData,
  RepoRef,
  WorkflowRunData,
} from "../../src/ports.js";
import { POLICY_PATH } from "../../src/core/policy.js";

export const PO: Actor = { id: 1001, login: "po-anna", type: "User" };
export const DEV: Actor = { id: 2001, login: "dev-binh", type: "User" };
export const DEV2: Actor = { id: 2002, login: "dev-chi", type: "User" };
export const OUTSIDER: Actor = { id: 9001, login: "visitor", type: "User" };
export const BOT: Actor = { id: 5001, login: "ai-dlc[bot]", type: "Bot" };

export const POLICY_YAML = `version: 1
roles:
  po:
    - id: ${PO.id}
      login: ${PO.login}
  dev:
    - id: ${DEV.id}
      login: ${DEV.login}
    - id: ${DEV2.id}
      login: ${DEV2.login}
project:
  owner: acme
  number: 3
sensitive_paths:
  - "src/auth/**"
acceptance:
  build_workflows:
    - .github/workflows/build.yml
`;

interface StoredComment extends CommentData {
  issueNumber: number;
}

/** In-memory GitHub with hooks to inject failures. */
export class FakeGitHub implements LocalGitHubPort {
  /** The signed-in user of the local app. */
  viewerActor: Actor = PO;
  readonly labels = new Set<string>();
  readonly repo: RepoRef = { owner: "acme", repo: "shop", repositoryId: 777 };
  readonly files = new Map<string, string>([[POLICY_PATH, POLICY_YAML]]);
  readonly issues = new Map<number, IssueData>();
  readonly comments = new Map<number, StoredComment>();
  readonly statuses: Array<{
    sha: string;
    state: CommitState;
    context: string;
    description: string;
  }> = [];
  readonly subIssues: Array<{ parent: number; childId: number }> = [];
  readonly projectItems: string[] = [];
  readonly pullRequests = new Map<number, PullRequestData & { files: string[] }>();
  readonly runs = new Map<number, WorkflowRunData>();
  createIssueCalls = 0;
  /** Throw before creating on these 1-based createIssue calls. */
  failBeforeCreateOn = new Set<number>();
  /** Create the Issue, then throw (simulates a lost response) on these calls. */
  failAfterCreateOn = new Set<number>();
  subIssuesSupported = true;
  private nextNumber = 1;
  private nextCommentId = 100_000;

  async getDefaultBranch(): Promise<string> {
    return "main";
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  addIssue(input: {
    title: string;
    body: string;
    labels?: string[];
    author?: Actor;
    state?: "open" | "closed";
    stateReason?: string | null;
  }): IssueData {
    const number = this.nextNumber++;
    const issue: IssueData = {
      id: 50_000 + number,
      nodeId: `I_node_${number}`,
      number,
      title: input.title,
      body: input.body,
      state: input.state ?? "open",
      stateReason: input.stateReason ?? null,
      labels: [...(input.labels ?? [])],
      author: input.author ?? PO,
      isPullRequest: false,
    };
    this.issues.set(number, issue);
    return structuredClone(issue);
  }

  editIssue(
    number: number,
    patch: Partial<Pick<IssueData, "title" | "body" | "state" | "stateReason">>,
  ): void {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`no issue ${number}`);
    Object.assign(issue, patch);
  }

  addComment(issueNumber: number, author: Actor, body: string): CommentData {
    const comment: StoredComment = { id: this.nextCommentId++, body, author, issueNumber };
    this.comments.set(comment.id, comment);
    return { id: comment.id, body, author };
  }

  commentsOn(issueNumber: number): StoredComment[] {
    return [...this.comments.values()].filter((comment) => comment.issueNumber === issueNumber);
  }

  botComment(issueNumber: number, marker: string): string | undefined {
    const altMarker = marker.startsWith("ai-dlc:")
      ? marker.replace(/^ai-dlc:/, "huddle60:")
      : marker.replace(/^huddle60:/, "ai-dlc:");
    return this.commentsOn(issueNumber).find(
      (comment) =>
        comment.author.type === "Bot" &&
        (comment.body.includes(marker) || comment.body.includes(altMarker)),
    )?.body;
  }

  async getIssue(number: number): Promise<IssueData> {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`Issue #${number} not found`);
    return structuredClone(issue);
  }

  async getComment(id: number): Promise<CommentData | null> {
    const comment = this.comments.get(id);
    return comment ? { id: comment.id, body: comment.body, author: comment.author } : null;
  }

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<IssueData> {
    this.createIssueCalls += 1;
    if (this.failBeforeCreateOn.has(this.createIssueCalls))
      throw new Error("network error before create");
    const created = this.addIssue({ ...input, author: BOT });
    if (this.failAfterCreateOn.has(this.createIssueCalls))
      throw new Error("connection reset after create");
    return created;
  }

  async updateIssue(
    issueNumber: number,
    patch: { title?: string; body?: string },
  ): Promise<IssueData> {
    this.editIssue(issueNumber, patch);
    return this.getIssue(issueNumber);
  }

  async listIssuesWithLabel(label: string): Promise<IssueData[]> {
    return [...this.issues.values()]
      .filter((issue) => issue.labels.includes(label))
      .map((issue) => structuredClone(issue));
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    const issue = this.issues.get(issueNumber);
    if (!issue) throw new Error(`no issue ${issueNumber}`);
    for (const label of labels) if (!issue.labels.includes(label)) issue.labels.push(label);
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    const issue = this.issues.get(issueNumber);
    if (issue) issue.labels = issue.labels.filter((value) => value !== label);
  }

  async upsertComment(issueNumber: number, marker: string, body: string): Promise<void> {
    const existing = this.commentsOn(issueNumber).find(
      (comment) => comment.author.type === "Bot" && comment.body.includes(marker),
    );
    const text = body.includes(marker) ? body : `${body}\n${marker}`;
    if (existing) existing.body = text;
    else this.addComment(issueNumber, BOT, text);
  }

  async closeIssue(issueNumber: number, reason: "completed" | "not_planned"): Promise<void> {
    this.editIssue(issueNumber, { state: "closed", stateReason: reason });
  }

  async addSubIssue(parentNumber: number, childId: number): Promise<"linked" | "unsupported"> {
    if (!this.subIssuesSupported) return "unsupported";
    this.subIssues.push({ parent: parentNumber, childId });
    return "linked";
  }

  async addToProject(
    _project: { owner: string; number: number },
    contentNodeId: string,
  ): Promise<void> {
    this.projectItems.push(contentNodeId);
  }

  addPullRequest(input: {
    number: number;
    body: string;
    headSha?: string;
    labels?: string[];
    files?: string[];
  }): void {
    this.pullRequests.set(input.number, {
      number: input.number,
      body: input.body,
      headSha: input.headSha ?? "a".repeat(40),
      labels: input.labels ?? [],
      files: input.files ?? ["src/app.ts"],
    });
  }

  async getPullRequest(number: number): Promise<PullRequestData> {
    const pr = this.pullRequests.get(number);
    if (!pr) throw new Error(`no PR ${number}`);
    return { number: pr.number, body: pr.body, headSha: pr.headSha, labels: [...pr.labels] };
  }

  async listPullRequestFiles(number: number): Promise<string[]> {
    return [...(this.pullRequests.get(number)?.files ?? [])];
  }

  async setCommitStatus(
    sha: string,
    status: { state: CommitState; context: string; description: string },
  ): Promise<void> {
    this.statuses.push({ sha, ...status });
  }

  async getWorkflowRun(runId: number): Promise<WorkflowRunData | null> {
    return this.runs.get(runId) ?? null;
  }

  async getCodebaseContext(): Promise<string> {
    return `Repository: ${this.repo.owner}/${this.repo.repo}\nFiles:\n- package.json\n- src/index.ts`;
  }

  async viewer(): Promise<Actor> {
    return this.viewerActor;
  }

  async listOpenIssuesWithLabel(label: string): Promise<IssueData[]> {
    return (await this.listIssuesWithLabel(label)).filter((issue) => issue.state === "open");
  }

  async createComment(issueNumber: number, body: string): Promise<CommentData> {
    return this.addComment(issueNumber, this.viewerActor, body);
  }

  async findBotComment(issueNumber: number, marker: string): Promise<CommentData | null> {
    const found = this.commentsOn(issueNumber)
      .filter((comment) => comment.author.type === "Bot" && comment.body.includes(marker))
      .at(-1);
    return found ? { id: found.id, body: found.body, author: found.author } : null;
  }

  async listSuccessfulRuns(
    workflowPath: string,
    branch: string,
    limit: number,
  ): Promise<WorkflowRunData[]> {
    return [...this.runs.values()]
      .filter(
        (run) =>
          run.path === workflowPath &&
          run.headBranch === branch &&
          run.event === "push" &&
          run.conclusion === "success",
      )
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }

  async ensureLabel(label: { name: string }): Promise<"created" | "exists"> {
    if (this.labels.has(label.name)) return "exists";
    this.labels.add(label.name);
    return "created";
  }
}

/** Model double that returns queued responses and records prompts. */
export class FakeModel implements ModelPort {
  readonly modelId = "fake-gemini";
  readonly calls: Array<{
    system: string;
    user: string;
    images?: Array<{ mimeType: string; dataBase64: string }>;
    attachments?: AttachmentPart[];
  }> = [];
  private readonly responses: string[] = [];

  respondWith(...responses: Array<string | object>): this {
    for (const response of responses)
      this.responses.push(typeof response === "string" ? response : JSON.stringify(response));
    return this;
  }

  async generateJson(input: {
    system: string;
    user: string;
    images?: Array<{ mimeType: string; dataBase64: string }>;
    attachments?: AttachmentPart[];
  }): Promise<{ text: string; usage: ModelUsage }> {
    this.calls.push({
      system: input.system,
      user: input.user,
      images: input.images,
      attachments: input.attachments,
    });
    const text = this.responses.shift();
    if (text === undefined) throw new Error("FakeModel has no queued response");
    return { text, usage: { inputTokens: 10, outputTokens: 20 } };
  }
}

export const fixedClock = { now: () => new Date("2026-10-29T10:00:00.000Z") };
