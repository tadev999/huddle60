import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AiDlcError } from "./errors.js";

export const MemberSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
});
export type PolicyMember = z.infer<typeof MemberSchema>;

export const RolesSchema = z.object({
  po: z.array(MemberSchema).min(1),
  dev: z.array(MemberSchema).default([]),
  maintainer: z.array(MemberSchema).default([]),
});
export type PolicyRoles = z.infer<typeof RolesSchema>;

const Lane = z.object({
  requires_po_approval: z.boolean(),
});

export const PolicySchema = z
  .object({
    version: z.literal(1),
    roles: RolesSchema,
    project: z
      .object({
        owner: z.string().min(1),
        number: z.number().int().positive(),
      })
      .optional(),
    lanes: z
      .object({
        fast: Lane,
        standard: Lane,
        strict: Lane,
      })
      .default({
        fast: { requires_po_approval: false },
        standard: { requires_po_approval: true },
        strict: { requires_po_approval: true },
      }),
    sensitive_paths: z.array(z.string().min(1)).default([]),
    evidence: z
      .object({ branch: z.string().min(1).default("huddle60-evidence") })
      .default({ branch: "huddle60-evidence" }),
    acceptance: z
      .object({ build_workflows: z.array(z.string().min(1)).min(1) })
      .default({ build_workflows: [".github/workflows/build.yml"] }),
    planner: z
      .object({
        max_nodes: z.number().int().min(1).max(200).default(60),
        plan_ttl_days: z.number().int().min(1).max(90).default(30),
      })
      .default({ max_nodes: 60, plan_ttl_days: 30 }),
  })
  .superRefine((policy, ctx) => {
    const bots = [...policy.roles.po, ...policy.roles.dev, ...policy.roles.maintainer].filter(
      (member) => member.login.endsWith("[bot]"),
    );
    for (const bot of bots) {
      ctx.addIssue({ code: "custom", message: `Bot account ${bot.login} cannot hold a role` });
    }
  });

export type Policy = z.infer<typeof PolicySchema>;
export type Role = "po" | "dev" | "maintainer";
export type LaneName = keyof Policy["lanes"];

export const POLICY_PATH = ".github/huddle60/policy.yml";
export const LEGACY_POLICY_PATH = ".github/ai-dlc/policy.yml";

export function parsePolicy(source: string): Policy {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    throw new AiDlcError("E_POLICY_INVALID", "Policy file is not valid YAML.", { cause: error });
  }
  const result = PolicySchema.safeParse(raw);
  if (!result.success) {
    throw new AiDlcError(
      "E_POLICY_INVALID",
      `Policy file is invalid:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

export function hasRole(policy: Policy, userId: number, role: Role): boolean {
  return policy.roles[role].some((member) => member.id === userId);
}

export function rolesOf(policy: Policy, userId: number): Role[] {
  return (["po", "dev", "maintainer"] as const).filter((role) => hasRole(policy, userId, role));
}

/** Minimal glob matcher supporting `*`, `**` and literal segments. */
export function matchesPath(pattern: string, path: string): boolean {
  let regex = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        regex += ".*";
        index += 1;
        if (pattern[index + 1] === "/") index += 1;
      } else {
        regex += "[^/]*";
      }
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return new RegExp(`^${regex}$`, "u").test(path);
}

export function isSensitive(policy: Policy, path: string): boolean {
  return policy.sensitive_paths.some((pattern) => matchesPath(pattern, path));
}
