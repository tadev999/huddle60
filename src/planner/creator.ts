import { AiDlcError, isAiDlcError } from "../core/errors.js";
import { creationOrder, type PlanRecord } from "../core/plan.js";
import type { Policy } from "../core/policy.js";
import {
  findMarker,
  issueTitle,
  marker,
  renderCreationSummary,
  renderNodeBody,
} from "../core/render.js";
import { KIND_LABEL, LABELS } from "../core/vocabulary.js";
import type { Clock, CreationLedger, GitHubPort, IssueData, Logger, PlanStore } from "../ports.js";

const LEASE_MS = 10 * 60 * 1000;

export interface CreatorDeps {
  github: GitHubPort;
  store: PlanStore;
  clock: Clock;
  logger: Logger;
  leaseOwner: string;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates the Issue tree of a confirmed plan, parent-first. A write-ahead ledger
 * records each attempt so a crash between "GitHub created the Issue" and "ledger
 * saved it" is reconciled by marker lookup instead of creating a duplicate.
 */
export class IssueTreeCreator {
  constructor(private readonly deps: CreatorDeps) {}

  async create(record: PlanRecord, policy: Policy): Promise<CreationLedger> {
    const { github, store, clock, leaseOwner } = this.deps;
    const leaseKey = `plan:${record.planId}`;
    if (!(await store.acquireLease(leaseKey, leaseOwner, LEASE_MS))) {
      throw new AiDlcError(
        "E_PLAN_PARTIAL",
        "Another worker is creating Issues for this plan. Try resume later.",
      );
    }
    const ledger: CreationLedger = (await store.getLedger(record.planId)) ?? {
      planId: record.planId,
      planHash: record.planHash,
      status: "creating",
      items: {},
      errors: [],
      updatedAt: clock.now().toISOString(),
    };
    if (ledger.planHash !== record.planHash) {
      await store.releaseLease(leaseKey, leaseOwner);
      throw new AiDlcError("E_CONFLICT", "Ledger belongs to a different plan hash.");
    }
    const save = async () => {
      ledger.updatedAt = clock.now().toISOString();
      await store.saveLedger(ledger);
    };
    const numbers = new Map<string, number>();
    for (const [localId, item] of Object.entries(ledger.items)) {
      if (item.state === "created" && item.issueNumber !== undefined)
        numbers.set(localId, item.issueNumber);
    }
    ledger.errors = [];
    try {
      let existing: Map<string, IssueData> | null = null;
      for (const node of creationOrder(record.plan.nodes)) {
        const item = ledger.items[node.localId];
        if (item?.state === "created") continue;
        if (item?.state === "creating") {
          existing ??= await this.indexPlanIssues(record.planId);
          const found = existing.get(node.localId);
          if (found) {
            ledger.items[node.localId] = {
              ...item,
              state: "created",
              issueNumber: found.number,
              issueId: found.id,
              issueNodeId: found.nodeId,
            };
            numbers.set(node.localId, found.number);
            await save();
            continue;
          }
        }
        ledger.items[node.localId] = { state: "creating", attemptedAt: clock.now().toISOString() };
        await save();
        const created = await github.createIssue({
          title: issueTitle(node),
          body: renderNodeBody(record, node, numbers),
          labels: [KIND_LABEL[node.kind], LABELS.fromPlan],
        });
        ledger.items[node.localId] = {
          state: "created",
          issueNumber: created.number,
          issueId: created.id,
          issueNodeId: created.nodeId,
          attemptedAt: clock.now().toISOString(),
        };
        numbers.set(node.localId, created.number);
        await save();
      }
      await this.linkCreatedIssues(record, ledger, policy);
      ledger.status = "created";
      await save();
      await store.savePlan({ ...record, status: "created" });
      await github.addLabels(record.source.issueNumber, [LABELS.planCreated]);
      await github.removeLabel(record.source.issueNumber, LABELS.planDraft);
      await github.removeLabel(record.source.issueNumber, LABELS.planPartial);
      await github.upsertComment(
        record.source.issueNumber,
        marker("plan-result", record.planId),
        renderCreationSummary(record, numbers, true, ledger.errors),
      );
      return ledger;
    } catch (error) {
      ledger.status = "partial";
      ledger.errors.push(
        isAiDlcError(error) ? error.message : "Unexpected error while creating Issues.",
      );
      await save();
      await store.savePlan({ ...record, status: "partial" });
      await github.addLabels(record.source.issueNumber, [LABELS.planPartial]);
      await github.upsertComment(
        record.source.issueNumber,
        marker("plan-result", record.planId),
        renderCreationSummary(record, numbers, false, ledger.errors),
      );
      throw error;
    } finally {
      await store.releaseLease(leaseKey, leaseOwner);
    }
  }

  private async indexPlanIssues(planId: string): Promise<Map<string, IssueData>> {
    const index = new Map<string, IssueData>();
    for (const issue of await this.deps.github.listIssuesWithLabel(LABELS.fromPlan)) {
      const value = findMarker(issue.body, "plan-node");
      if (!value) continue;
      const [markerPlan, localId] = value.split("/");
      if (markerPlan === planId && localId) index.set(localId, issue);
    }
    return index;
  }

  /** Sub-issue and Project links are best effort: Issue bodies already carry parent references. */
  private async linkCreatedIssues(
    record: PlanRecord,
    ledger: CreationLedger,
    policy: Policy,
  ): Promise<void> {
    const { github, logger } = this.deps;
    for (const node of creationOrder(record.plan.nodes)) {
      const item = ledger.items[node.localId];
      if (!item || item.issueNumber === undefined) continue;
      if (node.parentLocalId && item.subIssue === undefined) {
        const parent = ledger.items[node.parentLocalId];
        try {
          item.subIssue =
            parent?.issueNumber !== undefined && item.issueId !== undefined
              ? await github.addSubIssue(parent.issueNumber, item.issueId)
              : "failed";
        } catch (error) {
          item.subIssue = "failed";
          ledger.errors.push(`Could not link #${item.issueNumber} as a sub-issue.`);
          logger.warn("sub-issue link failed", {
            issue: item.issueNumber,
            error: errorMessage(error),
          });
        }
      }
      if (item.project === undefined) {
        if (!policy.project || item.issueNodeId === undefined) {
          item.project = "skipped";
        } else {
          try {
            await github.addToProject(policy.project, item.issueNodeId);
            item.project = "added";
          } catch (error) {
            item.project = "failed";
            ledger.errors.push(`Could not add #${item.issueNumber} to the Project.`);
            logger.warn("project add failed", {
              issue: item.issueNumber,
              error: errorMessage(error),
            });
          }
        }
      }
    }
  }
}
