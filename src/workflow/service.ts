import {
  buildBaseline,
  baselinePath,
  verifySnapshot,
  type BaselineSnapshot,
} from "../core/baseline.js";
import { commandHandler, parseCommand, type ParsedCommand } from "../core/command.js";
import {
  DECISION_SCHEMA_VERSION,
  REQUIRED_ROLE,
  commentDigest,
  decisionId,
  decisionPath,
  evaluateReceipt,
  revocationPath,
  type DecisionKind,
  type DecisionReceipt,
  type Revocation,
} from "../core/decision.js";
import { AiDlcError, isAiDlcError } from "../core/errors.js";
import {
  POLICY_PATH,
  hasRole,
  isSensitive,
  parsePolicy,
  type LaneName,
  type Policy,
} from "../core/policy.js";
import { closingReferences, parsePrBlock, renderPrBlock } from "../core/pr-block.js";
import { marker, sanitize } from "../core/render.js";
import { LABELS, kindFromLabels } from "../core/vocabulary.js";
import type { Clock, CommentData, EvidenceStore, GitHubPort, IssueData, Logger } from "../ports.js";

export const STATUS_CONTEXT = "ai-dlc/baseline";

export interface WorkflowDeps {
  github: GitHubPort;
  evidence: EvidenceStore;
  clock: Clock;
  logger: Logger;
  enabled: boolean;
}

export interface PrCheckResult {
  state: "success" | "failure" | "pending";
  description: string;
  details: string[];
}

const LANES: readonly LaneName[] = ["fast", "standard", "strict"];

export class WorkflowService {
  private policyCache: Policy | null = null;

  constructor(private readonly deps: WorkflowDeps) {}

  private get repositoryId(): number {
    return this.deps.github.repo.repositoryId;
  }

  async policy(): Promise<Policy> {
    if (this.policyCache) return this.policyCache;
    const branch = await this.deps.github.getDefaultBranch();
    const source = await this.deps.github.readFile(POLICY_PATH, branch);
    if (source === null)
      throw new AiDlcError("E_POLICY_INVALID", `Missing ${POLICY_PATH} on ${branch}.`);
    this.policyCache = parsePolicy(source);
    return this.policyCache;
  }

  /** Entry point for `issue_comment` events on Issues. */
  async handleComment(
    issueNumber: number,
    commentId: number,
    action: "created" | "edited" | "deleted",
  ): Promise<void> {
    if (!this.deps.enabled) return;
    if (action !== "created") {
      await this.reportInvalidatedDecisions(issueNumber, commentId, action);
      return;
    }
    const comment = await this.deps.github.getComment(commentId);
    if (!comment || comment.author.type !== "User") return;
    let command: ParsedCommand;
    try {
      command = parseCommand(comment.body);
    } catch (error) {
      if (isAiDlcError(error)) await this.reply(issueNumber, commentId, errorReply(error));
      return;
    }
    if (commandHandler(command.name) !== "deterministic") return;
    try {
      const policy = await this.policy();
      const issue = await this.deps.github.getIssue(issueNumber);
      if (issue.isPullRequest)
        throw new AiDlcError("E_SYNTAX", "AI-DLC commands are only accepted on Issues.");
      const message = await this.runCommand(command, issue, comment, policy);
      await this.reply(issueNumber, commentId, message);
    } catch (error) {
      if (!isAiDlcError(error)) throw error;
      await this.reply(issueNumber, commentId, errorReply(error));
    }
  }

  private async reply(issueNumber: number, commentId: number, body: string): Promise<void> {
    await this.deps.github.upsertComment(issueNumber, marker("reply", String(commentId)), body);
  }

  private async runCommand(
    command: ParsedCommand,
    issue: IssueData,
    comment: CommentData,
    policy: Policy,
  ): Promise<string> {
    const actor = comment.author;
    switch (command.name) {
      case "baseline":
        this.requireRole(policy, actor.id, ["po", "dev"], "baseline");
        return this.createBaseline(issue);
      case "approve":
      case "ready":
      case "accept":
        this.requireRole(policy, actor.id, [REQUIRED_ROLE[command.name]], command.name);
        return this.recordDecision(command.name, command.args, issue, comment, policy);
      case "revoke":
        return this.revoke(command.args, issue, comment, policy);
      default:
        throw new AiDlcError(
          "E_SYNTAX",
          `\`${command.name}\` is handled by the planner, not this workflow.`,
        );
    }
  }

  private requireRole(
    policy: Policy,
    userId: number,
    roles: Array<"po" | "dev" | "maintainer">,
    action: string,
  ): void {
    if (!roles.some((role) => hasRole(policy, userId, role))) {
      throw new AiDlcError("E_ROLE", `\`${action}\` requires the ${roles.join(" or ")} role.`);
    }
  }

  snapshotOf(issue: IssueData): BaselineSnapshot {
    return buildBaseline({
      repositoryId: this.repositoryId,
      issueNodeId: issue.nodeId,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
    });
  }

  private async createBaseline(issue: IssueData): Promise<string> {
    const snapshot = this.snapshotOf(issue);
    const result = await this.deps.evidence.write(
      baselinePath(this.repositoryId, issue.number, snapshot.baselineId),
      snapshot,
    );
    const criteria = snapshot.requirements.criteria.map(
      (criterion) => `- ${criterion.id}: ${sanitize(criterion.text)}`,
    );
    return [
      `**Baseline \`${snapshot.baselineId}\`** ${result === "created" ? "đã được tạo" : "đã tồn tại với cùng nội dung"}.`,
      "",
      `Hash: \`${snapshot.contentHash}\``,
      ...(criteria.length > 0 ? ["", "Tiêu chí:", ...criteria] : []),
      "",
      "PO duyệt nghiệp vụ:",
      "```text",
      `/ai-dlc approve baseline=${snapshot.baselineId} hash=${snapshot.contentHash}`,
      "```",
      "DEV xác nhận sẵn sàng (lane: fast | standard | strict):",
      "```text",
      `/ai-dlc ready baseline=${snapshot.baselineId} hash=${snapshot.contentHash} lane=standard`,
      "```",
    ].join("\n");
  }

  private async loadSnapshot(issueNumber: number, baselineId: string): Promise<BaselineSnapshot> {
    if (!baselineId.startsWith(`bl-${issueNumber}-`)) {
      throw new AiDlcError(
        "E_BASELINE_NOT_FOUND",
        `Baseline \`${baselineId}\` does not belong to #${issueNumber}.`,
      );
    }
    const snapshot = await this.deps.evidence.read<BaselineSnapshot>(
      baselinePath(this.repositoryId, issueNumber, baselineId),
    );
    if (!snapshot || !verifySnapshot(snapshot)) {
      throw new AiDlcError(
        "E_BASELINE_NOT_FOUND",
        `Baseline \`${baselineId}\` is missing or corrupt.`,
      );
    }
    return snapshot;
  }

  /**
   * Loads the snapshot for a decision. When it was never stored but the id and hash
   * match the Issue's current content, it is stored now, so one command suffices.
   */
  private async snapshotForDecision(
    issue: IssueData,
    baselineId: string,
    hash: string | undefined,
  ): Promise<BaselineSnapshot> {
    const stored = await this.deps.evidence.read<BaselineSnapshot>(
      baselinePath(this.repositoryId, issue.number, baselineId),
    );
    if (stored || hash === undefined) return this.loadSnapshot(issue.number, baselineId);
    const current = this.snapshotOf(issue);
    if (current.baselineId !== baselineId || current.contentHash !== hash) {
      return this.loadSnapshot(issue.number, baselineId);
    }
    await this.deps.evidence.write(
      baselinePath(this.repositoryId, issue.number, current.baselineId),
      current,
    );
    return current;
  }

  /** Throws when the Issue no longer matches the baseline it is being decided on. */
  private assertCurrent(issue: IssueData, snapshot: BaselineSnapshot): void {
    if (this.snapshotOf(issue).contentHash !== snapshot.contentHash) {
      throw new AiDlcError(
        "E_STALE",
        "The Issue changed after this baseline was created. Run `/ai-dlc baseline` again and decide on the new baseline.",
      );
    }
  }

  private async recordDecision(
    kind: DecisionKind,
    args: Record<string, string>,
    issue: IssueData,
    comment: CommentData,
    policy: Policy,
  ): Promise<string> {
    const { github, evidence, clock } = this.deps;
    const snapshot =
      kind === "accept"
        ? await this.loadSnapshot(issue.number, args.baseline as string)
        : await this.snapshotForDecision(issue, args.baseline as string, args.hash);
    let lane: LaneName | null = null;
    let build: DecisionReceipt["build"] = null;
    if (kind === "approve" || kind === "ready") {
      if (args.hash !== snapshot.contentHash) {
        throw new AiDlcError(
          "E_HASH_MISMATCH",
          "The hash does not match the baseline. Copy it from the baseline reply.",
        );
      }
      this.assertCurrent(issue, snapshot);
    }
    if (kind === "ready") {
      if (!LANES.includes(args.lane as LaneName)) {
        throw new AiDlcError("E_SYNTAX", `Lane must be one of ${LANES.join(", ")}.`);
      }
      lane = args.lane as LaneName;
      await this.assertApproved(snapshot, lane, policy);
      const open: number[] = [];
      for (const dependency of snapshot.blockedBy) {
        const blocker = await github.getIssue(dependency);
        if (blocker.state !== "closed" || blocker.stateReason !== "completed")
          open.push(dependency);
      }
      if (open.length > 0) {
        throw new AiDlcError(
          "E_DEPENDENCY_OPEN",
          `Blocked by unfinished Issue(s): ${open.map((n) => `#${n}`).join(", ")}.`,
        );
      }
    }
    if (kind === "accept") {
      if (snapshot.kind === "task") {
        throw new AiDlcError(
          "E_WRONG_KIND",
          "PO accepts stories and epics. A task is done when its PR is merged and its story is accepted.",
        );
      }
      const ready = await this.findValidDecision(
        issue.number,
        snapshot.baselineId,
        "ready",
        policy,
      );
      if (!ready)
        throw new AiDlcError("E_NOT_READY", "There is no valid ready decision for this baseline.");
      build = await this.verifyBuild(Number(args.run), args.commit as string, policy);
    }
    const receipt: DecisionReceipt = {
      schemaVersion: DECISION_SCHEMA_VERSION,
      decisionId: decisionId(kind, comment.id),
      kind,
      issueNumber: issue.number,
      baselineId: snapshot.baselineId,
      baselineHash: snapshot.contentHash,
      actor: { id: comment.author.id, login: comment.author.login },
      source: { commentId: comment.id, commentBodyDigest: commentDigest(comment.body) },
      lane,
      build,
      policyVersion: policy.version,
      recordedAt: clock.now().toISOString(),
    };
    await evidence.write(
      decisionPath(this.repositoryId, issue.number, receipt.decisionId),
      receipt,
    );
    if (kind === "accept") {
      await github.closeIssue(issue.number, "completed");
      return `**Đã ghi nhận nghiệm thu** \`${receipt.decisionId}\` cho \`${snapshot.baselineId}\` trên build ${build?.runId} (\`${build?.headSha.slice(0, 7)}\`). Issue đã được đóng.`;
    }
    if (kind === "ready") {
      const block = renderPrBlock({
        issueNumber: issue.number,
        baselineId: snapshot.baselineId,
        hash: snapshot.contentHash,
        acceptanceCriteria:
          snapshot.kind === "task"
            ? snapshot.acRefs
            : snapshot.requirements.criteria.map((c) => c.id),
      });
      return [
        `**Sẵn sàng triển khai** \`${receipt.decisionId}\` (lane \`${lane}\`).`,
        "",
        "Dán khối sau vào mô tả Pull Request:",
        "```text",
        block,
        "```",
      ].join("\n");
    }
    return `**Đã duyệt nghiệp vụ** \`${receipt.decisionId}\` cho \`${snapshot.baselineId}\`. DEV có thể xác nhận \`ready\`.`;
  }

  private async verifyBuild(
    runId: number,
    commit: string,
    policy: Policy,
  ): Promise<NonNullable<DecisionReceipt["build"]>> {
    if (!Number.isSafeInteger(runId) || runId <= 0)
      throw new AiDlcError("E_SYNTAX", "`run` must be a workflow run id.");
    const problems = await this.buildProblems(runId, commit, policy);
    if (problems.problems.length > 0 || !problems.run) {
      throw new AiDlcError(
        "E_BUILD_INVALID",
        `Build cannot be accepted:\n- ${problems.problems.join("\n- ")}`,
      );
    }
    const { run } = problems;
    return {
      runId: run.id,
      runAttempt: run.runAttempt,
      workflowPath: run.path,
      headSha: run.headSha,
    };
  }

  private async buildProblems(runId: number, commit: string, policy: Policy) {
    const run = await this.deps.github.getWorkflowRun(runId);
    const problems: string[] = [];
    if (!run) return { run: null, problems: [`Workflow run ${runId} was not found.`] };
    const branch = await this.deps.github.getDefaultBranch();
    if (run.repositoryId !== this.repositoryId) problems.push("run belongs to another repository");
    if (!policy.acceptance.build_workflows.includes(run.path))
      problems.push(`workflow \`${run.path}\` is not an acceptance workflow`);
    if (run.event !== "push" || run.headBranch !== branch)
      problems.push(`run must come from a push to \`${branch}\``);
    if (run.headSha !== commit) problems.push("run commit does not match `commit`");
    if (run.status !== "completed" || run.conclusion !== "success")
      problems.push("run did not complete successfully");
    return { run, problems };
  }

  private async revoke(
    args: Record<string, string>,
    issue: IssueData,
    comment: CommentData,
    policy: Policy,
  ): Promise<string> {
    const id = args.decision as string;
    const receipt = await this.deps.evidence.read<DecisionReceipt>(
      decisionPath(this.repositoryId, issue.number, id),
    );
    if (!receipt)
      throw new AiDlcError(
        "E_DECISION_NOT_FOUND",
        `Decision \`${id}\` was not found on this Issue.`,
      );
    const actorId = comment.author.id;
    const allowed =
      receipt.actor.id === actorId || hasRole(policy, actorId, REQUIRED_ROLE[receipt.kind]);
    if (!allowed)
      throw new AiDlcError(
        "E_ROLE",
        "Only the author or a holder of the same role may revoke this decision.",
      );
    const revocation: Revocation = {
      schemaVersion: 1,
      decisionId: id,
      actor: { id: actorId, login: comment.author.login },
      reason: args.reason as string,
      source: { commentId: comment.id },
      recordedAt: this.deps.clock.now().toISOString(),
    };
    const result = await this.deps.evidence.write(
      revocationPath(this.repositoryId, issue.number, id),
      revocation,
    );
    return result === "created" ? `**Đã thu hồi** \`${id}\`.` : `\`${id}\` đã bị thu hồi trước đó.`;
  }

  async listDecisions(issueNumber: number): Promise<DecisionReceipt[]> {
    const paths = await this.deps.evidence.list(`decisions/${this.repositoryId}/${issueNumber}/`);
    const receipts: DecisionReceipt[] = [];
    for (const path of paths) {
      const receipt = await this.deps.evidence.read<DecisionReceipt>(path);
      if (receipt) receipts.push(receipt);
    }
    return receipts;
  }

  async isValid(
    receipt: DecisionReceipt,
    policy: Policy,
  ): Promise<{ valid: boolean; reasons: string[] }> {
    const { evidence, github } = this.deps;
    const revoked =
      (await evidence.read(
        revocationPath(this.repositoryId, receipt.issueNumber, receipt.decisionId),
      )) !== null;
    const comment = await github.getComment(receipt.source.commentId);
    const snapshot = await evidence.read<BaselineSnapshot>(
      baselinePath(this.repositoryId, receipt.issueNumber, receipt.baselineId),
    );
    const snapshotHash = snapshot && verifySnapshot(snapshot) ? snapshot.contentHash : null;
    let buildValid: boolean | undefined;
    if (receipt.kind === "accept" && receipt.build) {
      const { problems } = await this.buildProblems(
        receipt.build.runId,
        receipt.build.headSha,
        policy,
      );
      buildValid = problems.length === 0;
    }
    return evaluateReceipt(receipt, {
      policy,
      revoked,
      currentCommentBody: comment ? comment.body : null,
      snapshotHash,
      ...(buildValid === undefined ? {} : { buildValid }),
    });
  }

  async findValidDecision(
    issueNumber: number,
    baselineId: string,
    kind: DecisionKind,
    policy: Policy,
  ): Promise<DecisionReceipt | null> {
    for (const receipt of await this.listDecisions(issueNumber)) {
      if (receipt.kind !== kind || receipt.baselineId !== baselineId) continue;
      if ((await this.isValid(receipt, policy)).valid) return receipt;
    }
    return null;
  }

  private async reportInvalidatedDecisions(
    issueNumber: number,
    commentId: number,
    action: string,
  ): Promise<void> {
    const affected = (await this.listDecisions(issueNumber)).filter(
      (receipt) => receipt.source.commentId === commentId,
    );
    if (affected.length === 0) return;
    await this.deps.github.upsertComment(
      issueNumber,
      marker("invalidated", String(commentId)),
      `Comment quyết định đã bị ${action === "deleted" ? "xóa" : "sửa"}; các quyết định sau không còn hiệu lực: ${affected
        .map((receipt) => `\`${receipt.decisionId}\` (${receipt.kind})`)
        .join(", ")}.`,
    );
  }

  /** Evaluates the `ai-dlc/baseline` gate for a pull request and publishes a commit status. */
  async checkPullRequest(prNumber: number): Promise<PrCheckResult> {
    const pr = await this.deps.github.getPullRequest(prNumber);
    const result = this.deps.enabled
      ? await this.evaluatePullRequest(prNumber).catch((error: unknown) => {
          if (!isAiDlcError(error)) throw error;
          return {
            state: "failure" as const,
            description: `${error.code}: ${firstLine(error.message)}`,
            details: [error.message],
          };
        })
      : {
          state: "pending" as const,
          description: "AI-DLC is disabled by the operator",
          details: [],
        };
    await this.deps.github.setCommitStatus(pr.headSha, {
      state: result.state,
      context: STATUS_CONTEXT,
      description: truncate(result.description, 140),
    });
    return result;
  }

  private async evaluatePullRequest(prNumber: number): Promise<PrCheckResult> {
    const { github } = this.deps;
    const policy = await this.policy();
    const pr = await github.getPullRequest(prNumber);
    for (const reference of closingReferences(pr.body)) {
      const referenced = await github.getIssue(reference).catch(() => null);
      const kind = referenced ? kindFromLabels(referenced.labels) : null;
      if (kind === "story" || kind === "epic") {
        throw new AiDlcError(
          "E_CLOSING_KEYWORD",
          `Use \`Refs #${reference}\`; closing keywords would close the ${kind} without acceptance.`,
        );
      }
    }
    if (pr.labels.includes(LABELS.exempt)) {
      return { state: "success", description: "Exempt by maintainer label", details: [] };
    }
    const block = parsePrBlock(pr.body);
    if (!block)
      throw new AiDlcError(
        "E_PR_BLOCK",
        "PR body has no AI-DLC block. Run the context CLI or use the ready reply.",
      );
    const issue = await github.getIssue(block.issueNumber);
    const snapshot = await this.loadSnapshot(issue.number, block.baselineId);
    if (snapshot.contentHash !== block.hash)
      throw new AiDlcError("E_HASH_MISMATCH", "AI-DLC-Hash does not match the baseline.");
    if (snapshot.kind === "epic")
      throw new AiDlcError("E_PR_BLOCK", "A PR must reference a story or task, not an epic.");
    this.assertCurrent(issue, snapshot);
    const ready = await this.findValidDecision(issue.number, snapshot.baselineId, "ready", policy);
    if (!ready || !ready.lane)
      throw new AiDlcError(
        "E_NOT_READY",
        `#${issue.number} has no valid ready decision for this baseline.`,
      );
    await this.assertApproved(snapshot, ready.lane, policy);
    const allowedAc = new Set(
      snapshot.kind === "task" ? snapshot.acRefs : snapshot.requirements.criteria.map((c) => c.id),
    );
    const unknown = block.acceptanceCriteria.filter((id) => !allowedAc.has(id));
    if (unknown.length > 0)
      throw new AiDlcError("E_PR_BLOCK", `Unknown AC for this baseline: ${unknown.join(", ")}.`);
    if (snapshot.kind === "task" && snapshot.parent !== null)
      await this.assertParentReady(snapshot.parent, policy);
    if (ready.lane === "fast") {
      const sensitive = (await github.listPullRequestFiles(prNumber)).filter((path) =>
        isSensitive(policy, path),
      );
      if (sensitive.length > 0) {
        throw new AiDlcError(
          "E_SENSITIVE_PATH",
          `Lane fast cannot change sensitive paths: ${sensitive.slice(0, 5).join(", ")}.`,
        );
      }
    }
    return {
      state: "success",
      description: `${snapshot.baselineId} ready (${ready.lane})`,
      details: [],
    };
  }

  /** PO approves stories; a task inherits the approval of its parent story's current content. */
  private async assertApproved(
    snapshot: BaselineSnapshot,
    lane: LaneName,
    policy: Policy,
  ): Promise<void> {
    if (!policy.lanes[lane].requires_po_approval) return;
    if (snapshot.kind === "task") {
      if (snapshot.parent === null) {
        throw new AiDlcError("E_FORM", "A task needs a parent story in `### Issue cha`.");
      }
      if (!(await this.parentDecision(snapshot.parent, "approve", policy))) {
        throw new AiDlcError(
          "E_NOT_APPROVED",
          `Lane \`${lane}\` requires a valid PO approval of parent story #${snapshot.parent} for its current content.`,
        );
      }
      return;
    }
    if (
      !(await this.findValidDecision(
        snapshot.source.issueNumber,
        snapshot.baselineId,
        "approve",
        policy,
      ))
    ) {
      throw new AiDlcError(
        "E_NOT_APPROVED",
        `Lane \`${lane}\` requires a valid PO approval for this baseline.`,
      );
    }
  }

  private async parentDecision(
    parentNumber: number,
    kind: DecisionKind,
    policy: Policy,
  ): Promise<DecisionReceipt | null> {
    const parent = await this.deps.github.getIssue(parentNumber);
    if (kindFromLabels(parent.labels) !== "story") {
      throw new AiDlcError("E_WRONG_KIND", `Parent #${parentNumber} of a task must be a story.`);
    }
    const current = this.snapshotOf(parent);
    return this.findValidDecision(parentNumber, current.baselineId, kind, policy);
  }

  private async assertParentReady(parentNumber: number, policy: Policy): Promise<void> {
    if (!(await this.parentDecision(parentNumber, "ready", policy))) {
      throw new AiDlcError(
        "E_NOT_READY",
        `Parent story #${parentNumber} has no valid ready decision for its current content.`,
      );
    }
  }
}

function errorReply(error: AiDlcError): string {
  return [`**AI-DLC: \`${error.code}\`**`, "", sanitize(error.message)].join("\n");
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
