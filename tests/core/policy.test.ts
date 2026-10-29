import { describe, expect, it } from "vitest";
import { hasRole, isSensitive, matchesPath, parsePolicy, rolesOf } from "../../src/core/policy.js";
import { POLICY_YAML, PO, DEV } from "../helpers/fakes.js";

describe("policy", () => {
  it("parses roles and applies defaults", () => {
    const policy = parsePolicy(POLICY_YAML);
    expect(hasRole(policy, PO.id, "po")).toBe(true);
    expect(hasRole(policy, DEV.id, "po")).toBe(false);
    expect(rolesOf(policy, DEV.id)).toEqual(["dev"]);
    expect(policy.lanes.fast.requires_po_approval).toBe(false);
    expect(policy.evidence.branch).toBe("ai-dlc-evidence");
  });

  it("rejects invalid YAML, missing PO and bot role holders", () => {
    expect(() => parsePolicy("version: [")).toThrow(/not valid YAML/u);
    expect(() => parsePolicy("version: 1\nroles:\n  po: []\n")).toThrow(/invalid/u);
    expect(() =>
      parsePolicy("version: 1\nroles:\n  po:\n    - id: 1\n      login: helper[bot]\n"),
    ).toThrow(/Bot account/u);
  });

  it("matches sensitive path globs", () => {
    expect(matchesPath("src/auth/**", "src/auth/firebase/login.ts")).toBe(true);
    expect(matchesPath("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(matchesPath("migrations/**", "migrations/001.sql")).toBe(true);
    expect(isSensitive(parsePolicy(POLICY_YAML), "src/auth/session.ts")).toBe(true);
  });
});
