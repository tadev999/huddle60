import { z } from "zod";

const Bool = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const EnvSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(8080),
    GITHUB_APP_ID: z.string().min(1),
    GITHUB_APP_PRIVATE_KEY: z
      .string()
      .min(1)
      .transform((key) => key.replace(/\\n/gu, "\n")),
    GITHUB_WEBHOOK_SECRET: z.string().min(16, "Use a webhook secret of at least 16 characters"),
    GEMINI_API_KEY: z.string().min(1),
    AI_DLC_MODEL: z.string().min(1).default("gemini-2.5-flash"),
    AI_DLC_PLANNER_ENABLED: Bool.default(true),
    AI_DLC_MAX_REVISIONS: z.coerce.number().int().min(1).max(50).default(10),
    AI_DLC_MODEL_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(120_000),
    AI_DLC_STORE: z.enum(["memory", "firestore"]).default("memory"),
    AI_DLC_QUEUE: z.enum(["inline", "cloud-tasks"]).default("inline"),
    GCP_PROJECT: z.string().optional(),
    GCP_LOCATION: z.string().optional(),
    CLOUD_TASKS_QUEUE: z.string().optional(),
    AI_DLC_WORKER_URL: z.string().url().optional(),
    AI_DLC_TASK_TOKEN: z.string().min(32).optional(),
    K_REVISION: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.AI_DLC_QUEUE === "cloud-tasks") {
      for (const key of [
        "GCP_PROJECT",
        "GCP_LOCATION",
        "CLOUD_TASKS_QUEUE",
        "AI_DLC_WORKER_URL",
        "AI_DLC_TASK_TOKEN",
      ] as const) {
        if (!env[key])
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when AI_DLC_QUEUE=cloud-tasks`,
          });
      }
    }
  });

export type ServerConfig = z.infer<typeof EnvSchema>;

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
