import { beforeEach, describe, expect, it } from "vitest";
import { MemoryEvidenceStore, silentLogger } from "../../src/adapters/memory.js";
import { LocalApp } from "../../src/app/local-app.js";
import { buildBaseline } from "../../src/core/baseline.js";
import type { ModelPlan } from "../../src/core/plan.js";
import { POLICY_PATH } from "../../src/core/policy.js";
import { KNOWLEDGE_PATH, SECTIONS } from "../../src/core/vocabulary.js";
import { buildRepoMap, exploreRepository, isDenied } from "../../src/planner/explorer.js";
import { generateKnowledge } from "../../src/planner/knowledge.js";
import type { RepoFile } from "../../src/ports.js";
import { FakeGitHub, FakeModel, POLICY_YAML, fixedClock } from "../helpers/fakes.js";
import { loginPlan } from "../helpers/fixtures.js";

class RepoGitHub extends FakeGitHub {
  repoFiles: RepoFile[] = [];
  async listRepoFiles(): Promise<RepoFile[]> {
    return this.repoFiles;
  }
}

const SOURCES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "shop", dependencies: { express: "^5" } }),
  "src/auth/session.ts": "export const SESSION_TTL_MINUTES = 30;",
  "src/server.ts": "app.get('/health', ok);",
  ".env": "GOOGLE_SECRET=do-not-leak",
  "node_modules/x/index.js": "vendored",
  "assets/logo.png": "binary",
  [KNOWLEDGE_PATH]: "# Project knowledge\nSessions live in src/auth/session.ts.",
};

const scout = (...paths: string[]) => ({
  files: paths.map((path) => ({ path, reason: "relevant" })),
});

function planWithImpact(): ModelPlan {
  const plan = loginPlan({
    openQuestions: [
      {
        text: "Phiên đăng nhập kéo dài bao lâu?",
        blocking: true,
        suggestedAnswer: "30 phút như hiện tại",
        evidence: "src/auth/session.ts: SESSION_TTL_MINUTES = 30",
      },
    ],
  });
  plan.nodes = plan.nodes.map((node) =>
    node.localId === "story-login"
      ? {
          ...node,
          impact: {
            files: ["src/auth/session.ts", "src/auth/google.ts"],
            reuse: ["SESSION_TTL_MINUTES trong src/auth/session.ts"],
            tests: ["tests/auth/google.test.ts"],
            confidence: "high" as const,
          },
        }
      : node,
  );
  return plan;
}

describe("repository explorer", () => {
  let github: RepoGitHub;
  let model: FakeModel;

  beforeEach(() => {
    github = new RepoGitHub();
    model = new FakeModel();
    for (const [path, content] of Object.entries(SOURCES)) github.files.set(path, content);
    github.repoFiles = Object.keys(SOURCES).map((path) => ({ path, size: 100 }));
  });

  it("denies secrets and skips vendored or binary files", () => {
    expect(isDenied(".env")).toBe(true);
    expect(isDenied("src/environment.ts")).toBe(false);
    expect(isDenied("deploy/.env.production")).toBe(true);
    expect(isDenied("keys/server.pem")).toBe(true);
    expect(isDenied("src/app/internal.ts", ["src/app/**"])).toBe(true);
    const map = buildRepoMap(["src/a/b/c.ts", "README.md", "src/x.ts"]);
    expect(map.indexOf("README.md")).toBeLessThan(map.indexOf("src/a/b/c.ts"));
  });

  it("reads only scout-picked files that exist and are allowed", async () => {
    model.respondWith(scout("src/auth/session.ts", ".env", "src/missing.ts"));
    const insight = await exploreRepository(
      { github, model, logger: silentLogger },
      { title: "Login", request: "Đăng nhập Google" },
    );
    expect(insight?.files.map((file) => file.path)).toEqual(["src/auth/session.ts"]);
    expect(insight?.knowledge).toContain("Sessions live");
    expect(insight?.overview).toContain("express");
    expect(insight?.repoMap).not.toContain(".env");
    expect(insight?.repoMap).not.toContain("node_modules");
    expect(insight?.repoMap).not.toContain("logo.png");
    expect(model.calls[0]?.user).not.toContain("do-not-leak");
  });

  it("keeps planning when the scout answer is unusable", async () => {
    model.respondWith("not json");
    const insight = await exploreRepository(
      { github, model, logger: silentLogger },
      { title: "Login", request: "Đăng nhập Google" },
    );
    expect(insight?.files).toEqual([]);
    expect(insight?.repoMap).toContain("src/server.ts");
  });

  it("generates a knowledge pack that keeps previous human notes in the prompt", async () => {
    model.respondWith(scout("src/server.ts"), {
      overview: "Express API cho cửa hàng.",
      modules: [{ path: "src/auth", purpose: "Phiên đăng nhập" }],
      glossary: [{ term: "Phiên", meaning: "Session người dùng" }],
      conventions: ["TypeScript strict"],
      testing: ["npm test"],
      sensitiveAreas: ["src/auth/**"],
    });
    const { markdown } = await generateKnowledge(
      { github, model, logger: silentLogger, now: fixedClock.now() },
      { maxFiles: 5, maxFileChars: 1000, maxTotalChars: 5000, deny: [] },
    );
    expect(model.calls[1]?.user).toContain("<previous_knowledge>");
    expect(model.calls[1]?.user).toContain("app.get('/health'");
    expect(markdown).toContain("# Project knowledge — acme/shop");
    expect(markdown).toContain("- `src/auth`: Phiên đăng nhập");
  });
});

describe("source-aware planning in LocalApp", () => {
  let github: RepoGitHub;
  let model: FakeModel;
  let app: LocalApp;

  beforeEach(() => {
    github = new RepoGitHub();
    model = new FakeModel();
    for (const [path, content] of Object.entries(SOURCES)) github.files.set(path, content);
    github.repoFiles = Object.keys(SOURCES).map((path) => ({ path, size: 100 }));
    app = new LocalApp({
      github,
      evidence: new MemoryEvidenceStore(),
      model,
      clock: fixedClock,
      logger: silentLogger,
    });
  });

  it("grounds the plan in source files, flags new paths and accepts suggestions in one click", async () => {
    model.respondWith(scout("src/auth/session.ts"), planWithImpact(), loginPlan());
    const draft = await app.draftPlan({ request: "Lập trình login sử dụng Google OAuth cho web" });

    const planPrompt = model.calls[1]?.user ?? "";
    expect(planPrompt).toContain("<source_files>");
    expect(planPrompt).toContain("SESSION_TTL_MINUTES");
    expect(planPrompt).toContain("<project_knowledge>");
    expect(planPrompt).not.toContain("do-not-leak");

    const story = draft.plan.nodes.find((node) => node.localId === "story-login");
    expect(story?.impact?.files).toEqual(["src/auth/session.ts", "src/auth/google.ts (mới)"]);
    expect(story?.impact?.tests).toEqual(["tests/auth/google.test.ts (mới)"]);
    expect(draft.blocking).toHaveLength(1);

    const accepted = await app.acceptSuggestions(draft.draftId);
    expect(model.calls).toHaveLength(3);
    expect(model.calls[2]?.user).toContain("30 phút như hiện tại");
    expect(accepted.blocking).toEqual([]);
  });

  it("writes the impact map outside the hashed baseline", async () => {
    model.respondWith(scout("src/auth/session.ts"), {
      ...planWithImpact(),
      openQuestions: [],
    });
    const draft = await app.draftPlan({ request: "Lập trình login sử dụng Google OAuth cho web" });
    const created = await app.createPlan(draft.draftId);
    const storyNumber = created.created?.issues["story-login"] ?? 0;
    const issue = await github.getIssue(storyNumber);
    expect(issue.body).toContain(`### ${SECTIONS.impact}`);
    expect(issue.body).toContain("`src/auth/google.ts (mới)`");

    const input = { ...issue, repositoryId: github.repo.repositoryId, issueNodeId: issue.nodeId };
    const before = buildBaseline(input);
    const edited = issue.body.replace("src/auth/google.ts (mới)", "src/auth/oauth.ts");
    expect(buildBaseline({ ...input, body: edited }).contentHash).toBe(before.contentHash);
  });

  it("skips source reading when the policy disables it", async () => {
    github.files.set(POLICY_PATH, `${POLICY_YAML}planner:\n  read_source: false\n`);
    model.respondWith(loginPlan());
    await app.draftPlan({ request: "Lập trình login sử dụng Google OAuth cho web" });
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.user).not.toContain("<source_files>");
  });

  it("rejects accepting suggestions when there are none", async () => {
    model.respondWith(scout(), loginPlan({ openQuestions: [] }));
    const draft = await app.draftPlan({ request: "Lập trình login sử dụng Google OAuth cho web" });
    await expect(app.acceptSuggestions(draft.draftId)).rejects.toMatchObject({ code: "E_FORM" });
  });
});
