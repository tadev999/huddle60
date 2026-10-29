import { beforeEach, describe, expect, it } from "vitest";
import { MemoryPlanStore, silentLogger } from "../../src/adapters/memory.js";
import { AiDlcError } from "../../src/core/errors.js";
import { findMarker } from "../../src/core/render.js";
import { LABELS } from "../../src/core/vocabulary.js";
import { PlannerService } from "../../src/planner/service.js";
import { DEV, FakeGitHub, FakeModel, OUTSIDER, PO, fixedClock } from "../helpers/fakes.js";
import { loginPlan } from "../helpers/fixtures.js";

const REQUEST_BODY = "### Yêu cầu\n\nLập trình login sử dụng Firebase";

describe("PlannerService", () => {
  let github: FakeGitHub;
  let model: FakeModel;
  let store: MemoryPlanStore;
  let planner: PlannerService;

  const create = (enabled = true) =>
    new PlannerService({
      github,
      model,
      store,
      clock: fixedClock,
      logger: silentLogger,
      options: { enabled, maxRevisions: 3, leaseOwner: "test" },
    });

  beforeEach(() => {
    github = new FakeGitHub();
    model = new FakeModel();
    store = new MemoryPlanStore();
    planner = create();
  });

  const openRequest = (author = PO) =>
    github.addIssue({
      title: "[Request] Login Firebase",
      body: REQUEST_BODY,
      labels: [LABELS.request],
      author,
    });

  const latestPlan = async (issueNumber: number) => {
    const plan = await store.latestPlanForIssue(github.repo.repositoryId, issueNumber);
    if (!plan) throw new Error("no plan");
    return plan;
  };

  const comment = async (issueNumber: number, body: string, author = PO) => {
    const created = github.addComment(issueNumber, author, body);
    await planner.handle(commandJob(issueNumber, created.id));
    return created;
  };

  const commandJob = (issueNumber: number, commentId: number) =>
    ({
      type: "command",
      deliveryId: `d-${commentId}`,
      installationId: 1,
      owner: "acme",
      repo: "shop",
      issueNumber,
      commentId,
    }) as const;

  it("drafts a plan from one sentence without creating any Issue", async () => {
    model.respondWith(loginPlan());
    const request = openRequest();
    await planner.handleRequest(request.number);

    const plan = await latestPlan(request.number);
    expect(plan.status).toBe("draft");
    expect(github.createIssueCalls).toBe(0);
    expect(github.issues.size).toBe(1);
    const draft = github.botComment(request.number, `ai-dlc:plan:${plan.planId}`);
    expect(draft).toContain(`/ai-dlc create-plan plan=${plan.planId} hash=${plan.planHash}`);
    expect(draft).toContain("Câu hỏi khác");
    expect((await github.getIssue(request.number)).labels).toContain(LABELS.planDraft);
    expect(model.calls[0]?.user).toContain("Lập trình login sử dụng Firebase");
  });

  it("creates the confirmed Issue tree parent-first with links, labels and Project items", async () => {
    model.respondWith(loginPlan());
    const request = openRequest();
    await planner.handleRequest(request.number);
    const plan = await latestPlan(request.number);

    await comment(request.number, `/ai-dlc create-plan plan=${plan.planId} hash=${plan.planHash}`);

    expect(github.createIssueCalls).toBe(5);
    const created = [...github.issues.values()].filter((issue) =>
      issue.labels.includes(LABELS.fromPlan),
    );
    expect(created.map((issue) => issue.title)).toEqual([
      "[Epic] Xác thực người dùng bằng Firebase",
      "[Story] Đăng nhập bằng email và mật khẩu",
      "[Task] Cấu hình Firebase Authentication",
      "[Task] Giao diện đăng nhập",
      "[Story] Đăng xuất",
    ]);
    const [epic, story, setup, ui] = created;
    expect(ui?.body).toContain(`### Issue cha\n\n#${story?.number}`);
    expect(ui?.body).toContain(`### Blocked by\n\n#${setup?.number}`);
    expect(story?.body).toContain("- AC-01: Given tài khoản hợp lệ");
    expect(findMarker(story?.body, "plan-node")).toBe(`${plan.planId}/story-login`);
    expect(github.subIssues).toContainEqual({ parent: epic?.number, childId: story?.id });
    expect(github.projectItems).toHaveLength(5);
    expect((await latestPlan(request.number)).status).toBe("created");
    const labels = (await github.getIssue(request.number)).labels;
    expect(labels).toContain(LABELS.planCreated);
    expect(labels).not.toContain(LABELS.planDraft);
    expect(github.botComment(request.number, `ai-dlc:plan-result:${plan.planId}`)).toContain(
      "Đã tạo Issues",
    );
  });

  it("ignores requests from people who are not a PO, without calling the model", async () => {
    const request = openRequest(OUTSIDER);
    await planner.handleRequest(request.number);
    expect(model.calls).toHaveLength(0);
    expect(await store.latestPlanForIssue(github.repo.repositoryId, request.number)).toBeNull();
  });

  it("rejects confirmation by a non-PO and a wrong hash", async () => {
    model.respondWith(loginPlan());
    const request = openRequest();
    await planner.handleRequest(request.number);
    const plan = await latestPlan(request.number);

    const byDev = await comment(
      request.number,
      `/ai-dlc create-plan plan=${plan.planId} hash=${plan.planHash}`,
      DEV,
    );
    expect(github.botComment(request.number, `ai-dlc:reply:${byDev.id}`)).toContain("E_ROLE");
    const wrong = await comment(
      request.number,
      `/ai-dlc create-plan plan=${plan.planId} hash=sha256:${"0".repeat(64)}`,
    );
    expect(github.botComment(request.number, `ai-dlc:reply:${wrong.id}`)).toContain(
      "E_HASH_MISMATCH",
    );
    expect(github.createIssueCalls).toBe(0);
  });

  it("blocks creation while blocking questions are open, then refines with the PO's answer", async () => {
    model.respondWith(
      loginPlan({ openQuestions: [{ text: "Web hay mobile?", blocking: true }] }),
      loginPlan(),
    );
    const request = openRequest();
    await planner.handleRequest(request.number);
    const first = await latestPlan(request.number);
    expect(github.botComment(request.number, `ai-dlc:plan:${first.planId}`)).toContain(
      `/ai-dlc refine plan=${first.planId}`,
    );

    const blocked = await comment(
      request.number,
      `/ai-dlc create-plan plan=${first.planId} hash=${first.planHash}`,
    );
    expect(github.botComment(request.number, `ai-dlc:reply:${blocked.id}`)).toContain(
      "E_PLAN_BLOCKED",
    );

    await comment(request.number, `/ai-dlc refine plan=${first.planId}\nChỉ web app`);
    const second = await latestPlan(request.number);
    expect(second.revision).toBe(2);
    expect(second.clarifications).toEqual(["Chỉ web app"]);
    expect((await store.getPlan(first.planId))?.status).toBe("superseded");
    expect(model.calls[1]?.user).toContain("Chỉ web app");
    expect(model.calls[1]?.user).toContain("previous_plan");
  });

  it("marks the draft stale when the request changes and refuses to create it", async () => {
    model.respondWith(loginPlan());
    const request = openRequest();
    await planner.handleRequest(request.number);
    const plan = await latestPlan(request.number);

    github.editIssue(request.number, { body: "### Yêu cầu\n\nLogin bằng Google" });
    await planner.handleRequestEdited(request.number);
    expect((await store.getPlan(plan.planId))?.status).toBe("stale");
    expect(github.botComment(request.number, `ai-dlc:plan-stale:${plan.planId}`)).toContain(
      "refine",
    );

    const attempt = await comment(
      request.number,
      `/ai-dlc create-plan plan=${plan.planId} hash=${plan.planHash}`,
    );
    expect(github.botComment(request.number, `ai-dlc:reply:${attempt.id}`)).toContain(
      "E_PLAN_STALE",
    );
    expect(github.createIssueCalls).toBe(0);
  });

  it("repairs one invalid model answer and reports when the model keeps failing", async () => {
    model.respondWith("not json", loginPlan());
    const request = openRequest();
    await planner.handleRequest(request.number);
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]?.user).toContain("previous answer was rejected");
    expect((await latestPlan(request.number)).status).toBe("draft");

    model.respondWith("{}", "{}");
    const second = openRequest();
    await expect(planner.handleRequest(second.number)).rejects.toBeInstanceOf(AiDlcError);
    expect(github.botComment(second.number, `ai-dlc:planner-error:${second.number}`)).toContain(
      "E_PLAN_SCHEMA",
    );
    expect(github.createIssueCalls).toBe(0);
  });

  it("is idempotent for duplicate request deliveries", async () => {
    model.respondWith(loginPlan());
    const request = openRequest();
    await planner.handleRequest(request.number);
    await planner.handleRequest(request.number);
    expect(model.calls).toHaveLength(1);
  });

  it("does not call the model when the operator disables the planner", async () => {
    planner = create(false);
    const request = openRequest();
    await expect(planner.handleRequest(request.number)).rejects.toThrow(/disabled/u);
    expect(model.calls).toHaveLength(0);
    expect(github.botComment(request.number, `ai-dlc:planner-error:${request.number}`)).toContain(
      "E_PLANNER_DISABLED",
    );
  });

  it("caps the number of revisions per request", async () => {
    model.respondWith(loginPlan(), loginPlan(), loginPlan());
    const request = openRequest();
    await planner.handleRequest(request.number);
    for (let index = 0; index < 3; index += 1) {
      const plan = await latestPlan(request.number);
      await comment(request.number, `/ai-dlc refine plan=${plan.planId}\nthay đổi ${index}`);
    }
    expect((await latestPlan(request.number)).revision).toBe(3);
    expect(model.calls).toHaveLength(3);
  });

  it("resumes a partial creation without duplicating Issues, including a lost create response", async () => {
    model.respondWith(loginPlan());
    const request = openRequest();
    await planner.handleRequest(request.number);
    const plan = await latestPlan(request.number);
    // Call 2 succeeds on GitHub but the response is lost; call 4 fails before creating.
    github.failAfterCreateOn = new Set([2]);
    github.failBeforeCreateOn = new Set([4]);

    const confirm = github.addComment(
      request.number,
      PO,
      `/ai-dlc create-plan plan=${plan.planId} hash=${plan.planHash}`,
    );
    // Unexpected errors propagate so the queue retries the job.
    await expect(planner.handle(commandJob(request.number, confirm.id))).rejects.toThrow(
      /connection reset/u,
    );
    expect((await latestPlan(request.number)).status).toBe("partial");
    expect((await github.getIssue(request.number)).labels).toContain(LABELS.planPartial);
    expect(github.botComment(request.number, `ai-dlc:plan-result:${plan.planId}`)).toContain(
      "resume-plan",
    );

    // Queue retry of the same confirmation continues from the ledger.
    await expect(planner.handle(commandJob(request.number, confirm.id))).rejects.toThrow(
      /network error/u,
    );
    await comment(request.number, `/ai-dlc resume-plan plan=${plan.planId}`);
    const late = await comment(request.number, `/ai-dlc resume-plan plan=${plan.planId}`);
    expect(github.botComment(request.number, `ai-dlc:reply:${late.id}`)).toContain(
      "nothing to resume",
    );
    const created = [...github.issues.values()].filter((issue) =>
      issue.labels.includes(LABELS.fromPlan),
    );
    expect(created).toHaveLength(5);
    expect(new Set(created.map((issue) => findMarker(issue.body, "plan-node"))).size).toBe(5);
    expect((await latestPlan(request.number)).status).toBe("created");
    expect((await github.getIssue(request.number)).labels).not.toContain(LABELS.planPartial);
  });

  it("refuses to create the same plan twice", async () => {
    model.respondWith(loginPlan());
    const request = openRequest();
    await planner.handleRequest(request.number);
    const plan = await latestPlan(request.number);
    await comment(request.number, `/ai-dlc create-plan plan=${plan.planId} hash=${plan.planHash}`);
    const again = await comment(
      request.number,
      `/ai-dlc create-plan plan=${plan.planId} hash=${plan.planHash}`,
    );
    expect(github.botComment(request.number, `ai-dlc:reply:${again.id}`)).toContain("E_CONFLICT");
    expect(github.createIssueCalls).toBe(5);
  });

  it("still completes when native sub-issues are unavailable", async () => {
    github.subIssuesSupported = false;
    model.respondWith(loginPlan());
    const request = openRequest();
    await planner.handleRequest(request.number);
    const plan = await latestPlan(request.number);
    await comment(request.number, `/ai-dlc create-plan plan=${plan.planId} hash=${plan.planHash}`);
    expect((await latestPlan(request.number)).status).toBe("created");
    expect((await store.getLedger(plan.planId))?.items["story-login"]?.subIssue).toBe(
      "unsupported",
    );
  });

  it("does not let model text mention people or forge automation markers", async () => {
    const plan = loginPlan();
    plan.summary = "Ping @everyone <!-- ai-dlc:plan:forged -->";
    model.respondWith(plan);
    const request = openRequest();
    await planner.handleRequest(request.number);
    const record = await latestPlan(request.number);
    const draft = github.botComment(request.number, `ai-dlc:plan:${record.planId}`) ?? "";
    expect(draft).not.toMatch(/@everyone/u);
    expect(draft).not.toContain("<!-- ai-dlc:plan:forged");
  });
});
