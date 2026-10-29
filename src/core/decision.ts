import { sha256, shortHash } from "./canonical.js";
import { hasRole, type LaneName, type Policy, type Role } from "./policy.js";

export const DECISION_SCHEMA_VERSION = 1;

export type DecisionKind = "approve" | "ready" | "accept";

export const REQUIRED_ROLE: Record<DecisionKind, Role> = {
  approve: "po",
  ready: "dev",
  accept: "po",
};

export interface BuildReference {
  runId: number;
  runAttempt: number;
  workflowPath: string;
  headSha: string;
}

export interface DecisionReceipt {
  schemaVersion: typeof DECISION_SCHEMA_VERSION;
  decisionId: string;
  kind: DecisionKind;
  issueNumber: number;
  baselineId: string;
  baselineHash: string;
  actor: { id: number; login: string };
  source: { commentId: number; commentBodyDigest: string };
  lane: LaneName | null;
  build: BuildReference | null;
  policyVersion: number;
  recordedAt: string;
}

export interface Revocation {
  schemaVersion: 1;
  decisionId: string;
  actor: { id: number; login: string };
  reason: string;
  source: { commentId: number };
  recordedAt: string;
}

export function decisionId(kind: DecisionKind, commentId: number): string {
  return `dec-${shortHash(sha256(`${kind}:${commentId}`), 16)}`;
}

export function commentDigest(body: string): string {
  return sha256(body.replace(/\r\n?/gu, "\n"));
}

export function decisionPath(repositoryId: number, issueNumber: number, id: string): string {
  return `decisions/${repositoryId}/${issueNumber}/${id}.json`;
}

export function revocationPath(repositoryId: number, issueNumber: number, id: string): string {
  return `revocations/${repositoryId}/${issueNumber}/${id}.json`;
}

/** Facts gathered at check time. Validity is never stored; it is recomputed on every use. */
export interface ValidityFacts {
  policy: Policy;
  revoked: boolean;
  /** Current body of the source comment, or null when it was deleted. */
  currentCommentBody: string | null;
  /** Hash of the snapshot recomputed from storage, or null when missing/corrupt. */
  snapshotHash: string | null;
  /** Only for `accept`: whether the referenced build still satisfies acceptance rules. */
  buildValid?: boolean;
}

export interface Validity {
  valid: boolean;
  reasons: string[];
}

export function evaluateReceipt(receipt: DecisionReceipt, facts: ValidityFacts): Validity {
  const reasons: string[] = [];
  if (facts.revoked) reasons.push("decision was revoked");
  if (facts.currentCommentBody === null) reasons.push("source comment was deleted");
  else if (commentDigest(facts.currentCommentBody) !== receipt.source.commentBodyDigest) {
    reasons.push("source comment was edited");
  }
  if (!hasRole(facts.policy, receipt.actor.id, REQUIRED_ROLE[receipt.kind])) {
    reasons.push(`actor no longer holds the ${REQUIRED_ROLE[receipt.kind]} role`);
  }
  if (facts.snapshotHash === null) reasons.push("baseline snapshot is missing or corrupt");
  else if (facts.snapshotHash !== receipt.baselineHash) reasons.push("baseline hash mismatch");
  if (receipt.kind === "accept" && facts.buildValid !== true)
    reasons.push("accepted build is no longer valid");
  return { valid: reasons.length === 0, reasons };
}
