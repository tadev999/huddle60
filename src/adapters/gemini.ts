import { setTimeout as delay } from "node:timers/promises";
import { ApiError, GoogleGenAI } from "@google/genai";
import { AiDlcError } from "../core/errors.js";
import type { AttachmentPart, ModelPort, ModelUsage } from "../ports.js";

export interface GeminiOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export class GeminiModel implements ModelPort {
  private readonly client: GoogleGenAI;

  constructor(private readonly options: GeminiOptions) {
    this.client = new GoogleGenAI({ apiKey: options.apiKey });
  }

  get modelId(): string {
    return this.options.model;
  }

  async generateJson(input: {
    system: string;
    user: string;
    jsonSchema: Record<string, unknown>;
    images?: Array<{ mimeType: string; dataBase64: string }>;
    attachments?: AttachmentPart[];
  }): Promise<{ text: string; usage: ModelUsage }> {
    const rawAttachments: AttachmentPart[] = [
      ...(input.attachments ?? []),
      ...(input.images ?? []).map((img) => ({
        mimeType: img.mimeType,
        dataBase64: img.dataBase64,
      })),
    ];

    for (let attempt = 0; ; attempt += 1) {
      try {
        let contents: unknown = input.user;
        if (rawAttachments.length > 0) {
          const parts: Array<Record<string, unknown>> = [{ text: input.user }];
          for (const att of rawAttachments) {
            const isText =
              att.mimeType.startsWith("text/") ||
              att.mimeType === "application/json" ||
              att.mimeType.includes("csv");
            if (isText) {
              try {
                const textContent = Buffer.from(att.dataBase64, "base64").toString("utf8");
                parts.push({
                  text: `\n<attached_file name="${att.name || "document"}">\n${textContent}\n</attached_file>`,
                });
                continue;
              } catch {
                // Fallback to inlineData if decode fails
              }
            }
            parts.push({
              inlineData: {
                mimeType: att.mimeType,
                data: att.dataBase64,
              },
            });
          }
          contents = [{ role: "user", parts }];
        }

        const response = await this.client.models.generateContent({
          model: this.options.model,
          contents: contents as any,
          config: {
            systemInstruction: input.system,
            responseMimeType: "application/json",
            responseJsonSchema: input.jsonSchema,
            temperature: 0.2,
            abortSignal: AbortSignal.timeout(this.options.timeoutMs),
          },
        });
        const text = response.text;
        if (!text) throw new AiDlcError("E_GEMINI", "Gemini returned an empty response.");
        return {
          text,
          usage: {
            inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
            outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
          },
        };
      } catch (error) {
        if (error instanceof AiDlcError) throw error;
        const status = error instanceof ApiError ? error.status : undefined;
        const timedOut =
          error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
        const retryable = timedOut || (status !== undefined && RETRYABLE.has(status));
        if (!retryable || attempt >= this.options.maxRetries) {
          const reason = timedOut ? "timed out" : status ? `failed with HTTP ${status}` : "failed";
          throw new AiDlcError("E_GEMINI", `Gemini request ${reason}. Try again later.`, {
            cause: error,
          });
        }
        await delay(1000 * 2 ** attempt + Math.floor(Math.random() * 250));
      }
    }
  }
}
