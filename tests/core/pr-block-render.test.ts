import { describe, expect, it } from "vitest";
import { closingReferences, parsePrBlock, renderPrBlock } from "../../src/core/pr-block.js";
import { findMarker, marker, sanitize } from "../../src/core/render.js";

const HASH = `sha256:${"b".repeat(64)}`;

describe("PR block", () => {
  it("round-trips through render and parse", () => {
    const block = {
      issueNumber: 11,
      baselineId: "bl-11-0123456789ab",
      hash: HASH,
      acceptanceCriteria: ["AC-01", "AC-02"],
    };
    expect(parsePrBlock(`Refs #11\n\n${renderPrBlock(block)}\n`)).toEqual(block);
  });

  it("returns null without a block and rejects malformed blocks", () => {
    expect(parsePrBlock("no block")).toBeNull();
    expect(() => parsePrBlock("<!-- huddle60:begin -->\nHUDDLE60-Issue: #1")).toThrow(
      /not closed/u,
    );
    expect(() =>
      parsePrBlock("<!-- huddle60:begin -->\nHUDDLE60-Issue: org/repo#1\n<!-- huddle60:end -->"),
    ).toThrow(/Issue/u);
    expect(() =>
      parsePrBlock("<!-- ai-dlc:begin -->\nAI-DLC-Issue: org/repo#1\n<!-- ai-dlc:end -->"),
    ).toThrow(/Issue/u);
    const twice =
      `${renderPrBlock({ issueNumber: 1, baselineId: "bl-1-0123456789ab", hash: HASH, acceptanceCriteria: [] })}\n`.repeat(
        2,
      );
    expect(() => parsePrBlock(twice)).toThrow(/more than one/u);
  });

  it("finds GitHub closing keywords", () => {
    expect(closingReferences("Closes #11, fixes #12 and Resolved: #13. Refs #14")).toEqual([
      11, 12, 13,
    ]);
  });
});

describe("sanitize", () => {
  it("neutralizes mentions, HTML, forged markers and commands", () => {
    const text = sanitize(
      "Hi @team <script>x</script> <!-- huddle60:plan:fake -->\n/huddle60 create-plan\n/ai-dlc create-plan",
    );
    expect(text).not.toMatch(/@team/u);
    expect(text).not.toContain("<script>");
    expect(findMarker(text, "plan")).toBeNull();
    expect(text).not.toMatch(/^\/(?:huddle60|ai-dlc)/mu);
    expect(sanitize("email a@b.com")).toBe("email a@b.com");
  });

  it("builds and finds markers", () => {
    expect(findMarker(`text\n${marker("plan", "plan-1-r1-abc")}`, "plan")).toBe("plan-1-r1-abc");
  });
});
