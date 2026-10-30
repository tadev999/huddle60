import { GoogleGenAI } from "@google/genai";
import { GeminiModel } from "../adapters/gemini.js";
import { GitBranchEvidenceStore } from "../adapters/git-evidence.js";
import {
  connectRepository,
  octokitFromToken,
  type GitHubClient,
  type OctokitGitHub,
} from "../adapters/github.js";
import { LABEL_COLORS, LocalApp } from "./local-app.js";
import {
  detectGitRemoteRepo,
  getGhCliToken,
  getMacKeychainGeminiKey,
  maskSecret,
  parseRepoString,
  readConfig,
  writeConfig,
  type Huddle60Config,
} from "../core/config.js";
import { AiDlcError } from "../core/errors.js";
import { POLICY_PATH, LEGACY_POLICY_PATH, parsePolicy, type Policy } from "../core/policy.js";
import { systemClock, type Logger } from "../ports.js";

export const AVAILABLE_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.5-flash",
  "gemini-2.5-pro",
];

export interface AppManagerOptions {
  explicitRepo?: string;
  tenant?: string;
  logger: Logger;
}

export type SetupMissingReason =
  | "missing_github_token"
  | "missing_repo"
  | "invalid_github_token"
  | "repo_not_found"
  | "missing_policy";

export interface SettingsView {
  tenant?: string | null;
  repo: string;
  repoSource: "cli" | "git" | "env" | "config" | "none";
  recentRepos: string[];
  hasGithubToken: boolean;
  githubTokenMasked: string;
  githubUser: { login: string; id: number; avatarUrl?: string } | null;
  hasGeminiKey: boolean;
  geminiKeyMasked: string;
  geminiModel: string;
  policyStatus: "ready" | "missing";
  status: "ready" | "needs_setup";
  missing: SetupMissingReason[];
  errorMessage?: string;
  availableModels: string[];
}

export interface UserRepoItem {
  fullName: string;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string | null;
  defaultBranch: string;
  updatedAt: string | null;
}

export class LocalAppManager {
  private activeApp: LocalApp | null = null;
  private currentRepo: { owner: string; repo: string } | null = null;
  private recentRepos: string[] = [];
  private repoSource: SettingsView["repoSource"] = "none";
  private currentToken: string | null = null;
  private currentGeminiKey: string | null = null;
  private currentGeminiModel: string = "gemini-3.8-flash";
  private githubUser: { login: string; id: number; avatarUrl?: string } | null = null;
  private policyReady: boolean = false;
  private missing: SetupMissingReason[] = [];
  private lastError?: string;
  private cachedUserRepos: UserRepoItem[] | null = null;
  private cachedUserReposTime: number = 0;

  constructor(private readonly options: AppManagerOptions) {}

  get app(): LocalApp {
    if (!this.activeApp) {
      throw new AiDlcError(
        "E_NOT_READY",
        "Ứng dụng chưa được cấu hình hoàn chỉnh. Vui lòng hoàn tất trong mục Cài đặt.",
      );
    }
    return this.activeApp;
  }

  get isReady(): boolean {
    return Boolean(this.activeApp);
  }

  async initialize(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    this.activeApp = null;
    this.missing = [];
    this.lastError = undefined;
    this.policyReady = false;
    this.githubUser = null;

    const fileConfig = await readConfig(this.options.tenant);
    this.recentRepos = fileConfig.recentRepos ?? [];

    // 1. Resolve GitHub Token
    this.currentToken =
      process.env.GH_TOKEN ??
      process.env.GITHUB_TOKEN ??
      fileConfig.githubToken ??
      getGhCliToken() ??
      null;

    // 2. Resolve Repo
    let repoCandidate: string | undefined;
    if (this.options.explicitRepo) {
      repoCandidate = this.options.explicitRepo;
      this.repoSource = "cli";
    } else if (process.env.GITHUB_REPOSITORY) {
      repoCandidate = process.env.GITHUB_REPOSITORY;
      this.repoSource = "env";
    } else if (fileConfig.repo) {
      repoCandidate = fileConfig.repo;
      this.repoSource = "config";
    } else {
      const gitRemote = detectGitRemoteRepo();
      if (gitRemote) {
        repoCandidate = gitRemote;
        this.repoSource = "git";
      } else {
        this.repoSource = "none";
      }
    }

    this.currentRepo = parseRepoString(repoCandidate);
    if (this.currentRepo) {
      const currentRepoStr = `${this.currentRepo.owner}/${this.currentRepo.repo}`;
      if (!this.recentRepos.includes(currentRepoStr)) {
        this.recentRepos = [currentRepoStr, ...this.recentRepos].slice(0, 20);
      }
    }

    // 3. Resolve Gemini Key & Model
    this.currentGeminiKey =
      process.env.GEMINI_API_KEY ?? fileConfig.geminiApiKey ?? getMacKeychainGeminiKey() ?? null;

    this.currentGeminiModel =
      process.env.AI_DLC_MODEL ?? fileConfig.geminiModel ?? "gemini-3.8-flash";

    if (!this.currentToken) {
      this.missing.push("missing_github_token");
    }

    if (!this.currentRepo) {
      this.missing.push("missing_repo");
    }

    if (this.missing.length > 0) return;

    // We have both token and repo candidate. Now try connecting to GitHub
    let octokit: GitHubClient;
    try {
      octokit = octokitFromToken(this.currentToken!);
      const { data: viewerData } = await octokit.rest.users.getAuthenticated();
      this.githubUser = {
        login: viewerData.login,
        id: viewerData.id,
        avatarUrl: viewerData.avatar_url,
      };
    } catch (err: unknown) {
      this.missing.push("invalid_github_token");
      this.lastError = err instanceof Error ? err.message : String(err);
      return;
    }

    let github: OctokitGitHub;
    try {
      github = await connectRepository(octokit, this.currentRepo!.owner, this.currentRepo!.repo);
    } catch (err: unknown) {
      this.missing.push("repo_not_found");
      this.lastError = err instanceof Error ? err.message : String(err);
      return;
    }

    let policySource: string | null = null;
    try {
      const defaultBranch = await github.getDefaultBranch();
      policySource = await github.readFile(POLICY_PATH, defaultBranch);
      if (!policySource) {
        policySource = await github.readFile(LEGACY_POLICY_PATH, defaultBranch);
      }
    } catch (err: unknown) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }

    if (!policySource) {
      this.missing.push("missing_policy");
      return;
    }

    let policy: Policy;
    try {
      policy = parsePolicy(policySource);
      this.policyReady = true;
    } catch (err: unknown) {
      this.missing.push("missing_policy");
      this.lastError = err instanceof Error ? err.message : String(err);
      return;
    }

    this.activeApp = new LocalApp({
      github,
      evidence: new GitBranchEvidenceStore(
        octokit,
        this.currentRepo!.owner,
        this.currentRepo!.repo,
        policy.evidence.branch,
      ),
      model: this.currentGeminiKey
        ? new GeminiModel({
            apiKey: this.currentGeminiKey,
            model: this.currentGeminiModel,
            timeoutMs: 120_000,
            maxRetries: 1,
          })
        : null,
      clock: systemClock,
      logger: this.options.logger,
    });
  }

  async session() {
    if (this.activeApp) {
      const baseSession = await this.activeApp.session();
      return {
        status: "ready" as const,
        tenant: this.options.tenant ?? null,
        recentRepos: this.recentRepos,
        ...baseSession,
      };
    }

    return {
      status: "needs_setup" as const,
      tenant: this.options.tenant ?? null,
      recentRepos: this.recentRepos,
      missing: this.missing,
      lastError: this.lastError,
      repo: this.currentRepo
        ? {
            ...this.currentRepo,
            url: `https://github.com/${this.currentRepo.owner}/${this.currentRepo.repo}`,
          }
        : null,
      viewer: this.githubUser ? { id: this.githubUser.id, login: this.githubUser.login } : null,
      roles: [],
      planner: this.currentGeminiKey ? { model: this.currentGeminiModel } : null,
    };
  }

  async getSettings(): Promise<SettingsView> {
    return {
      tenant: this.options.tenant ?? null,
      repo: this.currentRepo ? `${this.currentRepo.owner}/${this.currentRepo.repo}` : "",
      repoSource: this.repoSource,
      recentRepos: this.recentRepos,
      hasGithubToken: Boolean(this.currentToken),
      githubTokenMasked: maskSecret(this.currentToken),
      githubUser: this.githubUser,
      hasGeminiKey: Boolean(this.currentGeminiKey),
      geminiKeyMasked: maskSecret(this.currentGeminiKey),
      geminiModel: this.currentGeminiModel,
      policyStatus: this.policyReady ? "ready" : "missing",
      status: this.activeApp ? "ready" : "needs_setup",
      missing: this.missing,
      errorMessage: this.lastError,
      availableModels: AVAILABLE_MODELS,
    };
  }

  async updateSettings(patch: {
    githubToken?: string;
    repo?: string;
    recentRepos?: string[];
    geminiApiKey?: string;
    geminiModel?: string;
  }): Promise<SettingsView> {
    await writeConfig(patch, this.options.tenant);
    if (patch.repo !== undefined) {
      this.options.explicitRepo = undefined;
    }
    if (patch.githubToken !== undefined) {
      this.cachedUserRepos = null;
      this.cachedUserReposTime = 0;
    }
    await this.reload();
    return this.getSettings();
  }

  async testGithub(token?: string): Promise<{
    ok: boolean;
    viewer?: { id: number; login: string; avatarUrl?: string };
    error?: string;
  }> {
    const testToken = token || this.currentToken;
    if (!testToken) return { ok: false, error: "Thiếu GitHub token" };
    try {
      const octokit = octokitFromToken(testToken);
      const { data } = await octokit.rest.users.getAuthenticated();
      return {
        ok: true,
        viewer: { id: data.id, login: data.login, avatarUrl: data.avatar_url },
      };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async testGemini(apiKey?: string, model?: string): Promise<{ ok: boolean; error?: string }> {
    const key = apiKey || this.currentGeminiKey;
    const targetModel = model || this.currentGeminiModel;
    if (!key) return { ok: false, error: "Thiếu Gemini API key" };
    try {
      const ai = new GoogleGenAI({ apiKey: key });
      await ai.models.generateContent({
        model: targetModel,
        contents: "test connection - reply OK",
      });
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listUserRepos(forceRefresh: boolean = false): Promise<UserRepoItem[]> {
    if (!this.currentToken) return [];
    const now = Date.now();
    if (!forceRefresh && this.cachedUserRepos && now - this.cachedUserReposTime < 120_000) {
      return this.cachedUserRepos;
    }

    try {
      const octokit = octokitFromToken(this.currentToken);
      const items: UserRepoItem[] = [];
      const iterator = octokit.paginate.iterator(octokit.rest.repos.listForAuthenticatedUser, {
        per_page: 100,
        sort: "updated",
        affiliation: "owner,collaborator,organization_member",
      });

      for await (const response of iterator) {
        for (const r of response.data) {
          items.push({
            fullName: r.full_name,
            owner: r.owner.login,
            name: r.name,
            isPrivate: Boolean(r.private),
            description: r.description ?? null,
            defaultBranch: r.default_branch,
            updatedAt: r.updated_at ?? null,
          });
          if (items.length >= 200) break;
        }
        if (items.length >= 200) break;
      }

      this.cachedUserRepos = items;
      this.cachedUserReposTime = now;
      return items;
    } catch (err: unknown) {
      this.options.logger.warn?.(
        `Failed to list user repos: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.cachedUserRepos ?? [];
    }
  }

  async initRepo(): Promise<{ ok: boolean; message: string }> {
    if (!this.currentToken)
      throw new AiDlcError("E_CONFIG", "Cần kết nối GitHub token trước khi khởi tạo.");
    if (!this.currentRepo)
      throw new AiDlcError("E_CONFIG", "Cần chọn kho lưu trữ (repository) trước.");

    const { owner, repo } = this.currentRepo;
    const octokit = octokitFromToken(this.currentToken);
    const github = await connectRepository(octokit, owner, repo);
    const viewer = await github.viewer();
    const defaultBranch = await github.getDefaultBranch();

    // 1. Create labels
    for (const [name, meta] of Object.entries(LABEL_COLORS)) {
      await github.ensureLabel({ name, ...meta });
    }

    // 2. Initialize evidence branch
    const evidenceStore = new GitBranchEvidenceStore(octokit, owner, repo, "huddle60-evidence");
    await evidenceStore.initialize();

    // 3. Ensure policy file exists on default branch
    let policySource = await github.readFile(POLICY_PATH, defaultBranch);
    if (!policySource) {
      const policyContent = `# huddle60 policy (AI-DLC protocol).
version: 1
roles:
  po:
    - id: ${viewer.id}
      login: ${viewer.login}
  dev:
    - id: ${viewer.id}
      login: ${viewer.login}
  maintainer:
    - id: ${viewer.id}
      login: ${viewer.login}
lanes:
  fast:
    requires_po_approval: false
  standard:
    requires_po_approval: true
  strict:
    requires_po_approval: true
sensitive_paths:
  - ".github/**"
  - "migrations/**"
  - "src/auth/**"
evidence:
  branch: huddle60-evidence
acceptance:
  build_workflows:
    - .github/workflows/build.yml
planner:
  max_nodes: 60
  plan_ttl_days: 30
`;
      await octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: POLICY_PATH,
        message: "chore: initialize huddle60 policy",
        content: Buffer.from(policyContent, "utf8").toString("base64"),
        branch: defaultBranch,
      });
    }

    // 4. Ensure GitHub Actions workflow exists on default branch
    const workflowPath = ".github/workflows/huddle60.yml";
    let workflowSource = await github.readFile(workflowPath, defaultBranch);
    if (!workflowSource) {
      const workflowContent = `name: huddle60
on:
  issue_comment:
    types: [created, edited, deleted]
  pull_request_target:
    types: [opened, edited, synchronize, reopened, ready_for_review]

permissions:
  contents: write
  issues: write
  pull-requests: write
  statuses: write

jobs:
  huddle60:
    if: github.event_name == 'pull_request_target' || (github.event.issue.pull_request == null && github.event.sender.type != 'Bot' && (startsWith(github.event.comment.body, '/huddle60') || startsWith(github.event.comment.body, '/ai-dlc') || github.event.action != 'created'))
    runs-on: ubuntu-latest
    steps:
      - uses: tadev999/huddle60@main
        with:
          token: \${{ secrets.GITHUB_TOKEN }}
          enabled: 'true'
`;
      await octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: workflowPath,
        message: "chore: add huddle60 GitHub Actions workflow",
        content: Buffer.from(workflowContent, "utf8").toString("base64"),
        branch: defaultBranch,
      });
    }

    // Reload manager
    await this.reload();

    return {
      ok: true,
      message: `Khởi tạo thành công AI-DLC cho ${owner}/${repo} với tài khoản @${viewer.login}!`,
    };
  }
}
