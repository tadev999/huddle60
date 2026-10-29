import { z } from "zod";
import { canonicalJson, sha256, shortHash } from "./canonical.js";
import { AiDlcError } from "./errors.js";
import type { WorkItemKind } from "./vocabulary.js";

const LOCAL_ID = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const Text = (max: number) => z.string().trim().min(1).max(max);

const CriterionSchema = z.object({
  id: z.string().regex(/^(AC|EC)-\d{2,3}$/u),
  text: Text(500),
});

const NodeSchema = z.object({
  localId: z.string().regex(LOCAL_ID),
  kind: z.enum(["epic", "story", "task"]),
  parentLocalId: z.string().regex(LOCAL_ID).nullable(),
  title: Text(120),
  goal: Text(1000),
  scope: z.array(Text(300)).max(15),
  outOfScope: z.array(Text(300)).max(10),
  criteria: z.array(CriterionSchema).max(20),
  acRefs: z.array(z.string().regex(/^AC-\d{2,3}$/u)).max(20),
  blockedBy: z.array(z.string().regex(LOCAL_ID)).max(10),
  riskNotes: z.array(Text(300)).max(10),
});

/** Shape the model must return. Server-owned fields (ids, hashes, source) are added later. */
export const ModelPlanSchema = z.object({
  rootKind: z.enum(["epic", "story"]),
  summary: Text(1000),
  assumptions: z.array(Text(300)).max(15),
  openQuestions: z.array(z.object({ text: Text(300), blocking: z.boolean() })).max(15),
  nodes: z.array(NodeSchema).min(1).max(200),
});

export type ModelPlan = z.infer<typeof ModelPlanSchema>;
export type PlanNode = z.infer<typeof NodeSchema>;

export const PLAN_SCHEMA_VERSION = 1;

/** JSON Schema handed to Gemini as `responseJsonSchema`. */
export function modelPlanJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ModelPlanSchema, { target: "draft-7" }) as Record<string, unknown>;
}

export interface PlanLimits {
  maxNodes: number;
}

/** Parses model output text and enforces structural and semantic rules. */
export function parseModelPlan(text: string, limits: PlanLimits): ModelPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AiDlcError("E_PLAN_SCHEMA", "Model output is not valid JSON.", { cause: error });
  }
  const parsed = ModelPlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AiDlcError(
      "E_PLAN_SCHEMA",
      `Model output does not match the plan schema:\n${z.prettifyError(parsed.error)}`,
    );
  }
  validatePlanSemantics(parsed.data, limits);
  return parsed.data;
}

export function validatePlanSemantics(plan: ModelPlan, limits: PlanLimits): void {
  if (plan.nodes.length > limits.maxNodes) {
    throw new AiDlcError(
      "E_PLAN_LIMIT",
      `Plan has ${plan.nodes.length} items; the limit is ${limits.maxNodes}. Split the request into smaller requests.`,
    );
  }
  const problems: string[] = [];
  const byId = new Map<string, PlanNode>();
  for (const node of plan.nodes) {
    if (byId.has(node.localId)) problems.push(`Duplicate localId \`${node.localId}\`.`);
    byId.set(node.localId, node);
  }
  const roots = plan.nodes.filter((node) => node.parentLocalId === null);
  if (roots.length !== 1) problems.push(`Plan must have exactly one root; found ${roots.length}.`);
  else if (roots[0]?.kind !== plan.rootKind) {
    problems.push(`Root kind \`${roots[0]?.kind}\` does not match rootKind \`${plan.rootKind}\`.`);
  }
  const expectedParent: Record<WorkItemKind, WorkItemKind | null> = {
    epic: null,
    story: "epic",
    task: "story",
  };
  for (const node of plan.nodes) {
    const label = `\`${node.localId}\``;
    if (node.parentLocalId !== null) {
      const parent = byId.get(node.parentLocalId);
      if (!parent) problems.push(`${label} references missing parent \`${node.parentLocalId}\`.`);
      else if (parent.kind !== expectedParent[node.kind]) {
        problems.push(
          `${label} (${node.kind}) cannot be a child of ${parent.kind} \`${parent.localId}\`.`,
        );
      }
    } else if (node.kind === "task") {
      problems.push(`${label}: a task cannot be the root.`);
    }
    if (node.kind === "epic" && plan.rootKind === "story")
      problems.push(`${label}: no epic allowed when rootKind is story.`);
    const prefix = node.kind === "epic" ? "EC-" : "AC-";
    if (node.kind !== "task") {
      if (node.criteria.length === 0) problems.push(`${label} must have at least one criterion.`);
      if (node.criteria.some((criterion) => !criterion.id.startsWith(prefix))) {
        problems.push(`${label} criteria must use the \`${prefix}\` prefix.`);
      }
      if (node.acRefs.length > 0) problems.push(`${label}: only tasks may use acRefs.`);
    } else {
      if (node.criteria.length > 0)
        problems.push(`${label}: tasks use acRefs instead of criteria.`);
      const parent = node.parentLocalId ? byId.get(node.parentLocalId) : undefined;
      const parentAc = new Set(parent?.criteria.map((criterion) => criterion.id));
      for (const ref of node.acRefs) {
        if (!parentAc.has(ref))
          problems.push(`${label} references \`${ref}\` that its story does not define.`);
      }
    }
    const ids = node.criteria.map((criterion) => criterion.id);
    if (new Set(ids).size !== ids.length) problems.push(`${label} has duplicate criterion ids.`);
    for (const dependency of node.blockedBy) {
      if (dependency === node.localId) problems.push(`${label} cannot block itself.`);
      else if (!byId.has(dependency))
        problems.push(`${label} is blocked by missing \`${dependency}\`.`);
    }
  }
  if (problems.length === 0) {
    try {
      creationOrder(plan.nodes);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  if (problems.length > 0) {
    throw new AiDlcError("E_PLAN_SCHEMA", `Plan failed validation:\n- ${problems.join("\n- ")}`);
  }
}

/**
 * Orders nodes so that every parent and every blocking item is created first,
 * which lets bodies reference real Issue numbers. Input order breaks ties.
 */
export function creationOrder(nodes: readonly PlanNode[]): PlanNode[] {
  const byId = new Map(nodes.map((node) => [node.localId, node]));
  const state = new Map<string, "visiting" | "done">();
  const ordered: PlanNode[] = [];
  const visit = (node: PlanNode, trail: string[]) => {
    const current = state.get(node.localId);
    if (current === "done") return;
    if (current === "visiting") {
      throw new Error(`Dependency cycle: ${[...trail, node.localId].join(" -> ")}.`);
    }
    state.set(node.localId, "visiting");
    const prerequisites = [node.parentLocalId, ...node.blockedBy].filter(
      (id): id is string => id !== null,
    );
    for (const id of prerequisites) {
      const prerequisite = byId.get(id);
      if (prerequisite) visit(prerequisite, [...trail, node.localId]);
    }
    state.set(node.localId, "done");
    ordered.push(node);
  };
  for (const node of nodes) visit(node, []);
  return ordered;
}

export type PlanStatus = "draft" | "superseded" | "stale" | "creating" | "partial" | "created";

export interface PlanSource {
  repositoryId: number;
  owner: string;
  repo: string;
  issueNumber: number;
  issueNodeId: string;
  requestDigest: string;
}

export interface PlanRecord {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  planId: string;
  revision: number;
  status: PlanStatus;
  source: PlanSource;
  model: string;
  plan: ModelPlan;
  planHash: string;
  clarifications: string[];
  requestedBy: number;
  createdAt: string;
  expiresAt: string;
}

export function computePlanHash(requestDigest: string, plan: ModelPlan): string {
  return sha256(canonicalJson({ schemaVersion: PLAN_SCHEMA_VERSION, requestDigest, plan }));
}

export function computeRequestDigest(title: string, body: string): string {
  return sha256(canonicalJson({ title, body }));
}

export function buildPlanId(issueNumber: number, revision: number, planHash: string): string {
  return `plan-${issueNumber}-r${revision}-${shortHash(planHash, 8)}`;
}

export function blockingQuestions(plan: ModelPlan): string[] {
  return plan.openQuestions
    .filter((question) => question.blocking)
    .map((question) => question.text);
}
