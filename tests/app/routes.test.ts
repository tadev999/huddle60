import { describe, expect, it } from "vitest";
import { MemoryEvidenceStore, silentLogger } from "../../src/adapters/memory.js";
import { LocalApp } from "../../src/app/local-app.js";
import { LocalAppManager } from "../../src/app/manager.js";
import { createRoutes, dispatch, errorResponse, type RouteDeps } from "../../src/app/routes.js";
import { LABELS } from "../../src/core/vocabulary.js";
import { FakeGitHub, FakeModel, fixedClock } from "../helpers/fakes.js";
import { storyBody } from "../helpers/fixtures.js";

function setup() {
  const github = new FakeGitHub();
  github.addIssue({ title: "[Story] Login", body: storyBody(), labels: [LABELS.story] });
  const app = new LocalApp({
    github,
    evidence: new MemoryEvidenceStore(),
    model: new FakeModel(),
    clock: fixedClock,
    logger: silentLogger,
  });
  const manager = new LocalAppManager({ logger: silentLogger, ephemeral: true });
  const deps: RouteDeps = {
    getManagerFor: async () => manager,
    getAppFor: async () => app,
    oauthEnabled: () => false,
  };
  const routes = createRoutes(deps);
  return async (method: string, path: string, body?: unknown) => {
    try {
      return {
        status: 200,
        body: await dispatch(routes, deps, {
          method,
          url: new URL(path, "https://engine.invalid"),
          body,
          tenant: null,
        }),
      };
    } catch (error) {
      return errorResponse(error, silentLogger, path);
    }
  };
}

describe("in-browser application routes", () => {
  it("validates decision input and preserves business-role checks", async () => {
    const call = setup();
    expect(await call("POST", "/api/issues/1/decisions", { action: "merge" })).toMatchObject({
      status: 400,
      body: { error: { code: "E_INPUT" } },
    });
    expect(await call("POST", "/api/issues/1/decisions", { action: "approve" })).toMatchObject({
      status: 200,
      body: { command: expect.stringMatching(/^\/(?:huddle60|ai-dlc) approve /u) },
    });
    expect(
      await call("POST", "/api/issues/1/decisions", { action: "ready", lane: "fast" }),
    ).toMatchObject({ status: 422, body: { error: { code: "E_ROLE" } } });
  });

  it("reads and edits issues through the shared engine routes", async () => {
    const call = setup();
    expect(await call("GET", "/api/issues/1")).toMatchObject({
      status: 200,
      body: { number: 1, title: "[Story] Login", canEdit: true },
    });
    expect(
      await call("PATCH", "/api/issues/1", {
        title: "[Story] Login updated",
        comment: "Note from user",
      }),
    ).toMatchObject({ status: 200, body: { title: "[Story] Login updated" } });
  });
});
