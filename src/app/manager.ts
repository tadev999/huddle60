import { GoogleGenAI } from "@google/genai";
import { parseDocument } from "yaml";
import { GeminiModel } from "../adapters/gemini.js";
import { GitHubModels } from "../adapters/github-models.js";
import { GitBranchEvidenceStore } from "../adapters/git-evidence.js";
import {
  connectRepository,
  octokitFromToken,
  isStatus,
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
  repoSource: "cli" | "git" | "env" | "config" | "tenant" | "none";
  recentRepos: string[];
  hasGithubToken: boolean;
  githubTokenMasked: string;
  githubUser: { login: string; id: number; avatarUrl?: string } | null;
  hasGeminiKey: boolean;
  geminiKeyMasked: string;
  geminiModel: string;
  activeAiProvider: "gemini" | "github_models" | "none";
  activeAiModel: string;
  policyStatus: "ready" | "missing";
  policyRoles: Policy["roles"] | null;
  canEditRoles: boolean;
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
  private currentPolicy: Policy | null = null;
  private missing: SetupMissingReason[] = [];
  private lastError?: string;
  private cachedUserRepos: UserRepoItem[] | null = null;
  private cachedUserReposTime: number = 0;
  private canWriteRepo: boolean = false;

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
    this.currentPolicy = null;
    this.githubUser = null;
    this.canWriteRepo = false;

    const fileConfig = await readConfig(this.options.tenant);
    this.recentRepos = fileConfig.recentRepos ?? [];

    // 1. Resolve GitHub Token
    if (fileConfig.githubDisconnected) {
      this.currentToken = null;
    } else {
      this.currentToken =
        process.env.GH_TOKEN ??
        process.env.GITHUB_TOKEN ??
        fileConfig.githubToken ??
        getGhCliToken() ??
        null;
    }

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
    } else if (!this.options.tenant) {
      const gitRemote = detectGitRemoteRepo();
      if (gitRemote) {
        repoCandidate = gitRemote;
        this.repoSource = "git";
      } else {
        this.repoSource = "none";
      }
    } else {
      // Auto-discover tenant's public/member repositories if no repo was configured yet
      try {
        const tenantRepos = await this.listUserRepos();
        if (tenantRepos.length > 0 && tenantRepos[0]) {
          repoCandidate = tenantRepos[0].fullName;
          this.repoSource = "tenant";
          if (this.recentRepos.length === 0) {
            this.recentRepos = tenantRepos.map((r) => r.fullName).slice(0, 20);
          }
        } else {
          this.repoSource = "none";
        }
      } catch {
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

    if (!this.currentRepo) {
      this.missing.push("missing_repo");
      return;
    }

    // Connect to GitHub
    let octokit: GitHubClient;
    if (this.currentToken) {
      try {
        octokit = octokitFromToken(this.currentToken);
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
    } else {
      octokit = octokitFromToken(null);
      this.githubUser = null;
      this.missing.push("missing_github_token");
    }

    let github: OctokitGitHub;
    try {
      github = await connectRepository(octokit, this.currentRepo!.owner, this.currentRepo!.repo);
      this.canWriteRepo = github.canWrite();
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
      this.currentPolicy = policy;
      this.policyReady = true;
    } catch (err: unknown) {
      this.missing.push("missing_policy");
      this.lastError = err instanceof Error ? err.message : String(err);
      return;
    }

    const modelInstance = this.currentGeminiKey
      ? new GeminiModel({
          apiKey: this.currentGeminiKey,
          model: this.currentGeminiModel,
          timeoutMs: 120_000,
          maxRetries: 1,
        })
      : this.currentToken
        ? new GitHubModels({
            token: this.currentToken,
            model: "gpt-4o-mini",
            timeoutMs: 120_000,
            maxRetries: 1,
          })
        : null;

    this.activeApp = new LocalApp({
      github,
      evidence: new GitBranchEvidenceStore(
        octokit,
        this.currentRepo!.owner,
        this.currentRepo!.repo,
        policy.evidence.branch,
      ),
      model: modelInstance,
      clock: systemClock,
      logger: this.options.logger,
    });
  }

  async session() {
    const activePlanner = this.currentGeminiKey
      ? { provider: "gemini", model: this.currentGeminiModel }
      : this.currentToken
        ? { provider: "github_models", model: "gpt-4o-mini" }
        : null;

    if (this.activeApp) {
      const baseSession = await this.activeApp.session();
      return {
        status: "ready" as const,
        tenant: this.options.tenant ?? null,
        recentRepos: this.recentRepos,
        canInitRepo: this.canWriteRepo,
        policyRoles: this.currentPolicy ? this.currentPolicy.roles : null,
        canEditRoles: this.canEditRoles(),
        ...baseSession,
        viewer: this.githubUser ? { id: this.githubUser.id, login: this.githubUser.login } : null,
        roles: this.githubUser ? baseSession.roles : [],
        planner: activePlanner,
      };
    }

    return {
      status: "needs_setup" as const,
      tenant: this.options.tenant ?? null,
      recentRepos: this.recentRepos,
      canInitRepo: Boolean(this.githubUser && this.canWriteRepo),
      policyRoles: this.currentPolicy ? this.currentPolicy.roles : null,
      canEditRoles: this.canEditRoles(),
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
      planner: activePlanner,
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
      activeAiProvider: this.currentGeminiKey
        ? "gemini"
        : this.currentToken
          ? "github_models"
          : "none",
      activeAiModel: this.currentGeminiKey ? this.currentGeminiModel : "gpt-4o-mini",
      policyStatus: this.policyReady ? "ready" : "missing",
      policyRoles: this.currentPolicy ? this.currentPolicy.roles : null,
      canEditRoles: this.canEditRoles(),
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
    if (this.options.tenant && patch.repo && patch.repo.trim().length > 0) {
      let cleanRepo = patch.repo.trim();
      const parts = cleanRepo.split("/");
      if (parts.length === 1 && parts[0]) {
        cleanRepo = `${this.options.tenant}/${parts[0]}`;
        patch.repo = cleanRepo;
      } else if (
        parts.length === 2 &&
        parts[0] &&
        parts[1] &&
        parts[0].toLowerCase() !== this.options.tenant.toLowerCase()
      ) {
        throw new AiDlcError(
          "E_CONFIG",
          `Không gian làm việc "${this.options.tenant}" chỉ quản lý các repository thuộc quyền sở hữu của "${this.options.tenant}" (ví dụ: ${this.options.tenant}/${parts[1]}).`,
        );
      }
    }

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

  async connectFromGhCli(): Promise<{
    ok: boolean;
    message: string;
    viewer?: { id: number; login: string; avatarUrl?: string };
  }> {
    const token = getGhCliToken();
    if (!token) {
      throw new AiDlcError(
        "E_CONFIG",
        "Không tìm thấy phiên đăng nhập từ GitHub CLI (`gh`). Bạn có thể chạy `gh auth login` trong terminal hoặc nhập Personal Access Token bên dưới.",
      );
    }
    const check = await this.testGithub(token);
    if (!check.ok || !check.viewer) {
      throw new AiDlcError(
        "E_CONFIG",
        `Token từ GitHub CLI không hợp lệ: ${check.error || "Không thể xác thực"}`,
      );
    }
    await this.updateSettings({ githubToken: token });
    return {
      ok: true,
      message: `Đã kết nối thành công với tài khoản @${check.viewer.login} từ GitHub CLI!`,
      viewer: check.viewer,
    };
  }

  async disconnectGithub(): Promise<{ ok: boolean }> {
    this.cachedUserRepos = null;
    this.cachedUserReposTime = 0;
    this.githubUser = null;
    this.canWriteRepo = false;
    await this.updateSettings({ githubToken: "" });
    return { ok: true };
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
    const now = Date.now();
    if (!forceRefresh && this.cachedUserRepos && now - this.cachedUserReposTime < 120_000) {
      return this.cachedUserRepos;
    }

    try {
      const octokit = octokitFromToken(this.currentToken);
      const itemsMap = new Map<string, UserRepoItem>();

      const addRepo = (r: {
        full_name: string;
        owner: { login: string };
        name: string;
        private?: boolean;
        description?: string | null;
        default_branch?: string;
        updated_at?: string | null;
      }) => {
        if (!itemsMap.has(r.full_name)) {
          itemsMap.set(r.full_name, {
            fullName: r.full_name,
            owner: r.owner.login,
            name: r.name,
            isPrivate: Boolean(r.private),
            description: r.description ?? null,
            defaultBranch: r.default_branch ?? "main",
            updatedAt: r.updated_at ?? null,
          });
        }
      };

      // 1. If authenticated, always fetch authenticated user's repos first (includes PRIVATE repos)
      if (this.currentToken) {
        try {
          const authIterator = octokit.paginate.iterator(
            octokit.rest.repos.listForAuthenticatedUser,
            {
              per_page: 100,
              sort: "updated",
              visibility: "all",
              affiliation: "owner,collaborator,organization_member",
            },
          );

          for await (const response of authIterator) {
            for (const r of response.data) {
              if (
                !this.options.tenant ||
                r.owner.login.toLowerCase() === this.options.tenant.toLowerCase()
              ) {
                addRepo(r);
              }
              if (itemsMap.size >= 200) break;
            }
            if (itemsMap.size >= 200) break;
          }
        } catch (authErr: unknown) {
          this.options.logger.warn?.(
            `Failed to list authenticated repos: ${authErr instanceof Error ? authErr.message : String(authErr)}`,
          );
        }
      }

      // 2. Fetch tenant's (or current repo owner's) public repos if not reached limit
      const targetOwner =
        this.options.tenant ||
        (!this.currentToken && this.currentRepo ? this.currentRepo.owner : null);
      if (targetOwner && itemsMap.size < 200) {
        let isOrg = true;
        try {
          const orgIterator = octokit.paginate.iterator(octokit.rest.repos.listForOrg, {
            org: targetOwner,
            sort: "updated",
            per_page: 100,
          });

          for await (const response of orgIterator) {
            for (const r of response.data) {
              addRepo(r);
              if (itemsMap.size >= 200) break;
            }
            if (itemsMap.size >= 200) break;
          }
        } catch (orgErr: unknown) {
          if (isStatus(orgErr, 404)) {
            isOrg = false;
          } else {
            this.options.logger.warn?.(
              `Failed to list org repos for ${targetOwner}: ${orgErr instanceof Error ? orgErr.message : String(orgErr)}`,
            );
          }
        }

        if (!isOrg && itemsMap.size < 200) {
          try {
            const userIterator = octokit.paginate.iterator(octokit.rest.repos.listForUser, {
              username: targetOwner,
              sort: "updated",
              per_page: 100,
            });

            for await (const response of userIterator) {
              for (const r of response.data) {
                addRepo(r);
                if (itemsMap.size >= 200) break;
              }
              if (itemsMap.size >= 200) break;
            }
          } catch (userErr: unknown) {
            this.options.logger.warn?.(
              `Failed to list user repos for ${targetOwner}: ${userErr instanceof Error ? userErr.message : String(userErr)}`,
            );
          }
        }
      }

      const items = Array.from(itemsMap.values());
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
    if (!github.canWrite()) {
      throw new AiDlcError(
        "E_ROLE",
        "Bạn không có quyền ghi (Push/Admin) trên repository này để khởi tạo chuẩn AI-DLC.",
      );
    }
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

  canEditRoles(): boolean {
    if (!this.currentToken || !this.currentRepo) return false;
    if (this.canWriteRepo) return true;
    if (this.githubUser && this.currentPolicy) {
      return this.currentPolicy.roles.maintainer.some((m) => m.id === this.githubUser!.id);
    }
    return false;
  }

  getPolicyRoles(): Policy["roles"] | null {
    return this.currentPolicy ? this.currentPolicy.roles : null;
  }

  async resolveUser(username: string): Promise<{ id: number; login: string; avatarUrl?: string }> {
    const octokit = octokitFromToken(this.currentToken);
    const clean = username.replace(/^@/, "").trim();
    if (!clean) {
      throw new AiDlcError("E_CONFIG", "Vui lòng nhập GitHub username.");
    }
    try {
      const { data } = await octokit.rest.users.getByUsername({ username: clean });
      return {
        id: data.id,
        login: data.login,
        avatarUrl: data.avatar_url,
      };
    } catch (err: unknown) {
      if (isStatus(err, 404)) {
        throw new AiDlcError("E_CONFIG", `Không tìm thấy tài khoản GitHub: @${clean}`);
      }
      throw new AiDlcError("E_GITHUB_API", err instanceof Error ? err.message : String(err));
    }
  }

  async updatePolicyRoles(newRoles: Policy["roles"]): Promise<{
    ok: boolean;
    message: string;
    roles: Policy["roles"];
  }> {
    if (!this.currentToken) {
      throw new AiDlcError("E_ROLE", "Cần kết nối GitHub để cập nhật phân quyền.");
    }
    if (!this.currentRepo) {
      throw new AiDlcError("E_CONFIG", "Chưa chọn repository.");
    }
    if (!this.canEditRoles()) {
      throw new AiDlcError(
        "E_ROLE",
        "Bạn không có quyền Maintainer hoặc quyền ghi (Admin/Push) trên repository này để chỉnh sửa phân quyền.",
      );
    }

    if (!newRoles.po || newRoles.po.length === 0) {
      throw new AiDlcError("E_ROLE", "Dự án phải có ít nhất 1 Product Owner (PO).");
    }
    if (!newRoles.maintainer || newRoles.maintainer.length === 0) {
      throw new AiDlcError("E_ROLE", "Dự án phải có ít nhất 1 Maintainer.");
    }

    const allMembers = [...newRoles.po, ...(newRoles.dev || []), ...newRoles.maintainer];
    for (const m of allMembers) {
      if (m.login.endsWith("[bot]")) {
        throw new AiDlcError(
          "E_ROLE",
          `Tài khoản bot ${m.login} không thể giữ vai trò trong policy.`,
        );
      }
    }

    const { owner, repo } = this.currentRepo;
    const octokit = octokitFromToken(this.currentToken);
    const github = await connectRepository(octokit, owner, repo);
    const defaultBranch = await github.getDefaultBranch();

    let targetPath = POLICY_PATH;
    let sha: string | undefined;
    let existingYaml: string | null = null;

    try {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: POLICY_PATH,
        ref: defaultBranch,
      });
      if ("sha" in data && "content" in data) {
        sha = data.sha;
        existingYaml = Buffer.from(data.content, "base64").toString("utf8");
      }
    } catch (err1: unknown) {
      if (isStatus(err1, 404)) {
        try {
          const { data } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: LEGACY_POLICY_PATH,
            ref: defaultBranch,
          });
          if ("sha" in data && "content" in data) {
            targetPath = LEGACY_POLICY_PATH;
            sha = data.sha;
            existingYaml = Buffer.from(data.content, "base64").toString("utf8");
          }
        } catch {}
      }
    }

    let updatedYaml: string;
    if (existingYaml) {
      const doc = parseDocument(existingYaml);
      doc.set("roles", {
        po: newRoles.po.map((p) => ({ id: p.id, login: p.login })),
        dev: (newRoles.dev || []).map((d) => ({ id: d.id, login: d.login })),
        maintainer: newRoles.maintainer.map((m) => ({ id: m.id, login: m.login })),
      });
      updatedYaml = doc.toString();
    } else {
      updatedYaml = `# huddle60 policy (AI-DLC protocol).
version: 1
roles:
  po:
${newRoles.po.map((p) => `    - id: ${p.id}\n      login: ${p.login}`).join("\n")}
  dev:
${(newRoles.dev || []).map((d) => `    - id: ${d.id}\n      login: ${d.login}`).join("\n")}
  maintainer:
${newRoles.maintainer.map((m) => `    - id: ${m.id}\n      login: ${m.login}`).join("\n")}
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
    }

    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: targetPath,
      message: "chore(policy): update team roles (PO, DEV, Maintainer) [skip ci]",
      content: Buffer.from(updatedYaml, "utf8").toString("base64"),
      ...(sha ? { sha } : {}),
      branch: defaultBranch,
    });

    await this.reload();

    return {
      ok: true,
      message: "Đã cập nhật phân quyền thành công trên GitHub!",
      roles: this.currentPolicy ? this.currentPolicy.roles : newRoles,
    };
  }
}
