import { describe, expect, it, vi } from "vitest";
import { GitHubModels } from "../../src/adapters/github-models.js";
import { AiDlcError } from "../../src/core/errors.js";

describe("GitHubModels adapter", () => {
  it("formats prompt, parses JSON output, and returns usage", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"plan":{"epics":[]}}',
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    });
    vi.stubGlobal("fetch", fakeFetch);

    const model = new GitHubModels({ token: "ghp_test_123" });
    expect(model.modelId).toBe("gpt-4o-mini (GitHub Models)");

    const result = await model.generateJson({
      system: "You are a planner",
      user: "Build an auth system",
      jsonSchema: { type: "object" },
    });

    expect(result.text).toBe('{"plan":{"epics":[]}}');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("strips markdown code blocks if the model wrapped the JSON in fences", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: '```json\n{"ok":true}\n```',
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    });
    vi.stubGlobal("fetch", fakeFetch);

    const model = new GitHubModels({ token: "ghp_test_123" });
    const result = await model.generateJson({
      system: "Sys",
      user: "User",
      jsonSchema: {},
    });

    expect(result.text).toBe('{"ok":true}');
    vi.unstubAllGlobals();
  });

  it("throws friendly error when hitting rate limits (HTTP 429)", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Rate limit exceeded",
    });
    vi.stubGlobal("fetch", fakeFetch);

    const model = new GitHubModels({ token: "ghp_test_123", maxRetries: 0 });
    await expect(
      model.generateJson({
        system: "Sys",
        user: "User",
        jsonSchema: {},
      }),
    ).rejects.toThrowError(/Rate limit/);

    vi.unstubAllGlobals();
  });
});
