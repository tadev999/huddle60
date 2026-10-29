import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parsePolicy } from "../src/core/policy.js";
import {
  CRITERIA_SECTION,
  KIND_LABEL,
  LABELS,
  REQUIREMENT_SECTIONS,
  SECTIONS,
  type WorkItemKind,
} from "../src/core/vocabulary.js";

interface IssueForm {
  labels: string[];
  body: Array<{ type: string; attributes: { label?: string } }>;
}

async function form(name: string): Promise<IssueForm> {
  return parse(await readFile(`templates/.github/ISSUE_TEMPLATE/${name}.yml`, "utf8")) as IssueForm;
}

function labelsOf(issueForm: IssueForm): string[] {
  return issueForm.body
    .filter((field) => field.type !== "markdown")
    .map((field) => field.attributes.label as string);
}

describe("adopter templates", () => {
  it.each(["epic", "story", "task"] as WorkItemKind[])(
    "%s form headings match what the parser reads",
    async (kind) => {
      const issueForm = await form(kind);
      expect(issueForm.labels).toEqual([KIND_LABEL[kind]]);
      expect(new Set(labelsOf(issueForm))).toEqual(new Set(REQUIREMENT_SECTIONS[kind]));
      const criteria = CRITERIA_SECTION[kind];
      if (criteria) expect(labelsOf(issueForm)).toContain(criteria);
    },
  );

  it("request form carries the request label and field", async () => {
    const issueForm = await form("request");
    expect(issueForm.labels).toEqual([LABELS.request]);
    expect(labelsOf(issueForm)).toEqual([SECTIONS.request]);
  });

  it("example policy is valid", async () => {
    const policy = parsePolicy(await readFile("templates/.github/ai-dlc/policy.yml", "utf8"));
    expect(policy.roles.po).toHaveLength(1);
  });
});
