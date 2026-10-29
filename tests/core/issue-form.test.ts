import { describe, expect, it } from "vitest";
import { parseCriteria, parseIssueForm, parseIssueRefs } from "../../src/core/issue-form.js";

describe("Issue form parsing", () => {
  it("reads sections and treats GitHub's _No response_ as empty", () => {
    const sections = parseIssueForm(
      "### Yêu cầu\n\nLập trình login\nsử dụng Firebase\n\n### Ghi chú\n\n_No response_\n",
    );
    expect(sections.get("Yêu cầu")).toBe("Lập trình login\nsử dụng Firebase");
    expect(sections.get("Ghi chú")).toBe("");
  });

  it("parses criteria and rejects malformed or duplicate ids", () => {
    expect(parseCriteria("- AC-01: Given a\n\nfree text\n- AC-02: Then b")).toEqual([
      { id: "AC-01", text: "Given a" },
      { id: "AC-02", text: "Then b" },
    ]);
    expect(() => parseCriteria("- AC-1: missing digit")).toThrow(/Malformed/u);
    expect(() => parseCriteria("- AC-01: a\n- AC-01: b")).toThrow(/Duplicate/u);
  });

  it("parses same-repository Issue references", () => {
    expect(parseIssueRefs("#13, #12 #13")).toEqual([12, 13]);
    expect(parseIssueRefs("")).toEqual([]);
    expect(() => parseIssueRefs("other/repo#3")).toThrow(/Invalid issue reference/u);
  });
});
