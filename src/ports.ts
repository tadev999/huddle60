import type { PlanRecord } from "./core/plan.js";

export interface Actor {
  id: number;
  login: string;
  type: string;
}

export interface RepoRef {
  owner: string;
  repo: string;
  repositoryId: number;
}

export interface IssueData {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason: string | null;
  labels: string[];
  author: Actor;
  isPullRequest: boolean;
}

export interface CommentData {
  id: number;
  body: string;
  author: Actor;
}

export interface PullRequestData {
  number: number;
  body: string;
  headSha: string;
  labels: string[];
}

export interface WorkflowRunData {
  id: number;
  runAttempt: number;
  path: string;
  event: string;
  headBranch: string | null;
  headSha: string;
  status: string | null;
  conclusion: string | null;
  repositoryId: number;
}

export type CommitState = "success" | "failure" | "pending" | "error";

/** The subset of the GitHub API used by AI-DLC, scoped to one repository installation. */
export interface GitHubPort {
  readonly repo: RepoRef;
  getDefaultBranch(): Promise<string>;
  readFile(path: string, ref?: string): Promise<string | null>;
  getIssue(number: number): Promise<IssueData>;
  getComment(id: number): Promise<CommentData | null>;
  createIssue(input: { title: string; body: string; labels: string[] }): Promise<IssueData>;
  updateIssue(issueNumber: number, patch: { title?: string; body?: string }): Promise<IssueData>;
  listIssuesWithLabel(label: string): Promise<IssueData[]>;
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
  removeLabel(issueNumber: number, label: string): Promise<void>;
  /** Edits the bot comment containing `marker`, or creates it. */
  upsertComment(issueNumber: number, marker: string, body: string): Promise<void>;
  closeIssue(issueNumber: number, reason: "completed" | "not_planned"): Promise<void>;
  /** Links a child as a native sub-issue. Returns "unsupported" when the API is unavailable. */
  addSubIssue(parentNumber: number, childId: number): Promise<"linked" | "unsupported">;
  addToProject(project: { owner: string; number: number }, contentNodeId: string): Promise<void>;
  getPullRequest(number: number): Promise<PullRequestData>;
  listPullRequestFiles(number: number): Promise<string[]>;
  setCommitStatus(
    sha: string,
    status: { state: CommitState; context: string; description: string },
  ): Promise<void>;
  getWorkflowRun(runId: number): Promise<WorkflowRunData | null>;
}

/** Extra calls used by the local app, which acts with the signed-in user's own token. */
export interface LocalGitHubPort extends GitHubPort {
  viewer(): Promise<Actor>;
  listOpenIssuesWithLabel(label: string): Promise<IssueData[]>;
  createComment(issueNumber: number, body: string): Promise<CommentData>;
  /** Latest comment written by a bot that contains `marker`. */
  findBotComment(issueNumber: number, marker: string): Promise<CommentData | null>;
  /** Successful `push` runs of a workflow on `branch`, newest first. */
  listSuccessfulRuns(
    workflowPath: string,
    branch: string,
    limit: number,
  ): Promise<WorkflowRunData[]>;
  getCodebaseContext?(): Promise<string>;
  ensureLabel(label: {
    name: string;
    color: string;
    description: string;
  }): Promise<"created" | "exists">;
}

/** Append-only JSON store for baselines, decisions and revocations. */
export interface EvidenceStore {
  read<T>(path: string): Promise<T | null>;
  /** Creates the file; identical content is a no-op, different content is a conflict. */
  write(path: string, value: unknown): Promise<"created" | "unchanged">;
  list(prefix: string): Promise<string[]>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AttachmentPart {
  name?: string;
  mimeType: string;
  dataBase64: string;
}

export interface ModelPort {
  readonly modelId: string;
  generateJson(input: {
    system: string;
    user: string;
    jsonSchema: Record<string, unknown>;
    images?: Array<{ mimeType: string; dataBase64: string }>;
    attachments?: AttachmentPart[];
  }): Promise<{ text: string; usage: ModelUsage }>;
}

export type LedgerItemState = "creating" | "created";

export interface LedgerItem {
  state: LedgerItemState;
  issueNumber?: number;
  issueId?: number;
  issueNodeId?: string;
  attemptedAt: string;
  subIssue?: "linked" | "unsupported" | "failed";
  project?: "added" | "skipped" | "failed";
}

export interface CreationLedger {
  planId: string;
  planHash: string;
  status: "creating" | "partial" | "created";
  items: Record<string, LedgerItem>;
  errors: string[];
  updatedAt: string;
}

export interface PlanStore {
  /** Returns false when the delivery was already claimed. */
  claimDelivery(deliveryId: string): Promise<boolean>;
  /** Undoes a claim when the job could not be queued, so a redelivery is accepted. */
  releaseDelivery(deliveryId: string): Promise<void>;
  getPlan(planId: string): Promise<PlanRecord | null>;
  latestPlanForIssue(repositoryId: number, issueNumber: number): Promise<PlanRecord | null>;
  savePlan(record: PlanRecord): Promise<void>;
  getLedger(planId: string): Promise<CreationLedger | null>;
  saveLedger(ledger: CreationLedger): Promise<void>;
  /** Short exclusive lease so only one worker creates Issues for a plan at a time. */
  acquireLease(key: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseLease(key: string, owner: string): Promise<void>;
}

export type PlannerJob =
  | {
      type: "request";
      deliveryId: string;
      installationId: number;
      owner: string;
      repo: string;
      issueNumber: number;
    }
  | {
      type: "request-edited";
      deliveryId: string;
      installationId: number;
      owner: string;
      repo: string;
      issueNumber: number;
    }
  | {
      type: "command";
      deliveryId: string;
      installationId: number;
      owner: string;
      repo: string;
      issueNumber: number;
      commentId: number;
    };

export interface JobQueue {
  enqueue(job: PlannerJob): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
