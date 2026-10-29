import { canonicalJson } from "../core/canonical.js";
import { commandHandler, parseCommand, type ParsedCommand } from "../core/command.js";
import { AiDlcError, isAiDlcError } from "../core/errors.js";
import { parseIssueForm } from "../core/issue-form.js";
import {
  PLAN_SCHEMA_VERSION,
  blockingQuestions,
  buildPlanId,
  computePlanHash,
  computeRequestDigest,
  type PlanRecord,
} from "../core/plan.js";
import { POLICY_PATH, hasRole, parsePolicy, type Policy } from "../core/policy.js";
import { marker, renderPlanComment, sanitize } from "../core/render.js";
import { LABELS, SECTIONS } from "../core/vocabulary.js";
import type {
  Clock,
  CreationLedger,
  GitHubPort,
  IssueData,
  Logger,
  ModelPort,
  PlanStore,
  PlannerJob,
} from "../ports.js";
import { IssueTreeCreator, errorMessage } from "./creator.js";
import { generatePlan } from "./generate.js";
import { PROMPT_VERSION, buildPlannerPrompt } from "./prompt.js";

export { errorMessage };

export interface PlannerOptions {
  enabled: boolean;
  /** Upper bound on plan revisions per request to cap model cost. */
  maxRevisions: number;
  leaseOwner: string;
}

export interface PlannerDeps {
  github: GitHubPort;
  model: ModelPort;
  store: PlanStore;
  clock: Clock;
  logger: Logger;
  options: PlannerOptions;
}

export class PlannerService {
  private readonly creator: IssueTreeCreator;

  constructor(private readonly deps: PlannerDeps) {
    this.creator = new IssueTreeCreator({
      github: deps.github,
      store: deps.store,
      clock: deps.clock,
      logger: deps.logger,
      leaseOwner: deps.options.leaseOwner,
    });
  }

  async handle(job: PlannerJob): Promise<void> {
    const { logger } = this.deps;
    const fields = { jobType: job.type, deliveryId: job.deliveryId, issue: job.issueNumber };
    logger.info("planner job started", fields);
    try {
      if (job.type === "request") await this.handleRequest(job.issueNumber);
      else if (job.type === "request-edited") await this.handleRequestEdited(job.issueNumber);
      else await this.handleCommand(job.issueNumber, job.commentId);
      logger.info("planner job finished", fields);
    } catch (error) {
      if (isAiDlcError(error)) {
        logger.warn("planner job rejected", { ...fields, code: error.code });
        return;
      }
      logger.error("planner job failed", { ...fields, error: errorMessage(error) });
      throw error;
    }
  }

  private async loadPolicy(): Promise<Policy> {
    const branch = await this.deps.github.getDefaultBranch();
    const source = await this.deps.github.readFile(POLICY_PATH, branch);
    if (source === null)
      throw new AiDlcError("E_POLICY_INVALID", `Missing ${POLICY_PATH} on ${branch}.`);
    return parsePolicy(source);
  }

  private async reportRequestError(issueNumber: number, error: AiDlcError): Promise<void> {
    await this.deps.github.upsertComment(
      issueNumber,
      marker("planner-error", String(issueNumber)),
      [`**AI-DLC planner: \`${error.code}\`**`, "", sanitize(error.message)].join("\n"),
    );
  }

  async handleRequest(issueNumber: number): Promise<void> {
    const { github, store } = this.deps;
    const issue = await github.getIssue(issueNumber);
    if (issue.isPullRequest || !issue.labels.includes(LABELS.request)) return;
    // Created by the local app, which already turned it into Issues.
    if (issue.labels.includes(LABELS.planCreated)) return;
    const policy = await this.loadPolicy();
    if (!hasRole(policy, issue.author.id, "po")) {
      this.deps.logger.info("request ignored: author is not a PO", {
        issue: issueNumber,
        author: issue.author.id,
      });
      return;
    }
    const digest = computeRequestDigest(issue.title, issue.body);
    const latest = await store.latestPlanForIssue(github.repo.repositoryId, issueNumber);
    if (latest && latest.source.requestDigest === digest && latest.status !== "stale") return;
    try {
      this.ensureEnabled();
      await this.generate(issue, policy, latest, []);
    } catch (error) {
      if (isAiDlcError(error)) await this.reportRequestError(issueNumber, error);
      throw error;
    }
  }

  async handleRequestEdited(issueNumber: number): Promise<void> {
    const { github, store } = this.deps;
    const issue = await github.getIssue(issueNumber);
    if (!issue.labels.includes(LABELS.request)) return;
    const latest = await store.latestPlanForIssue(github.repo.repositoryId, issueNumber);
    if (!latest || latest.status !== "draft") return;
    if (latest.source.requestDigest === computeRequestDigest(issue.title, issue.body)) return;
    await store.savePlan({ ...latest, status: "stale" });
    await github.upsertComment(
      issueNumber,
      marker("plan-stale", latest.planId),
      [
        `Request đã thay đổi sau khi tạo \`${latest.planId}\`, nên kế hoạch này không còn dùng để tạo Issues được.`,
        "",
        `Tạo kế hoạch mới: \`/ai-dlc refine plan=${latest.planId}\` (có thể thêm ghi chú ở các dòng sau).`,
      ].join("\n"),
    );
  }

  async handleCommand(issueNumber: number, commentId: number): Promise<void> {
    const { github } = this.deps;
    const comment = await github.getComment(commentId);
    if (!comment || comment.author.type !== "User") return;
    let command: ParsedCommand;
    try {
      command = parseCommand(comment.body);
    } catch (error) {
      if (isAiDlcError(error)) await this.reply(issueNumber, commentId, error);
      throw error;
    }
    if (commandHandler(command.name) !== "planner") return;
    try {
      const policy = await this.loadPolicy();
      const issue = await github.getIssue(issueNumber);
      if (issue.isPullRequest || !issue.labels.includes(LABELS.request)) {
        throw new AiDlcError(
          "E_NOT_REQUEST",
          "Planner commands only work on Issues labelled ai-dlc:request.",
        );
      }
      const allowed =
        hasRole(policy, comment.author.id, "po") ||
        (command.name === "resume-plan" && hasRole(policy, comment.author.id, "maintainer"));
      if (!allowed) throw new AiDlcError("E_ROLE", `Only a PO may run \`${command.name}\`.`);
      const record = await this.loadPlanForIssue(command.args.plan as string, issue);
      if (command.name === "refine")
        await this.refine(record, issue, policy, command.note, comment.author.id);
      else if (command.name === "create-plan")
        await this.confirm(record, issue, command.args.hash as string, policy);
      else await this.resume(record, policy);
    } catch (error) {
      if (isAiDlcError(error)) await this.reply(issueNumber, commentId, error);
      throw error;
    }
  }

  private ensureEnabled(): void {
    if (!this.deps.options.enabled) {
      throw new AiDlcError(
        "E_PLANNER_DISABLED",
        "The planner is temporarily disabled by the operator.",
      );
    }
  }

  private async reply(issueNumber: number, commentId: number, error: AiDlcError): Promise<void> {
    await this.deps.github.upsertComment(
      issueNumber,
      marker("reply", String(commentId)),
      [`**AI-DLC: \`${error.code}\`**`, "", sanitize(error.message)].join("\n"),
    );
  }

  private async loadPlanForIssue(planId: string, issue: IssueData): Promise<PlanRecord> {
    const record = await this.deps.store.getPlan(planId);
    if (
      !record ||
      record.source.repositoryId !== this.deps.github.repo.repositoryId ||
      record.source.issueNumber !== issue.number
    ) {
      throw new AiDlcError("E_PLAN_NOT_FOUND", `Plan \`${planId}\` does not exist for this Issue.`);
    }
    return record;
  }

  private requestText(issue: IssueData): string {
    const sections = parseIssueForm(issue.body);
    const fromForm = sections.get(SECTIONS.request);
    return (fromForm && fromForm.length > 0 ? fromForm : issue.body).trim();
  }

  private async generate(
    issue: IssueData,
    policy: Policy,
    previous: PlanRecord | null,
    clarifications: string[],
  ): Promise<PlanRecord> {
    const { github, model, store, clock } = this.deps;
    const revision = (previous?.revision ?? 0) + 1;
    if (revision > this.deps.options.maxRevisions) {
      throw new AiDlcError(
        "E_PLAN_LIMIT",
        `This request reached ${this.deps.options.maxRevisions} plan revisions. Create a new, narrower request.`,
      );
    }
    const request = this.requestText(issue);
    if (request.length === 0) throw new AiDlcError("E_FORM", "The request text is empty.");
    const prompt = buildPlannerPrompt({
      title: issue.title,
      request,
      clarifications,
      ...(previous ? { previousPlanJson: canonicalJson(previous.plan) } : {}),
    });
    const { plan } = await generatePlan(model, this.deps.logger, prompt, policy.planner.max_nodes);
    const digest = computeRequestDigest(issue.title, issue.body);
    const planHash = computePlanHash(digest, plan);
    const now = clock.now();
    const record: PlanRecord = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      planId: buildPlanId(issue.number, revision, planHash),
      revision,
      status: "draft",
      source: {
        repositoryId: github.repo.repositoryId,
        owner: github.repo.owner,
        repo: github.repo.repo,
        issueNumber: issue.number,
        issueNodeId: issue.nodeId,
        requestDigest: digest,
      },
      model: `${model.modelId} (${PROMPT_VERSION})`,
      plan,
      planHash,
      clarifications,
      requestedBy: issue.author.id,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + policy.planner.plan_ttl_days * 86_400_000).toISOString(),
    };
    await store.savePlan(record);
    if (previous && (previous.status === "draft" || previous.status === "stale")) {
      await store.savePlan({ ...previous, status: "superseded" });
    }
    await github.upsertComment(
      issue.number,
      marker("plan", record.planId),
      renderPlanComment(record),
    );
    await github.addLabels(issue.number, [LABELS.planDraft]);
    return record;
  }

  private async refine(
    record: PlanRecord,
    issue: IssueData,
    policy: Policy,
    note: string,
    actorId: number,
  ): Promise<void> {
    this.ensureEnabled();
    if (record.status !== "draft" && record.status !== "stale") {
      throw new AiDlcError(
        "E_PLAN_STALE",
        `Plan \`${record.planId}\` is ${record.status}; only a draft or stale plan can be refined.`,
      );
    }
    const latest = await this.deps.store.latestPlanForIssue(
      record.source.repositoryId,
      record.source.issueNumber,
    );
    if (latest && latest.planId !== record.planId) {
      throw new AiDlcError("E_PLAN_STALE", `A newer plan exists: \`${latest.planId}\`.`);
    }
    if (note.length === 0 && record.status === "draft") {
      throw new AiDlcError(
        "E_SYNTAX",
        "Add your answers or requested changes on the lines after the command.",
      );
    }
    this.deps.logger.info("refine requested", { plan: record.planId, actor: actorId });
    const clarifications =
      note.length > 0 ? [...record.clarifications, note] : record.clarifications;
    await this.generate(issue, policy, record, clarifications);
  }

  private async confirm(
    record: PlanRecord,
    issue: IssueData,
    hash: string,
    policy: Policy,
  ): Promise<void> {
    if (record.status === "created") {
      throw new AiDlcError("E_CONFLICT", `Plan \`${record.planId}\` was already created.`);
    }
    if (hash !== record.planHash) {
      throw new AiDlcError(
        "E_HASH_MISMATCH",
        "The hash does not match this plan. Copy the command from the latest plan comment.",
      );
    }
    if (record.status === "creating" || record.status === "partial") {
      // Same confirmation retried (e.g. by the queue): continue from the ledger.
      await this.creator.create(record, policy);
      return;
    }
    if (record.status !== "draft") {
      throw new AiDlcError(
        "E_PLAN_STALE",
        `Plan \`${record.planId}\` is ${record.status} and cannot be created.`,
      );
    }
    if (this.deps.clock.now().toISOString() > record.expiresAt) {
      throw new AiDlcError("E_PLAN_STALE", "This plan has expired. Refine it to get a fresh plan.");
    }
    if (computeRequestDigest(issue.title, issue.body) !== record.source.requestDigest) {
      await this.deps.store.savePlan({ ...record, status: "stale" });
      throw new AiDlcError(
        "E_PLAN_STALE",
        "The request changed after this plan was drafted. Refine it first.",
      );
    }
    const blocking = blockingQuestions(record.plan);
    if (blocking.length > 0) {
      throw new AiDlcError(
        "E_PLAN_BLOCKED",
        `Answer the blocking questions first:\n- ${blocking.join("\n- ")}`,
      );
    }
    if (record.plan.nodes.length > policy.planner.max_nodes) {
      throw new AiDlcError(
        "E_PLAN_LIMIT",
        `Plan exceeds the current limit of ${policy.planner.max_nodes} items.`,
      );
    }
    await this.deps.store.savePlan({ ...record, status: "creating" });
    await this.creator.create({ ...record, status: "creating" }, policy);
  }

  private async resume(record: PlanRecord, policy: Policy): Promise<void> {
    if (record.status !== "creating" && record.status !== "partial") {
      throw new AiDlcError(
        "E_PLAN_STALE",
        `Plan \`${record.planId}\` is ${record.status}; there is nothing to resume.`,
      );
    }
    await this.creator.create(record, policy);
  }

  async createIssues(record: PlanRecord, policy: Policy): Promise<CreationLedger> {
    return this.creator.create(record, policy);
  }
}
