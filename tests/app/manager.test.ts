import { describe, expect, it } from "vitest";
import { LocalAppManager } from "../../src/app/manager.js";
import { silentLogger } from "../../src/adapters/memory.js";

describe("LocalAppManager policy and role management", () => {
  it("initializes and reports initial policy roles and edit permissions", async () => {
    const manager = new LocalAppManager({ logger: silentLogger });
    await manager.initialize();

    expect(typeof manager.canEditRoles).toBe("function");
    expect(typeof manager.getPolicyRoles).toBe("function");
    expect(typeof manager.resolveUser).toBe("function");
    expect(typeof manager.updatePolicyRoles).toBe("function");

    const settings = await manager.getSettings();
    expect(settings).toHaveProperty("policyRoles");
    expect(settings).toHaveProperty("canEditRoles");
  });

  it("validates role guardrails when updating policy roles", async () => {
    const manager = new LocalAppManager({ logger: silentLogger });
    await manager.initialize();
    (manager as unknown as { canWriteRepo: boolean }).canWriteRepo = true;
    (manager as unknown as { currentToken: string }).currentToken = "test-token";
    (manager as unknown as { currentRepo: { owner: string; repo: string } }).currentRepo = {
      owner: "test",
      repo: "test",
    };

    // 1. Reject empty PO
    await expect(
      manager.updatePolicyRoles({
        po: [],
        dev: [],
        maintainer: [{ id: 1, login: "alice" }],
      }),
    ).rejects.toThrow(/Product Owner/);

    // 2. Reject empty Maintainer
    await expect(
      manager.updatePolicyRoles({
        po: [{ id: 1, login: "alice" }],
        dev: [],
        maintainer: [],
      }),
    ).rejects.toThrow(/Maintainer/);

    // 3. Reject bot accounts
    await expect(
      manager.updatePolicyRoles({
        po: [{ id: 1, login: "dependabot[bot]" }],
        dev: [],
        maintainer: [{ id: 2, login: "alice" }],
      }),
    ).rejects.toThrow(/bot/);
  });
});
