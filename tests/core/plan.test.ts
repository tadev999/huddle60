import { describe, expect, it } from "vitest";
import {
  blockingQuestions,
  computePlanHash,
  creationOrder,
  modelPlanJsonSchema,
  parseModelPlan,
  validatePlanSemantics,
  type ModelPlan,
} from "../../src/core/plan.js";
import { loginPlan } from "../helpers/fixtures.js";

const limits = { maxNodes: 60 };

function errorOf(plan: ModelPlan): string {
  try {
    validatePlanSemantics(plan, limits);
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

describe("plan validation", () => {
  it("accepts a well-formed plan", () => {
    expect(parseModelPlan(JSON.stringify(loginPlan()), limits).nodes).toHaveLength(5);
  });

  it("rejects invalid JSON and schema violations", () => {
    expect(() => parseModelPlan("not json", limits)).toThrow(/not valid JSON/u);
    expect(() => parseModelPlan(JSON.stringify({ rootKind: "epic" }), limits)).toThrow(
      /plan schema/u,
    );
  });

  it("enforces a single root that matches rootKind", () => {
    const plan = loginPlan();
    plan.nodes[1]!.parentLocalId = null;
    expect(errorOf(plan)).toMatch(/exactly one root/u);
    expect(errorOf(loginPlan({ rootKind: "story" }))).toMatch(/does not match rootKind/u);
  });

  it("enforces the epic > story > task hierarchy", () => {
    const plan = loginPlan();
    plan.nodes[2]!.parentLocalId = "epic-auth";
    expect(errorOf(plan)).toMatch(/cannot be a child of epic/u);
  });

  it("requires criteria with correct prefixes and valid task AC references", () => {
    const missing = loginPlan();
    missing.nodes[1]!.criteria = [];
    expect(errorOf(missing)).toMatch(/at least one criterion/u);
    const prefix = loginPlan();
    prefix.nodes[0]!.criteria = [{ id: "AC-01", text: "x" }];
    expect(errorOf(prefix)).toMatch(/EC-/u);
    const badRef = loginPlan();
    badRef.nodes[2]!.acRefs = ["AC-09"];
    expect(errorOf(badRef)).toMatch(/does not define/u);
  });

  it("detects dangling references, self blocks and dependency cycles", () => {
    const dangling = loginPlan();
    dangling.nodes[3]!.blockedBy = ["nope"];
    expect(errorOf(dangling)).toMatch(/missing `nope`/u);
    const self = loginPlan();
    self.nodes[3]!.blockedBy = ["task-login-ui"];
    expect(errorOf(self)).toMatch(/cannot block itself/u);
    const cycle = loginPlan();
    cycle.nodes[2]!.blockedBy = ["task-login-ui"];
    expect(errorOf(cycle)).toMatch(/cycle/u);
  });

  it("enforces the node limit", () => {
    expect(() => validatePlanSemantics(loginPlan(), { maxNodes: 3 })).toThrow(/limit is 3/u);
  });

  it("orders creation so parents and blockers come first", () => {
    const order = creationOrder(loginPlan().nodes).map((node) => node.localId);
    expect(order.indexOf("epic-auth")).toBe(0);
    expect(order.indexOf("task-oauth-setup")).toBeLessThan(order.indexOf("task-login-ui"));
    expect(order.indexOf("story-login")).toBeLessThan(order.indexOf("story-logout"));
  });

  it("hash depends on the request digest and plan content only", () => {
    const plan = loginPlan();
    expect(computePlanHash("sha256:r", plan)).toBe(
      computePlanHash("sha256:r", structuredClone(plan)),
    );
    expect(computePlanHash("sha256:r", plan)).not.toBe(computePlanHash("sha256:other", plan));
    expect(
      blockingQuestions(loginPlan({ openQuestions: [{ text: "A?", blocking: true }] })),
    ).toEqual(["A?"]);
  });

  it("exposes a JSON schema for structured model output", () => {
    const schema = modelPlanJsonSchema();
    expect(schema.type).toBe("object");
    expect(JSON.stringify(schema)).toContain("rootKind");
  });
});
