import { setTimeout as delay } from "node:timers/promises";
import { canonicalJson } from "../core/canonical.js";
import { AiDlcError } from "../core/errors.js";
import type { EvidenceStore } from "../ports.js";
import { isStatus, type GitHubClient } from "./github.js";

const MAX_ATTEMPTS = 5;

/**
 * Append-only JSON files on a dedicated branch, written through the Git Data API.
 * Every file has a unique path, so concurrent writers only race on the branch ref
 * and simply retry on a non-fast-forward update.
 */
export class GitBranchEvidenceStore implements EvidenceStore {
  constructor(
    private readonly octokit: GitHubClient,
    private readonly owner: string,
    private readonly repo: string,
    private readonly branch: string,
  ) {}

  private get base() {
    return { owner: this.owner, repo: this.repo };
  }

  private async readAt<T>(path: string, ref: string): Promise<T | null> {
    try {
      const { data } = await this.octokit.rest.repos.getContent({ ...this.base, path, ref });
      if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return null;
      return JSON.parse(Buffer.from(data.content, "base64").toString("utf8")) as T;
    } catch (error) {
      if (isStatus(error, 404)) return null;
      throw error;
    }
  }

  async read<T>(path: string): Promise<T | null> {
    return this.readAt<T>(path, this.branch);
  }

  async list(prefix: string): Promise<string[]> {
    const directory = prefix.replace(/\/+$/u, "");
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        ...this.base,
        path: directory,
        ref: this.branch,
      });
      if (!Array.isArray(data)) return [];
      return data
        .filter((entry) => entry.type === "file")
        .map((entry) => entry.path)
        .sort();
    } catch (error) {
      if (isStatus(error, 404)) return [];
      throw error;
    }
  }

  async write(path: string, value: unknown): Promise<"created" | "unchanged"> {
    const canonical = canonicalJson(value);
    const content = `${JSON.stringify(JSON.parse(canonical), null, 2)}\n`;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const head = await this.headCommit();
      const existing = await this.readAt<unknown>(path, head.sha);
      if (existing !== null) {
        if (canonicalJson(existing) === canonical) return "unchanged";
        throw new AiDlcError(
          "E_CONFLICT",
          `Evidence already exists with different content at ${path}.`,
        );
      }
      const blob = await this.octokit.rest.git.createBlob({
        ...this.base,
        content,
        encoding: "utf-8",
      });
      const tree = await this.octokit.rest.git.createTree({
        ...this.base,
        base_tree: head.treeSha,
        tree: [{ path, mode: "100644", type: "blob", sha: blob.data.sha }],
      });
      const commit = await this.octokit.rest.git.createCommit({
        ...this.base,
        message: `ai-dlc: add ${path}`,
        tree: tree.data.sha,
        parents: [head.sha],
      });
      try {
        await this.octokit.rest.git.updateRef({
          ...this.base,
          ref: `heads/${this.branch}`,
          sha: commit.data.sha,
          force: false,
        });
        return "created";
      } catch (error) {
        if (!isStatus(error, 409, 422) || attempt === MAX_ATTEMPTS) throw error;
        await delay(250 * 2 ** attempt);
      }
    }
    throw new AiDlcError("E_GITHUB_API", `Could not write ${path} after ${MAX_ATTEMPTS} attempts.`);
  }

  private async headCommit(): Promise<{ sha: string; treeSha: string }> {
    try {
      const ref = await this.octokit.rest.git.getRef({ ...this.base, ref: `heads/${this.branch}` });
      const commit = await this.octokit.rest.git.getCommit({
        ...this.base,
        commit_sha: ref.data.object.sha,
      });
      return { sha: commit.data.sha, treeSha: commit.data.tree.sha };
    } catch (error) {
      if (isStatus(error, 404)) {
        throw new AiDlcError(
          "E_GITHUB_API",
          `Evidence branch \`${this.branch}\` does not exist. Run \`huddle60 init\`.`,
        );
      }
      throw error;
    }
  }

  /** Creates the evidence branch as an orphan commit. Safe to call when it already exists. */
  async initialize(): Promise<"created" | "exists"> {
    try {
      await this.octokit.rest.git.getRef({ ...this.base, ref: `heads/${this.branch}` });
      return "exists";
    } catch (error) {
      if (!isStatus(error, 404)) throw error;
    }
    const readme = [
      "# AI-DLC evidence",
      "",
      "Append-only baselines, decision receipts and revocations written by the AI-DLC GitHub App.",
      "Do not edit or force-push this branch; protect it with a ruleset.",
      "",
    ].join("\n");
    const blob = await this.octokit.rest.git.createBlob({
      ...this.base,
      content: readme,
      encoding: "utf-8",
    });
    const tree = await this.octokit.rest.git.createTree({
      ...this.base,
      tree: [{ path: "README.md", mode: "100644", type: "blob", sha: blob.data.sha }],
    });
    const commit = await this.octokit.rest.git.createCommit({
      ...this.base,
      message: "ai-dlc: initialize evidence branch",
      tree: tree.data.sha,
      parents: [],
    });
    await this.octokit.rest.git.createRef({
      ...this.base,
      ref: `refs/heads/${this.branch}`,
      sha: commit.data.sha,
    });
    return "created";
  }
}
