import { delay } from "../core/encoding.js";
import { AiDlcError } from "../core/errors.js";
import type { ModelPort, ModelUsage } from "../ports.js";

export interface GitHubModelsOptions {
  token: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export class GitHubModels implements ModelPort {
  private readonly token: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly endpoint: string;

  constructor(options: GitHubModelsOptions) {
    this.token = options.token;
    this.model = options.model ?? "gpt-4o-mini";
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 1;
    this.endpoint = "https://models.inference.ai.azure.com/chat/completions";
  }

  get modelId(): string {
    return `${this.model} (GitHub Models)`;
  }

  async generateJson(input: {
    system: string;
    user: string;
    jsonSchema: Record<string, unknown>;
  }): Promise<{ text: string; usage: ModelUsage }> {
    const systemPrompt = `${input.system}\n\nIMPORTANT: You must output ONLY a valid JSON object matching this schema (do NOT wrap in markdown or backticks):\n${JSON.stringify(input.jsonSchema)}`;

    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: input.user },
            ],
            response_format: { type: "json_object" },
            temperature: 0.2,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          if (response.status === 429) {
            throw new AiDlcError(
              "E_MODEL",
              "GitHub Models: Rate limit reached. Try again later or configure a Gemini API key in Settings.",
            );
          }
          if (response.status === 401 || response.status === 403) {
            throw new AiDlcError(
              "E_MODEL",
              `Your GitHub token cannot access GitHub Models (HTTP ${response.status}). Check token permissions or configure a Gemini API key.`,
            );
          }
          const err = new Error(`HTTP ${response.status}: ${errorBody}`);
          (err as { status?: number }).status = response.status;
          throw err;
        }

        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };

        let text = data.choices?.[0]?.message?.content;
        if (!text) {
          throw new AiDlcError("E_MODEL", "GitHub Models returned an empty response.");
        }

        // Clean up markdown fences if present
        text = text.trim();
        if (text.startsWith("```json")) {
          text = text.slice(7);
        } else if (text.startsWith("```")) {
          text = text.slice(3);
        }
        if (text.endsWith("```")) {
          text = text.slice(0, -3);
        }
        text = text.trim();

        return {
          text,
          usage: {
            inputTokens: data.usage?.prompt_tokens ?? 0,
            outputTokens: data.usage?.completion_tokens ?? 0,
          },
        };
      } catch (error) {
        if (error instanceof AiDlcError) throw error;
        const status = (error as { status?: number })?.status;
        const timedOut =
          error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
        const retryable = timedOut || (status !== undefined && RETRYABLE.has(status));

        if (!retryable || attempt >= this.maxRetries) {
          const reason = timedOut ? "timed out" : status ? `failed with HTTP ${status}` : "failed";
          throw new AiDlcError(
            "E_MODEL",
            `GitHub Models connection ${reason}. Try again later or switch to Gemini.`,
            { cause: error },
          );
        }
        await delay(1000 * 2 ** attempt + Math.floor(Math.random() * 250));
      }
    }
  }
}
