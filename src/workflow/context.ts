import { baselinePath, type BaselineSnapshot } from "../core/baseline.js";
import { AiDlcError } from "../core/errors.js";
import { parseIssueForm } from "../core/issue-form.js";
import type { Policy } from "../core/policy.js";
import { renderPrBlock } from "../core/pr-block.js";
import { KNOWLEDGE_PATH, SECTIONS } from "../core/vocabulary.js";
import type { EvidenceStore, GitHubPort } from "../ports.js";
import type { WorkflowService } from "./service.js";

/**
 * Renders the approved baseline of an Issue as Markdown for a coding agent.
 * With `draft`, returns the raw Issue marked as clarification-only.
 */
export async function renderAgentContext(
  deps: { github: GitHubPort; evidence: EvidenceStore; workflow: WorkflowService },
  policy: Policy,
  issueNumber: number,
  draft = false,
): Promise<string> {
  const { github, evidence, workflow } = deps;
  const issue = await github.getIssue(issueNumber);
  if (draft) {
    return [
      `# DRAFT context for #${issueNumber} — clarification only, do not implement`,
      "",
      `## ${issue.title}`,
      "",
      issue.body,
    ].join("\n");
  }

  const ready = (await workflow.listDecisions(issueNumber))
    .filter((receipt) => receipt.kind === "ready")
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  for (const receipt of ready) {
    if (!(await workflow.isValid(receipt, policy)).valid) continue;
    const snapshot = await evidence.read<BaselineSnapshot>(
      baselinePath(github.repo.repositoryId, issueNumber, receipt.baselineId),
    );
    if (!snapshot) continue;
    const stale = workflow.snapshotOf(issue).contentHash !== snapshot.contentHash;
    const acceptanceCriteria =
      snapshot.kind === "task" ? snapshot.acRefs : snapshot.requirements.criteria.map((c) => c.id);
    const sections = Object.entries(snapshot.requirements.sections)
      .filter(([, value]) => value.length > 0)
      .map(([heading, value]) => `### ${heading}\n\n${value}`);
    const impact = parseIssueForm(issue.body).get(SECTIONS.impact);
    const hasKnowledge = (await github.readFile(KNOWLEDGE_PATH).catch(() => null)) !== null;
    return [
      `# huddle60 context for #${issueNumber}`,
      "",
      `Baseline \`${snapshot.baselineId}\` · lane \`${receipt.lane}\` · ${snapshot.kind}`,
      ...(stale
        ? [
            "",
            "> WARNING: the Issue changed after this baseline. Stop and ask the DEV/PO before implementing.",
          ]
        : []),
      "",
      "## AI Engineering Directive",
      "- Implement this as a complete, vertical testable slice across all required layers (UI, API, Data).",
      "- You MUST write or update automated tests verifying that all acceptance criteria below pass before submitting the PR.",
      "- Implement only what this baseline describes. Do not run /huddle60 approve, ready or accept.",
      ...(hasKnowledge
        ? [
            `- Read \`${KNOWLEDGE_PATH}\` for architecture, conventions and test commands before coding.`,
          ]
        : []),
      "",
      `## ${snapshot.requirements.title}`,
      "",
      sections.join("\n\n"),
      ...(impact
        ? [
            "",
            "## Impact map (advisory, not part of the baseline)",
            "",
            "Starting points suggested from the source code. Verify them; they do not limit the scope.",
            "",
            impact.replace(/^---[\s\S]*$/mu, "").trim(),
          ]
        : []),
      "",
      "## PR body block",
      "",
      "```text",
      renderPrBlock({
        issueNumber,
        baselineId: snapshot.baselineId,
        hash: snapshot.contentHash,
        acceptanceCriteria,
      }),
      "```",
    ].join("\n");
  }
  throw new AiDlcError(
    "E_NOT_READY",
    `#${issueNumber} has no valid ready decision. Ask a DEV to run /huddle60 ready, or use --draft.`,
  );
}
