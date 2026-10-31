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

    it("passes reference links and document attachments to model and preserves them in issue technicalRefs", async () => {
      model.respondWith(loginPlan());
      const links = [
        "https://www.figma.com/design/test-file/login-flow",
        "https://docs.google.com/document/d/spec-123/edit",
      ];
      const attachments = [
        { name: "mockup.png", mimeType: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" },
        { name: "bang-gia.csv", mimeType: "text/csv", dataBase64: Buffer.from("loai,gia\nvip,100").toString("base64") },
      ];

      const draft = await app.draftPlan({
        title: "Thiết kế màn hình Onboarding",
        request: "Tạo màn hình Onboarding theo đúng tài liệu và mockup đính kèm",
        links,
        attachments,
      });

      // Verify prompt and attachments sent to model
      expect(model.calls[0]?.user).toContain("<reference_links>");
      expect(model.calls[0]?.user).toContain(links[0]!);
      expect(model.calls[0]?.user).toContain(links[1]!);
      expect(model.calls[0]?.user).toContain("The PO attached visual mockups, PDF documents, or data sheets");
      expect(model.calls[0]?.attachments).toEqual(attachments);

      // Create plan issues
      const created = await app.createPlan(draft.draftId);
      const requestIssue = await github.getIssue(created.created?.requestIssue ?? 0);
      expect(requestIssue.body).toContain("### Tham chiếu kỹ thuật");
      expect(requestIssue.body).toContain(links[0]!);
      expect(requestIssue.body).toContain(links[1]!);
      expect(requestIssue.body).toContain("`mockup.png` (Hình ảnh)");
      expect(requestIssue.body).toContain("`bang-gia.csv` (Bảng tính CSV)");

      // Verify child issues inherit technical references
      const firstChildNumber = Object.values(created.created?.issues ?? {})[0];
      expect(firstChildNumber).toBeDefined();
      const childIssue = await github.getIssue(firstChildNumber!);
      expect(childIssue.body).toContain("### Tham chiếu kỹ thuật");
      expect(childIssue.body).toContain(links[0]!);
      expect(childIssue.body).toContain("`mockup.png`");
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
      expect(await app.context(story.number)).toContain("HUDDLE60-Baseline");

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

    it("allows dev/po to get issue details, update issue spec, and leave a comment", async () => {
      const story = github.addIssue({
        title: "[Story] Login",
        body: storyBody(),
        labels: [LABELS.story],
      });
      const details = await app.getIssueDetails(story.number);
      expect(details).toMatchObject({
        number: story.number,
        title: "[Story] Login",
        canEdit: true,
      });

      // Update as DEV
      github.viewerActor = DEV;
      const asDev = new LocalApp({
        github,
        evidence,
        model,
        clock: fixedClock,
        logger: silentLogger,
      });

      await asDev.updateIssueDetails(story.number, {
        title: "[Story] Login with OAuth2",
        body: "### Goal\nSupport OAuth2 login",
        comment: "DEV updated scope to include Google OAuth",
      });

      const updated = await github.getIssue(story.number);
      expect(updated.title).toBe("[Story] Login with OAuth2");
      expect(updated.body).toBe("### Goal\nSupport OAuth2 login");

      const comments = github.commentsOn(story.number);
      expect(comments.some((c) => c.body.includes("Google OAuth"))).toBe(true);
    });

    it("allows guests to read items and view details but blocks decisions", async () => {
      const story = await github.createIssue({
        title: "[Story] Public Feature",
        body: storyBody(),
        labels: [LABELS.story],
      });
      github.viewerActor = { id: 0, login: "guest", type: "User" };
      const guestApp = new LocalApp({
        github,
        evidence,
        model,
        clock: fixedClock,
        logger: silentLogger,
      });

      const session = await guestApp.session();
      expect(session.roles).toEqual([]);
      expect(session.viewer.login).toBe("guest");

      const items = await guestApp.listItems();
      expect(items.some((i) => i.number === story.number)).toBe(true);

      const details = await guestApp.getIssueDetails(story.number);
      expect(details.title).toBe("[Story] Public Feature");
      expect(details.canEdit).toBe(false);

      await expect(guestApp.decide(story.number, { action: "approve" })).rejects.toThrow(
        /requires the po role/i,
      );
    });
  });
});
