import { randomUUID } from "node:crypto";
import { MemoryPlanStore } from "../adapters/memory.js";
import { REQUIRED_ROLE, type DecisionKind } from "../core/decision.js";
import { AiDlcError, isAiDlcError } from "../core/errors.js";
import {
  PLAN_SCHEMA_VERSION,
  blockingQuestions,
  buildPlanId,
  computePlanHash,
  computeRequestDigest,
  type ModelPlan,
  type PlanRecord,
} from "../core/plan.js";
import { hasRole, type LaneName, type Policy, type Role } from "../core/policy.js";
import { bulletList, marker, renderTree, sanitize } from "../core/render.js";
import {
  KIND_LABEL,
  LABELS,
  SECTIONS,
  kindFromLabels,
  type WorkItemKind,
} from "../core/vocabulary.js";
import { IssueTreeCreator } from "../planner/creator.js";
import { generatePlan } from "../planner/generate.js";
import { PROMPT_VERSION, buildPlannerPrompt } from "../planner/prompt.js";
import { canonicalJson } from "../core/canonical.js";
import type {
  Actor,
  Clock,
  EvidenceStore,
  IssueData,
  LocalGitHubPort,
  Logger,
  ModelPort,
  WorkflowRunData,
} from "../ports.js";
import { renderAgentContext } from "../workflow/context.js";
import { WorkflowService } from "../workflow/service.js";

export interface LocalAppDeps {
  github: LocalGitHubPort;
  evidence: EvidenceStore;
  /** Null when no Gemini key is configured; planning is then unavailable. */
  model: ModelPort | null;
  clock: Clock;
  logger: Logger;
}

export type Stage = "awaiting-approval" | "awaiting-ready" | "in-progress";

export interface WorkItem {
  number: number;
  title: string;
  kind: WorkItemKind;
  url: string;
  parent: number | null;
  stage: Stage;
  /** Decisions exist, but for older content: the Issue was edited afterwards. */
  changed: boolean;
  approvedBy: string | null;
  ready: { by: string; lane: LaneName } | null;
  error: string | null;
}

export interface DraftView {
  draftId: string;
  title: string;
  request: string;
  clarifications: string[];
  plan: ModelPlan;
  blocking: string[];
  created: { requestIssue: number; issues: Record<string, number> } | null;
}

export interface BuildView {
  id: number;
  path: string;
  headSha: string;
  url: string;
}

interface Draft {
  id: string;
  title: string;
  request: string;
  clarifications: string[];
  plan: ModelPlan;
  record: PlanRecord | null;
  created: DraftView["created"];
}

const LANES: readonly LaneName[] = ["fast", "standard", "strict"];
const MAX_DRAFTS = 50;

export const LABEL_COLORS: Record<string, { color: string; description: string }> = {
  [LABELS.request]: { color: "5319e7", description: "AI-DLC: product request from a PO" },
  [LABELS.planDraft]: { color: "c5def5", description: "AI-DLC: plan proposed, not created" },
  [LABELS.planCreated]: { color: "0e8a16", description: "AI-DLC: Issues created from the plan" },
  [LABELS.planPartial]: { color: "d93f0b", description: "AI-DLC: Issue creation incomplete" },
  [LABELS.fromPlan]: { color: "bfdadc", description: "AI-DLC: created from a confirmed plan" },
  [LABELS.stale]: { color: "fbca04", description: "AI-DLC: content changed after decisions" },
  [LABELS.exempt]: { color: "ededed", description: "AI-DLC: PR exempt (maintainer only)" },
  [LABELS.epic]: { color: "3e4b9e", description: "Epic" },
  [LABELS.story]: { color: "1d76db", description: "User story" },
  [LABELS.task]: { color: "0052cc", description: "Technical task" },
};

/** Backend of `huddle60 ui`. Decisions are posted as `/ai-dlc` comments so GitHub Actions validates them. */
export class LocalApp {
  readonly workflow: WorkflowService;
  private readonly plans = new MemoryPlanStore();
  private readonly drafts = new Map<string, Draft>();
  private viewerCache: Actor | null = null;

  constructor(private readonly deps: LocalAppDeps) {
    this.workflow = new WorkflowService({
      github: deps.github,
      evidence: deps.evidence,
      clock: deps.clock,
      logger: deps.logger,
      enabled: true,
    });
  }

  private get repoUrl(): string {
    const { owner, repo } = this.deps.github.repo;
    return `https://github.com/${owner}/${repo}`;
  }

  async viewer(): Promise<Actor> {
    this.viewerCache ??= await this.deps.github.viewer();
    return this.viewerCache;
  }

  private async rolesOf(policy: Policy): Promise<Role[]> {
    const viewer = await this.viewer();
    return (["po", "dev", "maintainer"] as const).filter((role) =>
      hasRole(policy, viewer.id, role),
    );
  }

  private async requireRole(policy: Policy, role: Role, action: string): Promise<void> {
    const viewer = await this.viewer();
    if (!hasRole(policy, viewer.id, role)) {
      throw new AiDlcError(
        "E_ROLE",
        `${viewer.login} cannot ${action}: this requires the ${role} role in the policy.`,
      );
    }
  }

  async session() {
    const policy = await this.workflow.policy();
    const viewer = await this.viewer();
    return {
      repo: { ...this.deps.github.repo, url: this.repoUrl },
      defaultBranch: await this.deps.github.getDefaultBranch(),
      viewer: { id: viewer.id, login: viewer.login },
      roles: await this.rolesOf(policy),
      planner: this.deps.model ? { model: this.deps.model.modelId } : null,
      lanes: Object.fromEntries(
        LANES.map((lane) => [
          lane,
          { requiresPoApproval: policy.lanes[lane].requires_po_approval },
        ]),
      ),
    };
  }

  // ---- Planning ---------------------------------------------------------------

  async draftPlan(input: { title?: string; request: string }): Promise<DraftView> {
    const request = input.request.trim();
    if (request.length < 10)
      throw new AiDlcError("E_FORM", "Describe the need in at least one sentence.");
    if (request.length > 20_000) throw new AiDlcError("E_FORM", "The request is too long.");
    const title = (input.title?.trim() || (request.split("\n")[0] ?? "")).slice(0, 120).trim();
    const plan = await this.generate(title, request, [], null);
    const draft: Draft = {
      id: randomUUID(),
      title,
      request,
      clarifications: [],
      plan,
      record: null,
      created: null,
    };
    this.drafts.set(draft.id, draft);
    if (this.drafts.size > MAX_DRAFTS) {
      const oldest = this.drafts.keys().next().value;
      if (oldest) this.drafts.delete(oldest);
    }
    return this.view(draft);
  }

  async refinePlan(draftId: string, clarification: string): Promise<DraftView> {
    const draft = this.draft(draftId);
    if (draft.record)
      throw new AiDlcError("E_CONFLICT", "Issues were already created for this plan.");
    const text = clarification.trim();
    if (text.length === 0) throw new AiDlcError("E_FORM", "Write an answer or a change request.");
    if (text.length > 5_000) throw new AiDlcError("E_FORM", "The answer is too long.");
    const clarifications = [...draft.clarifications, text];
    draft.plan = await this.generate(draft.title, draft.request, clarifications, draft.plan);
    draft.clarifications = clarifications;
    return this.view(draft);
  }

  async createPlan(draftId: string): Promise<DraftView> {
    const draft = this.draft(draftId);
    if (draft.created) return this.view(draft);
    const policy = await this.workflow.policy();
    await this.requireRole(policy, "po", "create Issues from a plan");
    const blocking = blockingQuestions(draft.plan);
    if (blocking.length > 0) {
      throw new AiDlcError(
        "E_PLAN_BLOCKED",
        "Answer the blocking questions before creating Issues.",
      );
    }
    const { github, clock, logger } = this.deps;
    if (!draft.record) {
      const body = `### ${SECTIONS.request}\n\n${sanitize(draft.request)}\n`;
      const issue = await github.createIssue({
        title: draft.title,
        body,
        labels: [LABELS.request],
      });
      draft.record = this.record(draft, issue, policy, (await this.viewer()).id);
      await this.plans.savePlan(draft.record);
      await github.upsertComment(
        issue.number,
        marker("plan", draft.record.planId),
        this.renderPlanRecord(draft.record),
      );
    }
    const creator = new IssueTreeCreator({
      github,
      store: this.plans,
      clock,
      logger,
      leaseOwner: `local-${process.pid}`,
    });
    const ledger = await creator.create(draft.record, policy);
    draft.created = {
      requestIssue: draft.record.source.issueNumber,
      issues: Object.fromEntries(
        Object.entries(ledger.items).flatMap(([localId, item]) =>
          item.issueNumber === undefined ? [] : [[localId, item.issueNumber]],
        ),
      ),
    };
    return this.view(draft);
  }

  private draft(draftId: string): Draft {
    const draft = this.drafts.get(draftId);
    if (!draft)
      throw new AiDlcError("E_PLAN_NOT_FOUND", "This draft is no longer available. Start again.");
    return draft;
  }

  private async generate(
    title: string,
    request: string,
    clarifications: string[],
    previous: ModelPlan | null,
  ): Promise<ModelPlan> {
    const { model, logger } = this.deps;
    if (!model) {
      throw new AiDlcError(
        "E_CONFIG",
        "Gemini is not configured. Set GEMINI_API_KEY and restart `huddle60 ui`.",
      );
    }
    const policy = await this.workflow.policy();
    const prompt = buildPlannerPrompt({
      title,
      request,
      clarifications,
      ...(previous ? { previousPlanJson: canonicalJson(previous) } : {}),
    });
    return (await generatePlan(model, logger, prompt, policy.planner.max_nodes)).plan;
  }

  private record(draft: Draft, issue: IssueData, policy: Policy, requestedBy: number): PlanRecord {
    const { github, clock, model } = this.deps;
    const digest = computeRequestDigest(issue.title, issue.body);
    const planHash = computePlanHash(digest, draft.plan);
    const now = clock.now();
    return {
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: buildPlanId(issue.number, 1, planHash),
      revision: 1,
      status: "creating",
      source: {
        repositoryId: github.repo.repositoryId,
        owner: github.repo.owner,
        repo: github.repo.repo,
        issueNumber: issue.number,
        issueNodeId: issue.nodeId,
        requestDigest: digest,
      },
      model: `${model?.modelId ?? "unknown"} (${PROMPT_VERSION})`,
      plan: draft.plan,
      planHash,
      clarifications: draft.clarifications,
      requestedBy,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + policy.planner.plan_ttl_days * 86_400_000).toISOString(),
    };
  }

  private renderPlanRecord(record: PlanRecord): string {
    const { plan } = record;
    return [
      `## Kế hoạch đã được PO xác nhận trong huddle60 (AI-DLC)`,
      "",
      sanitize(plan.summary),
      "",
      "### Cây công việc",
      "",
      renderTree(plan),
      "",
      "### Giả định",
      "",
      bulletList(plan.assumptions),
      "",
      "### Câu hỏi không chặn",
      "",
      bulletList(plan.openQuestions.filter((q) => !q.blocking).map((q) => q.text)),
      "",
      "### Làm rõ của PO",
      "",
      bulletList(record.clarifications),
      "",
      `<sub>Plan \`${record.planId}\` · hash \`${record.planHash}\` · model \`${record.model}\`.</sub>`,
    ].join("\n");
  }

  private view(draft: Draft): DraftView {
    return {
      draftId: draft.id,
      title: draft.title,
      request: draft.request,
      clarifications: draft.clarifications,
      plan: draft.plan,
      blocking: blockingQuestions(draft.plan),
      created: draft.created,
    };
  }

  // ---- Work items and decisions ----------------------------------------------

  async listItems(): Promise<WorkItem[]> {
    const policy = await this.workflow.policy();
    const seen = new Map<number, IssueData>();
    for (const label of Object.values(KIND_LABEL)) {
      for (const issue of await this.deps.github.listOpenIssuesWithLabel(label))
        seen.set(issue.number, issue);
    }
    const issues = [...seen.values()].sort((a, b) => a.number - b.number);
    return mapLimit(issues, 4, (issue) => this.item(issue, policy));
  }

  private async item(issue: IssueData, policy: Policy): Promise<WorkItem> {
    const kind = kindFromLabels(issue.labels) ?? "story";
    const base = {
      number: issue.number,
      title: issue.title,
      kind,
      url: `${this.repoUrl}/issues/${issue.number}`,
    };
    try {
      const snapshot = this.workflow.snapshotOf(issue);
      const receipts = await this.workflow.listDecisions(issue.number);
      const current = receipts.filter((receipt) => receipt.baselineHash === snapshot.contentHash);
      let approvedBy: string | null = null;
      let ready: WorkItem["ready"] = null;
      for (const receipt of current) {
        if (receipt.kind === "accept") continue;
        if (!(await this.workflow.isValid(receipt, policy)).valid) continue;
        if (receipt.kind === "approve") approvedBy ??= receipt.actor.login;
        if (receipt.kind === "ready" && receipt.lane)
          ready ??= { by: receipt.actor.login, lane: receipt.lane };
      }
      const stage: Stage = ready
        ? "in-progress"
        : kind === "task" || approvedBy
          ? "awaiting-ready"
          : "awaiting-approval";
      return {
        ...base,
        parent: snapshot.parent,
        stage,
        changed: receipts.length > 0 && current.length === 0,
        approvedBy,
        ready,
        error: null,
      };
    } catch (error) {
      if (!isAiDlcError(error)) throw error;
      return {
        ...base,
        parent: null,
        stage: "awaiting-approval",
        changed: false,
        approvedBy: null,
        ready: null,
        error: `${error.code}: ${error.message}`,
      };
    }
  }

  /** Posts the decision comment as the signed-in user; the AI-DLC workflow validates and replies. */
  async decide(
    issueNumber: number,
    input: { action: DecisionKind; lane?: string; runId?: number },
  ): Promise<{ commentId: number; command: string }> {
    const policy = await this.workflow.policy();
    await this.requireRole(policy, REQUIRED_ROLE[input.action], input.action);
    const issue = await this.deps.github.getIssue(issueNumber);
    if (issue.isPullRequest || issue.state !== "open")
      throw new AiDlcError("E_SYNTAX", `#${issueNumber} is not an open Issue.`);
    const snapshot = this.workflow.snapshotOf(issue);
    const target = `baseline=${snapshot.baselineId}`;
    let command: string;
    switch (input.action) {
      case "approve":
        command = `/ai-dlc approve ${target} hash=${snapshot.contentHash}`;
        break;
      case "ready": {
        const lane = input.lane as LaneName;
        if (!LANES.includes(lane))
          throw new AiDlcError("E_SYNTAX", `Lane must be one of ${LANES.join(", ")}.`);
        command = `/ai-dlc ready ${target} hash=${snapshot.contentHash} lane=${lane}`;
        break;
      }
      case "accept": {
        const builds = await this.builds();
        const build =
          input.runId === undefined ? builds[0] : builds.find((run) => run.id === input.runId);
        if (!build) {
          throw new AiDlcError(
            "E_BUILD_INVALID",
            "No successful acceptance build on the default branch. Merge the PR and wait for the build.",
          );
        }
        command = `/ai-dlc accept ${target} run=${build.id} commit=${build.headSha}`;
        break;
      }
      default:
        throw new AiDlcError("E_SYNTAX", "Unknown action.");
    }
    const comment = await this.deps.github.createComment(issueNumber, command);
    return { commentId: comment.id, command };
  }

  async reply(
    issueNumber: number,
    commentId: number,
  ): Promise<{ status: "pending" | "done"; body: string | null; ok: boolean }> {
    const found = await this.deps.github.findBotComment(
      issueNumber,
      marker("reply", String(commentId)),
    );
    if (!found) return { status: "pending", body: null, ok: false };
    const body = found.body.replace(/<!--[\s\S]*?-->/gu, "").trim();
    return { status: "done", body, ok: !body.startsWith("**AI-DLC: `E_") };
  }

  async builds(): Promise<BuildView[]> {
    const policy = await this.workflow.policy();
    const branch = await this.deps.github.getDefaultBranch();
    const runs: WorkflowRunData[] = [];
    for (const path of policy.acceptance.build_workflows)
      runs.push(...(await this.deps.github.listSuccessfulRuns(path, branch, 5)));
    return runs
      .sort((a, b) => b.id - a.id)
      .slice(0, 10)
      .map((run) => ({
        id: run.id,
        path: run.path,
        headSha: run.headSha,
        url: `${this.repoUrl}/actions/runs/${run.id}`,
      }));
  }

  async context(issueNumber: number): Promise<string> {
    const policy = await this.workflow.policy();
    return renderAgentContext(
      { github: this.deps.github, evidence: this.deps.evidence, workflow: this.workflow },
      policy,
      issueNumber,
    );
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
