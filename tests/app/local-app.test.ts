import { beforeEach, describe, expect, it } from "vitest";
import { MemoryEvidenceStore, silentLogger } from "../../src/adapters/memory.js";
import { LocalApp } from "../../src/app/local-app.js";
import { LABELS } from "../../src/core/vocabulary.js";
import { DEV, FakeGitHub, FakeModel, PO, fixedClock } from "../helpers/fakes.js";
import { loginPlan, storyBody } from "../helpers/fixtures.js";

const BUILD_SHA = "c".repeat(40);

describe("LocalApp", () => {
  let github: FakeGitHub;
  let evidence: MemoryEvidenceStore;
  let model: FakeModel;
  let app: LocalApp;

  beforeEach(() => {
    github = new FakeGitHub();
    evidence = new MemoryEvidenceStore();
    model = new FakeModel();
    app = new LocalApp({ github, evidence, model, clock: fixedClock, logger: silentLogger });
  });

  /** Posts a decision through the app, then plays the GitHub Actions workflow. */
  const decide = async (
    issueNumber: number,
    input: Parameters<LocalApp["decide"]>[1],
    actor = PO,
  ) => {
    github.viewerActor = actor;
    const fresh = new LocalApp({
      github,
      evidence,
      model,
      clock: fixedClock,
      logger: silentLogger,
    });
    const { commentId, command } = await fresh.decide(issueNumber, input);
    expect(await fresh.reply(issueNumber, commentId)).toMatchObject({ status: "pending" });
    await app.workflow.handleComment(issueNumber, commentId, "created");
    return { command, reply: await fresh.reply(issueNumber, commentId) };
  };

  describe("planning", () => {
    it("drafts, refines and creates the Issue tree under a new request Issue", async () => {
      model.respondWith(
        loginPlan({ openQuestions: [{ text: "Có Google login?", blocking: true }] }),
        loginPlan(),
      );
      const draft = await app.draftPlan({
        request: "Lập trình login sử dụng Google OAuth cho web",
      });
      expect(draft.blocking).toEqual(["Có Google login?"]);
      await expect(app.createPlan(draft.draftId)).rejects.toMatchObject({ code: "E_PLAN_BLOCKED" });

      const refined = await app.refinePlan(draft.draftId, "Không cần Google login");
      expect(refined.blocking).toEqual([]);
      expect(model.calls[1]?.user).toContain("Không cần Google login");
      expect(model.calls[1]?.user).toContain("previous_plan");

      const created = await app.createPlan(draft.draftId);
      const request = await github.getIssue(created.created?.requestIssue ?? 0);
      expect(request.labels).toEqual(expect.arrayContaining([LABELS.request, LABELS.planCreated]));
      expect(request.body).toContain("### Yêu cầu");
      expect(Object.keys(created.created?.issues ?? {})).toHaveLength(5);
      expect(github.createIssueCalls).toBe(6);

      // Creating again is idempotent.
      await app.createPlan(draft.draftId);
      expect(github.createIssueCalls).toBe(6);
    });

    it("resumes an interrupted creation without duplicates", async () => {
      model.respondWith(loginPlan());
      const draft = await app.draftPlan({
        request: "Lập trình login sử dụng Google OAuth cho web",
      });
      github.failAfterCreateOn.add(3);
      await expect(app.createPlan(draft.draftId)).rejects.toThrow();
      const created = await app.createPlan(draft.draftId);
      expect(Object.keys(created.created?.issues ?? {})).toHaveLength(5);
      expect(await github.listIssuesWithLabel(LABELS.fromPlan)).toHaveLength(5);
    });

    it("only lets a PO create Issues and needs a Gemini key to plan", async () => {
      github.viewerActor = DEV;
      const devApp = new LocalApp({
        github,
        evidence,
        model,
        clock: fixedClock,
        logger: silentLogger,
      });
      model.respondWith(loginPlan());
      const devDraft = await devApp.draftPlan({
        request: "Lập trình login sử dụng Google OAuth cho web",
      });
      await expect(devApp.createPlan(devDraft.draftId)).rejects.toMatchObject({ code: "E_ROLE" });

      const noModel = new LocalApp({
        github,
        evidence,
        model: null,
        clock: fixedClock,
        logger: silentLogger,
      });
      await expect(noModel.draftPlan({ request: "Một yêu cầu đủ dài" })).rejects.toMatchObject({
        code: "E_CONFIG",
      });
    });
  });

  describe("work items", () => {
    it("moves a story through approve → ready → accept with one click each", async () => {
      const story = github.addIssue({
        title: "[Story] Login",
        body: storyBody(),
        labels: [LABELS.story],
      });
      expect((await app.listItems())[0]).toMatchObject({
        number: story.number,
        stage: "awaiting-approval",
      });

      const approve = await decide(story.number, { action: "approve" });
      expect(approve.command).toMatch(
        /^\/(?:huddle60|ai-dlc) approve baseline=bl-\d+-[0-9a-f]{12} hash=sha256:/u,
      );
      expect(approve.reply).toMatchObject({ status: "done", ok: true });
      expect((await app.listItems())[0]).toMatchObject({
        stage: "awaiting-ready",
        approvedBy: PO.login,
      });

      const ready = await decide(story.number, { action: "ready", lane: "standard" }, DEV);
      expect(ready.reply.ok).toBe(true);
      expect((await app.listItems())[0]).toMatchObject({
        stage: "in-progress",
        ready: { by: DEV.login, lane: "standard" },
      });
      expect(await app.context(story.number)).toContain("AI-DLC-Baseline");

      github.runs.set(42, {
        id: 42,
        runAttempt: 1,
        path: ".github/workflows/build.yml",
        event: "push",
        headBranch: "main",
        headSha: BUILD_SHA,
        status: "completed",
        conclusion: "success",
        repositoryId: 777,
      });
      const accept = await decide(story.number, { action: "accept" });
      expect(accept.command).toContain(`run=42 commit=${BUILD_SHA}`);
      expect(accept.reply.ok).toBe(true);
      expect(await app.listItems()).toEqual([]);
    });

    it("flags edits after a decision and reports rejected commands", async () => {
      const story = github.addIssue({
        title: "[Story] Login",
        body: storyBody(),
        labels: [LABELS.story],
      });
      await decide(story.number, { action: "approve" });
      github.editIssue(story.number, {
        body: storyBody({ criteria: "- AC-01: Given khách When đăng nhập Then thấy OTP" }),
      });
      expect((await app.listItems())[0]).toMatchObject({
        stage: "awaiting-approval",
        changed: true,
      });

      const ready = await decide(story.number, { action: "ready", lane: "standard" }, DEV);
      expect(ready.reply).toMatchObject({ status: "done", ok: false });
      expect(ready.reply.body).toContain("E_NOT_APPROVED");
    });

    it("checks roles before posting and refuses accept without a build", async () => {
      const story = github.addIssue({
        title: "[Story] Login",
        body: storyBody(),
        labels: [LABELS.story],
      });
      github.viewerActor = DEV;
      const asDev = new LocalApp({
        github,
        evidence,
        model,
        clock: fixedClock,
        logger: silentLogger,
      });
      await expect(asDev.decide(story.number, { action: "approve" })).rejects.toMatchObject({
        code: "E_ROLE",
      });
      github.viewerActor = PO;
      await expect(app.decide(story.number, { action: "accept" })).rejects.toMatchObject({
        code: "E_BUILD_INVALID",
      });
      expect(github.commentsOn(story.number)).toHaveLength(0);
    });
  });
});
