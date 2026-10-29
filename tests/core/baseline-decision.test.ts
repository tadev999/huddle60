import { describe, expect, it } from "vitest";
import { buildBaseline, verifySnapshot } from "../../src/core/baseline.js";
import { commentDigest, evaluateReceipt, type DecisionReceipt } from "../../src/core/decision.js";
import { parsePolicy } from "../../src/core/policy.js";
import { DEV, PO, POLICY_YAML } from "../helpers/fakes.js";
import { storyBody } from "../helpers/fixtures.js";

const issue = {
  repositoryId: 777,
  issueNodeId: "I_1",
  number: 11,
  title: "[Story] Đăng nhập",
  body: storyBody({ parent: "#10", blockedBy: "#12" }),
  labels: ["type:story"],
};

describe("baseline", () => {
  it("builds a stable, verifiable snapshot", () => {
    const snapshot = buildBaseline(issue);
    expect(snapshot.baselineId).toMatch(/^bl-11-[0-9a-f]{12}$/u);
    expect(snapshot.parent).toBe(10);
    expect(snapshot.blockedBy).toEqual([12]);
    expect(snapshot.requirements.criteria.map((c) => c.id)).toEqual(["AC-01"]);
    expect(verifySnapshot(snapshot)).toBe(true);
    expect(buildBaseline({ ...issue, body: `${issue.body}\r\n` }).contentHash).toBe(
      snapshot.contentHash,
    );
  });

  it("changes when requirement content changes and detects tampering", () => {
    const snapshot = buildBaseline(issue);
    const changed = buildBaseline({
      ...issue,
      body: storyBody({ parent: "#10", blockedBy: "#12", criteria: "- AC-01: other" }),
    });
    expect(changed.contentHash).not.toBe(snapshot.contentHash);
    expect(verifySnapshot({ ...snapshot, parent: 99 })).toBe(false);
  });

  it("ignores sections outside the requirement and labels other than the kind", () => {
    const withNotes = buildBaseline({
      ...issue,
      body: `${issue.body}\n\n### Ghi chú tiến độ\n\nđang làm`,
      labels: ["type:story", "P1"],
    });
    expect(withNotes.contentHash).toBe(buildBaseline(issue).contentHash);
  });

  it("requires a kind label, a goal and criteria", () => {
    expect(() => buildBaseline({ ...issue, labels: [] })).toThrow(/exactly one/u);
    expect(() =>
      buildBaseline({ ...issue, body: storyBody({ criteria: "_No response_" }) }),
    ).toThrow(/at least one criterion/u);
  });
});

describe("decision receipt validity", () => {
  const policy = parsePolicy(POLICY_YAML);
  const body = "/ai-dlc approve baseline=bl-11-x hash=sha256:x";
  const receipt: DecisionReceipt = {
    schemaVersion: 1,
    decisionId: "dec-1",
    kind: "approve",
    issueNumber: 11,
    baselineId: "bl-11-x",
    baselineHash: "sha256:h",
    actor: { id: PO.id, login: PO.login },
    source: { commentId: 1, commentBodyDigest: commentDigest(body) },
    lane: null,
    build: null,
    policyVersion: 1,
    recordedAt: "2026-10-29T10:00:00Z",
  };
  const facts = { policy, revoked: false, currentCommentBody: body, snapshotHash: "sha256:h" };

  it("is valid when every fact still holds", () => {
    expect(evaluateReceipt(receipt, facts)).toEqual({ valid: true, reasons: [] });
  });

  it.each([
    [{ revoked: true }, /revoked/u],
    [{ currentCommentBody: null }, /deleted/u],
    [{ currentCommentBody: `${body} edited` }, /edited/u],
    [{ snapshotHash: null }, /missing or corrupt/u],
    [{ snapshotHash: "sha256:other" }, /mismatch/u],
  ])("becomes invalid when %o", (patch, reason) => {
    const result = evaluateReceipt(receipt, { ...facts, ...patch });
    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toMatch(reason);
  });

  it("becomes invalid when the actor loses the role", () => {
    const result = evaluateReceipt({ ...receipt, actor: { id: DEV.id, login: DEV.login } }, facts);
    expect(result.reasons.join(" ")).toMatch(/po role/u);
  });

  it("requires a valid build for acceptance", () => {
    const accept = { ...receipt, kind: "accept" as const };
    expect(evaluateReceipt(accept, facts).valid).toBe(false);
    expect(evaluateReceipt(accept, { ...facts, buildValid: true }).valid).toBe(true);
  });
});
