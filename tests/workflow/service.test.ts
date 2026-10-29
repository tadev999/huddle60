import { beforeEach, describe, expect, it } from "vitest";
import { MemoryEvidenceStore, silentLogger } from "../../src/adapters/memory.js";
import { parsePrBlock, renderPrBlock } from "../../src/core/pr-block.js";
import { LABELS } from "../../src/core/vocabulary.js";
import { STATUS_CONTEXT, WorkflowService } from "../../src/workflow/service.js";
import { DEV, FakeGitHub, OUTSIDER, PO, fixedClock } from "../helpers/fakes.js";
import { storyBody, taskBody } from "../helpers/fixtures.js";

const BUILD_SHA = "c".repeat(40);

describe("WorkflowService", () => {
  let github: FakeGitHub;
  let evidence: MemoryEvidenceStore;
  let workflow: WorkflowService;

  beforeEach(() => {
    github = new FakeGitHub();
    evidence = new MemoryEvidenceStore();
    workflow = new WorkflowService({
      github,
      evidence,
      clock: fixedClock,
      logger: silentLogger,
      enabled: true,
    });
  });

  const command = async (issueNumber: number, body: string, author = PO) => {
    const created = github.addComment(issueNumber, author, body);
    await workflow.handleComment(issueNumber, created.id, "created");
    return {
      id: created.id,
      reply: github.botComment(issueNumber, `ai-dlc:reply:${created.id}`) ?? "",
    };
  };

  const baselineOf = (reply: string) => {
    const id = /Baseline `(bl-\d+-[0-9a-f]{12})`/u.exec(reply)?.[1];
    const hash = /Hash: `(sha256:[0-9a-f]{64})`/u.exec(reply)?.[1];
    if (!id || !hash) throw new Error(`no baseline in reply:\n${reply}`);
    return { id, hash };
  };

  const readyStory = async (lane = "standard") => {
    const story = github.addIssue({
      title: "[Story] Đăng nhập",
      body: storyBody(),
      labels: [LABELS.story],
    });
    const baseline = baselineOf((await command(story.number, "/ai-dlc baseline", DEV)).reply);
    const approve = await command(
      story.number,
      `/ai-dlc approve baseline=${baseline.id} hash=${baseline.hash}`,
      PO,
    );
    const ready = await command(
      story.number,
      `/ai-dlc ready baseline=${baseline.id} hash=${baseline.hash} lane=${lane}`,
      DEV,
    );
    return { story, baseline, approve, ready };
  };

  it("runs baseline → approve → ready and returns a PR block", async () => {
    const { story, baseline, approve, ready } = await readyStory();
    expect(approve.reply).toContain("Đã duyệt nghiệp vụ");
    expect(ready.reply).toContain("Sẵn sàng triển khai");
    expect(parsePrBlock(ready.reply)).toEqual({
      issueNumber: story.number,
      baselineId: baseline.id,
      hash: baseline.hash,
      acceptanceCriteria: ["AC-01"],
    });
    expect(await evidence.list("decisions/777/")).toHaveLength(2);
  });

  it("enforces roles: only DEV may mark ready, only PO may approve", async () => {
    const story = github.addIssue({
      title: "[Story] A",
      body: storyBody(),
      labels: [LABELS.story],
    });
    const baseline = baselineOf((await command(story.number, "/ai-dlc baseline", PO)).reply);
    expect(
      (
        await command(
          story.number,
          `/ai-dlc approve baseline=${baseline.id} hash=${baseline.hash}`,
          DEV,
        )
      ).reply,
    ).toContain("E_ROLE");
    expect(
      (
        await command(
          story.number,
          `/ai-dlc ready baseline=${baseline.id} hash=${baseline.hash} lane=fast`,
          PO,
        )
      ).reply,
    ).toContain("E_ROLE");
    expect((await command(story.number, "/ai-dlc baseline", OUTSIDER)).reply).toContain("E_ROLE");
  });

  it("requires PO approval for the standard lane but not for fast", async () => {
    const story = github.addIssue({
      title: "[Story] A",
      body: storyBody(),
      labels: [LABELS.story],
    });
    const baseline = baselineOf((await command(story.number, "/ai-dlc baseline", DEV)).reply);
    expect(
      (
        await command(
          story.number,
          `/ai-dlc ready baseline=${baseline.id} hash=${baseline.hash} lane=standard`,
          DEV,
        )
      ).reply,
    ).toContain("E_NOT_APPROVED");
    expect(
      (
        await command(
          story.number,
          `/ai-dlc ready baseline=${baseline.id} hash=${baseline.hash} lane=fast`,
          DEV,
        )
      ).reply,
    ).toContain("Sẵn sàng");
  });

  it("approves in one step by storing the baseline of the current content", async () => {
    const story = github.addIssue({
      title: "[Story] A",
      body: storyBody(),
      labels: [LABELS.story],
    });
    const current = workflow.snapshotOf(await github.getIssue(story.number));
    const reply = (
      await command(
        story.number,
        `/ai-dlc approve baseline=${current.baselineId} hash=${current.contentHash}`,
      )
    ).reply;
    expect(reply).toContain("Đã duyệt nghiệp vụ");
    expect(await evidence.list(`baselines/777/${story.number}/`)).toHaveLength(1);

    const forged = (
      await command(
        story.number,
        `/ai-dlc approve baseline=bl-${story.number}-0123456789ab hash=${current.contentHash}`,
      )
    ).reply;
    expect(forged).toContain("E_BASELINE_NOT_FOUND");
  });

  it("refuses decisions when the Issue changed after the baseline", async () => {
    const story = github.addIssue({
      title: "[Story] A",
      body: storyBody(),
      labels: [LABELS.story],
    });
    const baseline = baselineOf((await command(story.number, "/ai-dlc baseline", DEV)).reply);
    github.editIssue(story.number, { body: storyBody({ criteria: "- AC-01: changed" }) });
    expect(
      (await command(story.number, `/ai-dlc approve baseline=${baseline.id} hash=${baseline.hash}`))
        .reply,
    ).toContain("E_STALE");
  });

  it("blocks ready while a blocking Issue is still open", async () => {
    const blocker = github.addIssue({ title: "[Task] setup", body: "x", labels: [LABELS.task] });
    const story = github.addIssue({
      title: "[Story] A",
      body: storyBody({ blockedBy: `#${blocker.number}` }),
      labels: [LABELS.story],
    });
    const baseline = baselineOf((await command(story.number, "/ai-dlc baseline", DEV)).reply);
    expect(
      (
        await command(
          story.number,
          `/ai-dlc ready baseline=${baseline.id} hash=${baseline.hash} lane=fast`,
          DEV,
        )
      ).reply,
    ).toContain("E_DEPENDENCY_OPEN");
    github.editIssue(blocker.number, { state: "closed", stateReason: "completed" });
    expect(
      (
        await command(
          story.number,
          `/ai-dlc ready baseline=${baseline.id} hash=${baseline.hash} lane=fast`,
          DEV,
        )
      ).reply,
    ).toContain("Sẵn sàng");
  });

  describe("pull request gate", () => {
    const status = () => github.statuses.at(-1);

    it("passes for a ready baseline and fails once the Issue changes", async () => {
      const { story, ready } = await readyStory();
      github.addPullRequest({
        number: 900,
        body: `Refs #${story.number}\n\n${renderPrBlock(parsePrBlock(ready.reply)!)}`,
      });
      await workflow.checkPullRequest(900);
      expect(status()).toMatchObject({ state: "success", context: STATUS_CONTEXT });

      github.editIssue(story.number, { body: storyBody({ criteria: "- AC-01: changed" }) });
      await workflow.checkPullRequest(900);
      expect(status()).toMatchObject({ state: "failure" });
      expect(status()?.description).toMatch(/^E_STALE/u);
    });

    it("fails without a block, with closing keywords, or with unknown AC", async () => {
      const { story, ready } = await readyStory();
      const block = parsePrBlock(ready.reply)!;
      github.addPullRequest({ number: 901, body: "no block" });
      await workflow.checkPullRequest(901);
      expect(status()?.description).toMatch(/^E_PR_BLOCK/u);

      github.addPullRequest({
        number: 902,
        body: `Closes #${story.number}\n${renderPrBlock(block)}`,
      });
      await workflow.checkPullRequest(902);
      expect(status()?.description).toMatch(/^E_CLOSING_KEYWORD/u);

      github.addPullRequest({
        number: 903,
        body: renderPrBlock({ ...block, acceptanceCriteria: ["AC-09"] }),
      });
      await workflow.checkPullRequest(903);
      expect(status()?.description).toMatch(/Unknown AC/u);
    });

    it("fails when the approval is revoked or its comment is edited", async () => {
      const { story, approve, ready } = await readyStory();
      github.addPullRequest({ number: 904, body: renderPrBlock(parsePrBlock(ready.reply)!) });
      github.comments.get(approve.id)!.body += " (sửa)";
      await workflow.checkPullRequest(904);
      expect(status()?.description).toMatch(/^E_NOT_APPROVED/u);
      expect(story.number).toBeGreaterThan(0);
    });

    it("rejects sensitive paths in the fast lane and honours the exempt label", async () => {
      const { ready } = await readyStory("fast");
      github.addPullRequest({
        number: 905,
        body: renderPrBlock(parsePrBlock(ready.reply)!),
        files: ["src/auth/login.ts"],
      });
      await workflow.checkPullRequest(905);
      expect(status()?.description).toMatch(/^E_SENSITIVE_PATH/u);

      github.addPullRequest({ number: 906, body: "docs only", labels: [LABELS.exempt] });
      await workflow.checkPullRequest(906);
      expect(status()).toMatchObject({ state: "success" });
    });

    it("reports pending when the operator disables AI-DLC", async () => {
      workflow = new WorkflowService({
        github,
        evidence,
        clock: fixedClock,
        logger: silentLogger,
        enabled: false,
      });
      github.addPullRequest({ number: 907, body: "" });
      await workflow.checkPullRequest(907);
      expect(status()).toMatchObject({ state: "pending" });
    });
  });

  describe("acceptance", () => {
    const addRun = (id: number, patch: Partial<Parameters<FakeGitHub["runs"]["set"]>[1]> = {}) =>
      github.runs.set(id, {
        id,
        runAttempt: 1,
        path: ".github/workflows/build.yml",
        event: "push",
        headBranch: "main",
        headSha: BUILD_SHA,
        status: "completed",
        conclusion: "success",
        repositoryId: 777,
        ...patch,
      });

    it("accepts a successful build on main and closes the story", async () => {
      const { story, baseline } = await readyStory();
      addRun(42);
      const reply = (
        await command(
          story.number,
          `/ai-dlc accept baseline=${baseline.id} run=42 commit=${BUILD_SHA}`,
        )
      ).reply;
      expect(reply).toContain("Đã ghi nhận nghiệm thu");
      expect((await github.getIssue(story.number)).stateReason).toBe("completed");
    });

    it.each([
      ["a pull request build", { event: "pull_request" }],
      ["another workflow", { path: ".github/workflows/lint.yml" }],
      ["a failed build", { conclusion: "failure" }],
      ["a different commit", { headSha: "d".repeat(40) }],
    ])("rejects %s", async (_name, patch) => {
      const { story, baseline } = await readyStory();
      addRun(43, patch);
      const reply = (
        await command(
          story.number,
          `/ai-dlc accept baseline=${baseline.id} run=43 commit=${BUILD_SHA}`,
        )
      ).reply;
      expect(reply).toContain("E_BUILD_INVALID");
      expect((await github.getIssue(story.number)).state).toBe("open");
    });

    it("requires a valid ready decision and a PO", async () => {
      const story = github.addIssue({
        title: "[Story] A",
        body: storyBody(),
        labels: [LABELS.story],
      });
      const baseline = baselineOf((await command(story.number, "/ai-dlc baseline", DEV)).reply);
      addRun(44);
      expect(
        (
          await command(
            story.number,
            `/ai-dlc accept baseline=${baseline.id} run=44 commit=${BUILD_SHA}`,
          )
        ).reply,
      ).toContain("E_NOT_READY");
      expect(
        (
          await command(
            story.number,
            `/ai-dlc accept baseline=${baseline.id} run=44 commit=${BUILD_SHA}`,
            DEV,
          )
        ).reply,
      ).toContain("E_ROLE");
    });
  });

  describe("tasks", () => {
    const newTask = (parent: number | null) =>
      github.addIssue({
        title: "[Task] Form đăng nhập",
        body: taskBody(parent === null ? {} : { parent: `#${parent}` }),
        labels: [LABELS.task],
      });

    const readyTask = async (taskNumber: number, lane = "standard") => {
      const baseline = baselineOf((await command(taskNumber, "/ai-dlc baseline", DEV)).reply);
      const ready = await command(
        taskNumber,
        `/ai-dlc ready baseline=${baseline.id} hash=${baseline.hash} lane=${lane}`,
        DEV,
      );
      return { baseline, ready };
    };

    it("needs no PO approval of its own when the parent story is approved", async () => {
      const { story } = await readyStory();
      const task = newTask(story.number);
      const { ready } = await readyTask(task.number);
      expect(ready.reply).toContain("Sẵn sàng triển khai");
      expect(parsePrBlock(ready.reply)?.acceptanceCriteria).toEqual(["AC-01"]);
      const poDecisionsOnTask = (await workflow.listDecisions(task.number)).filter(
        (receipt) => receipt.kind === "approve",
      );
      expect(poDecisionsOnTask).toHaveLength(0);
    });

    it("is blocked until the parent story is approved", async () => {
      const story = github.addIssue({
        title: "[Story] A",
        body: storyBody(),
        labels: [LABELS.story],
      });
      const task = newTask(story.number);
      expect((await readyTask(task.number)).ready.reply).toContain("E_NOT_APPROVED");
      expect((await readyTask(task.number, "fast")).ready.reply).toContain("Sẵn sàng");
    });

    it("loses readiness when the parent story changes after approval", async () => {
      const { story } = await readyStory();
      const task = newTask(story.number);
      const { ready } = await readyTask(task.number);
      github.addPullRequest({ number: 950, body: renderPrBlock(parsePrBlock(ready.reply)!) });
      await workflow.checkPullRequest(950);
      expect(github.statuses.at(-1)).toMatchObject({ state: "success" });

      github.editIssue(story.number, { body: storyBody({ criteria: "- AC-01: changed" }) });
      await workflow.checkPullRequest(950);
      expect(github.statuses.at(-1)?.description).toMatch(/^E_NOT_APPROVED.*parent story/u);
      expect((await readyTask(task.number)).ready.reply).toContain("E_NOT_APPROVED");
    });

    it("requires a story as parent in lanes that need approval", async () => {
      expect((await readyTask(newTask(null).number)).ready.reply).toContain("E_FORM");
      const epic = github.addIssue({ title: "[Epic] A", body: "x", labels: [LABELS.epic] });
      expect((await readyTask(newTask(epic.number).number)).ready.reply).toContain("E_WRONG_KIND");
    });

    it("cannot be accepted by the PO; acceptance happens on the story", async () => {
      const { story } = await readyStory();
      const task = newTask(story.number);
      const { baseline } = await readyTask(task.number);
      github.runs.set(45, {
        id: 45,
        runAttempt: 1,
        path: ".github/workflows/build.yml",
        event: "push",
        headBranch: "main",
        headSha: BUILD_SHA,
        status: "completed",
        conclusion: "success",
        repositoryId: 777,
      });
      const reply = (
        await command(
          task.number,
          `/ai-dlc accept baseline=${baseline.id} run=45 commit=${BUILD_SHA}`,
        )
      ).reply;
      expect(reply).toContain("E_WRONG_KIND");
      expect((await github.getIssue(task.number)).state).toBe("open");
    });
  });

  it("revokes a decision and reports edited decision comments", async () => {
    const { story, approve } = await readyStory();
    const decision = /`(dec-[0-9a-f]{16})`/u.exec(approve.reply)?.[1] as string;
    expect(
      (
        await command(
          story.number,
          `/ai-dlc revoke decision=${decision} reason="sai phạm vi"`,
          OUTSIDER,
        )
      ).reply,
    ).toContain("E_ROLE");
    expect(
      (await command(story.number, `/ai-dlc revoke decision=${decision} reason="sai phạm vi"`, PO))
        .reply,
    ).toContain("Đã thu hồi");

    await workflow.handleComment(story.number, approve.id, "edited");
    expect(github.botComment(story.number, `ai-dlc:invalidated:${approve.id}`)).toContain(decision);
  });

  it("ignores planner commands and bot comments", async () => {
    const story = github.addIssue({
      title: "[Story] A",
      body: storyBody(),
      labels: [LABELS.story],
    });
    expect((await command(story.number, "/ai-dlc refine plan=plan-1-r1-abcd", PO)).reply).toBe("");
    const bot = github.addComment(
      story.number,
      { id: 1, login: "x[bot]", type: "Bot" },
      "/ai-dlc baseline",
    );
    await workflow.handleComment(story.number, bot.id, "created");
    expect(await evidence.list("baselines/")).toHaveLength(0);
  });
});
