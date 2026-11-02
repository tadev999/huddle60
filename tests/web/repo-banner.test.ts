import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../ui/app.js", import.meta.url), "utf8");
const renderBanner = source.slice(
  source.indexOf("function updateRepoInitBanner()"),
  source.indexOf("async function initRepository()"),
);

function render(session: object | null, settings: object = { policyStatus: "missing" }) {
  const elements = new Map<string, { hidden: boolean }>();
  const banner = { hidden: false };
  elements.set("#repo-init-banner", banner);
  runInNewContext(`${renderBanner}\nupdateRepoInitBanner();`, {
    state: { session, settings },
    $: (selector: string) => elements.get(selector),
  });
  return banner;
}

describe("repository initialization banner", () => {
  const repo = { owner: "tadev999", repo: "huddle60_test" };

  it("hides stale setup warnings after switching to a configured repository", () => {
    expect(render({ status: "ready", repo }).hidden).toBe(true);
  });

  it("does not mistake repository access or authentication errors for a missing policy", () => {
    for (const reason of ["repo_not_found", "invalid_github_token"]) {
      expect(render({ status: "needs_setup", repo, missing: [reason] }).hidden).toBe(true);
    }
  });

  it("hides the banner when there is no repository", () => {
    expect(render({ status: "needs_setup", repo: null }).hidden).toBe(true);
    expect(render(null).hidden).toBe(true);
  });

  it("shows setup actions only when the current session reports a missing policy", () => {
    const banner = { hidden: true, classList: { add() {}, remove() {} } };
    for (const canInitRepo of [false, true]) {
      runInNewContext(`${renderBanner}\nupdateRepoInitBanner();`, {
        state: {
          session: { status: "needs_setup", repo, missing: ["missing_policy"], canInitRepo },
          settings: { policyStatus: "ready" },
        },
        $: (selector: string) => (selector === "#repo-init-banner" ? banner : null),
      });
      expect(banner.hidden).toBe(false);
    }
  });
});
