import { AiDlcError, isAiDlcError } from "../core/errors.js";
import { modelPlanJsonSchema, parseModelPlan, type ModelPlan } from "../core/plan.js";
import type { AttachmentPart, Logger, ModelPort, ModelUsage } from "../ports.js";
import { PLANNER_SYSTEM_INSTRUCTION } from "./prompt.js";

export interface GeneratedPlan {
  plan: ModelPlan;
  usage: ModelUsage;
}

/** Asks the model for a plan, with one repair attempt when the output breaks plan rules. */
export async function generatePlan(
  model: ModelPort,
  logger: Logger,
  prompt: string,
  maxNodes: number,
  attachments?: AttachmentPart[],
  images?: Array<{ mimeType: string; dataBase64: string }>,
): Promise<GeneratedPlan> {
  const schema = modelPlanJsonSchema();
  const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
  let lastError: AiDlcError | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const user =
      lastError === null
        ? prompt
        : `${prompt}\n\nYour previous answer was rejected:\n${lastError.message}\nReturn a corrected plan.`;
    const result = await model.generateJson({
      system: PLANNER_SYSTEM_INSTRUCTION,
      user,
      jsonSchema: schema,
      attachments,
      images,
    });
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    logger.info("model call", { attempt, model: model.modelId, ...result.usage });
    try {
      return { plan: parseModelPlan(result.text, { maxNodes }), usage };
    } catch (error) {
      if (!isAiDlcError(error) || error.code === "E_PLAN_LIMIT") throw error;
      lastError = error;
    }
  }
  throw lastError as AiDlcError;
}
