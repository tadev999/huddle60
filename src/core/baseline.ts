import { CANONICAL_VERSION, contentHash, shortHash } from "./canonical.js";
import { AiDlcError } from "./errors.js";
import { parseCriteria, parseIssueForm, parseIssueRefs, type Criterion } from "./issue-form.js";
import {
  CRITERIA_SECTION,
  REQUIREMENT_SECTIONS,
  SECTIONS,
  kindFromLabels,
  type WorkItemKind,
} from "./vocabulary.js";

export const BASELINE_SCHEMA_VERSION = 1;

export interface IssueSnapshotInput {
  repositoryId: number;
  issueNodeId: string;
  number: number;
  title: string;
  body: string | null;
  labels: readonly string[];
}

export interface BaselineSnapshot {
  schemaVersion: typeof BASELINE_SCHEMA_VERSION;
  canonicalVersion: typeof CANONICAL_VERSION;
  baselineId: string;
  kind: WorkItemKind;
  source: { repositoryId: number; issueNodeId: string; issueNumber: number };
  requirements: {
    title: string;
    sections: Record<string, string>;
    criteria: Criterion[];
  };
  parent: number | null;
  blockedBy: number[];
  acRefs: string[];
  contentHash: string;
}

function hashedPart(snapshot: Omit<BaselineSnapshot, "baselineId" | "contentHash">) {
  return {
    schemaVersion: snapshot.schemaVersion,
    canonicalVersion: snapshot.canonicalVersion,
    kind: snapshot.kind,
    source: snapshot.source,
    requirements: snapshot.requirements,
    parent: snapshot.parent,
    blockedBy: snapshot.blockedBy,
    acRefs: snapshot.acRefs,
  };
}

/** Builds the immutable requirement snapshot from the current Issue content. */
export function buildBaseline(issue: IssueSnapshotInput): BaselineSnapshot {
  const kind = kindFromLabels(issue.labels);
  if (!kind) {
    throw new AiDlcError(
      "E_FORM",
      "Issue needs exactly one of the labels type:epic, type:story or type:task.",
    );
  }
  const parsed = parseIssueForm(issue.body);
  const sections: Record<string, string> = {};
  for (const label of REQUIREMENT_SECTIONS[kind]) sections[label] = parsed.get(label) ?? "";
  if (!sections[SECTIONS.goal]) {
    throw new AiDlcError("E_FORM", `Section \`### ${SECTIONS.goal}\` is required.`);
  }
  const criteriaSection = CRITERIA_SECTION[kind];
  const criteria = criteriaSection ? parseCriteria(sections[criteriaSection] ?? "") : [];
  if (criteriaSection && criteria.length === 0) {
    throw new AiDlcError(
      "E_FORM",
      `Section \`### ${criteriaSection}\` needs at least one criterion line.`,
    );
  }
  const expectedPrefix = kind === "epic" ? "EC-" : "AC-";
  if (criteria.some((criterion) => !criterion.id.startsWith(expectedPrefix))) {
    throw new AiDlcError("E_FORM", `${kind} criteria must use the ${expectedPrefix} prefix.`);
  }
  const parentRefs = parseIssueRefs(sections[SECTIONS.parent]);
  if (parentRefs.length > 1) throw new AiDlcError("E_FORM", "Only one parent Issue is allowed.");
  const acRefs =
    kind === "task"
      ? (sections[SECTIONS.acRefs] ?? "")
          .split(/[\s,]+/u)
          .filter((value) => value.length > 0)
          .map((value) => {
            if (!/^AC-\d{2,3}$/u.test(value))
              throw new AiDlcError("E_FORM", `Invalid AC reference \`${value}\`.`);
            return value;
          })
      : [];
  const base = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    canonicalVersion: CANONICAL_VERSION,
    kind,
    source: {
      repositoryId: issue.repositoryId,
      issueNodeId: issue.issueNodeId,
      issueNumber: issue.number,
    },
    requirements: { title: issue.title, sections, criteria },
    parent: parentRefs[0] ?? null,
    blockedBy: parseIssueRefs(sections[SECTIONS.blockedBy]),
    acRefs,
  } as const;
  const hash = contentHash(hashedPart(base));
  return { ...base, baselineId: `bl-${issue.number}-${shortHash(hash)}`, contentHash: hash };
}

/** Recomputes the hash of a stored snapshot to detect tampering or corruption. */
export function verifySnapshot(snapshot: BaselineSnapshot): boolean {
  return contentHash(hashedPart(snapshot)) === snapshot.contentHash;
}

export function baselinePath(
  repositoryId: number,
  issueNumber: number,
  baselineId: string,
): string {
  return `baselines/${repositoryId}/${issueNumber}/${baselineId}.json`;
}
