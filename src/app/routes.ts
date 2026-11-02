import { z } from "zod";
import { isAiDlcError } from "../core/errors.js";
import { RolesSchema } from "../core/policy.js";
import type { Logger } from "../ports.js";
import type { LocalApp } from "./local-app.js";
import type { LocalAppManager } from "./manager.js";

/** API routes shared by the local Node server and the in-browser engine of the hosted app. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const AttachmentSchema = z.object({
  name: z.string().max(200).optional(),
  mimeType: z.string().max(100),
  dataBase64: z.string().max(15 * 1024 * 1024),
});

const DraftInput = z.object({
  title: z.string().max(200).optional(),
  request: z.string().max(20_000),
  links: z.array(z.string().trim().max(1000)).max(20).optional(),
  figmaUrl: z.string().trim().max(1000).optional(),
  attachments: z.array(AttachmentSchema).max(10).optional(),
  images: z.array(AttachmentSchema).max(10).optional(),
});
const RefineInput = z.object({ clarification: z.string().max(5_000) });
const DecideInput = z.object({
  action: z.enum(["approve", "ready", "accept"]),
  lane: z.enum(["fast", "standard", "strict"]).optional(),
  runId: z.number().int().positive().optional(),
});
export const SettingsInput = z.object({
  githubToken: z.string().optional(),
  repo: z.string().optional(),
  recentRepos: z.array(z.string()).optional(),
  geminiApiKey: z.string().optional(),
  geminiModel: z.string().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsInput>;
const TestGithubInput = z.object({ token: z.string().optional() });
const TestGeminiInput = z.object({
  apiKey: z.string().optional(),
  model: z.string().optional(),
});
const UpdateIssueInput = z.object({
  title: z.string().min(1).max(256).optional(),
  body: z.string().max(65536).optional(),
  comment: z.string().max(10000).optional(),
});
const RefineIssueInput = z.object({ instruction: z.string().min(1).max(5000) });
const UpdateRolesInput = z.object({ roles: RolesSchema });
const ResolveUserInput = z.object({ username: z.string().min(1).max(100) });

export interface RouteDeps {
  getManagerFor(tenant: string | null): Promise<LocalAppManager>;
  getAppFor(tenant: string | null): Promise<LocalApp>;
  /** Answer for `/api/session` when no manager is available. */
  fallbackSession?(tenant: string | null): Promise<unknown>;
  /** Called before a settings patch reaches the manager, e.g. to persist it in the browser. */
  onSettings?(tenant: string | null, patch: SettingsPatch): void;
  /** Replaces the default disconnect, e.g. to forget a browser-held token. */
  onDisconnect?(tenant: string | null): Promise<unknown>;
  oauthEnabled(): boolean;
  /** Write routes need the caller's own GitHub sign-in (hosted app). */
  requireSignIn?: boolean;
}

export interface Route {
  method: string;
  pattern: RegExp;
  signedIn?: boolean;
  handle: (
    match: RegExpExecArray,
    body: unknown,
    tenant: string | null,
    url: URL,
  ) => Promise<unknown>;
}

export function createRoutes(deps: RouteDeps): Route[] {
  const { getManagerFor, getAppFor } = deps;
  return [
    {
      method: "GET",
      pattern: /^\/api\/session$/u,
      handle: async (_m, _b, tenant) => {
        const mgr = await getManagerFor(tenant).catch(() => null);
        if (mgr) return mgr.session();
        return deps.fallbackSession
          ? deps.fallbackSession(tenant)
          : { status: "needs_setup", tenant };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/repos$/u,
      handle: async (_m, _b, tenant, url) => {
        const force = url.searchParams.get("refresh") === "true";
        const mgr = await getManagerFor(tenant).catch(() => null);
        return { repos: mgr ? await mgr.listUserRepos(force) : [] };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/settings$/u,
      handle: async (_m, _b, tenant) => (await getManagerFor(tenant)).getSettings(),
    },
    {
      method: "POST",
      pattern: /^\/api\/settings$/u,
      handle: async (_m, body, tenant) => {
        const input = SettingsInput.parse(body);
        deps.onSettings?.(tenant, input);
        return (await getManagerFor(tenant)).updateSettings(input);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/settings\/test-github$/u,
      handle: async (_m, body, tenant) => {
        const input = TestGithubInput.parse(body ?? {});
        return (await getManagerFor(tenant)).testGithub(input.token);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/auth\/gh-cli$/u,
      handle: async (_m, _b, tenant) => (await getManagerFor(tenant)).connectFromGhCli(),
    },
    {
      method: "POST",
      pattern: /^\/api\/auth\/disconnect$/u,
      handle: async (_m, _b, tenant) =>
        deps.onDisconnect
          ? deps.onDisconnect(tenant)
          : (await getManagerFor(tenant)).disconnectGithub(),
    },
    {
      method: "POST",
      pattern: /^\/api\/settings\/test-gemini$/u,
      handle: async (_m, body, tenant) => {
        const input = TestGeminiInput.parse(body ?? {});
        return (await getManagerFor(tenant)).testGemini(input.apiKey, input.model);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/repo\/init$/u,
      signedIn: true,
      handle: async (_m, _b, tenant) => (await getManagerFor(tenant)).initRepo(),
    },
    {
      method: "GET",
      pattern: /^\/api\/policy\/roles$/u,
      handle: async (_m, _b, tenant) => {
        const mgr = await getManagerFor(tenant).catch(() => null);
        if (!mgr) return { roles: null, canEdit: false };
        return { roles: mgr.getPolicyRoles(), canEdit: mgr.canEditRoles() };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/policy\/roles$/u,
      signedIn: true,
      handle: async (_m, body, tenant) =>
        (await getManagerFor(tenant)).updatePolicyRoles(UpdateRolesInput.parse(body).roles),
    },
    {
      method: "POST",
      pattern: /^\/api\/users\/resolve$/u,
      handle: async (_m, body, tenant) =>
        (await getManagerFor(tenant)).resolveUser(ResolveUserInput.parse(body).username),
    },
    {
      method: "POST",
      pattern: /^\/api\/plans$/u,
      signedIn: true,
      handle: async (_m, body, tenant) => {
        const input = DraftInput.parse(body);
        return (await getAppFor(tenant)).draftPlan({
          request: input.request,
          ...(input.title ? { title: input.title } : {}),
          ...(input.links ? { links: input.links } : {}),
          ...(input.figmaUrl ? { figmaUrl: input.figmaUrl } : {}),
          ...(input.attachments && input.attachments.length > 0
            ? { attachments: input.attachments }
            : {}),
          ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
        });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/plans\/([\w-]{1,64})\/refine$/u,
      signedIn: true,
      handle: async (m, body, tenant) =>
        (await getAppFor(tenant)).refinePlan(m[1] as string, RefineInput.parse(body).clarification),
    },
    {
      method: "POST",
      pattern: /^\/api\/plans\/([\w-]{1,64})\/accept-suggestions$/u,
      signedIn: true,
      handle: async (m, _b, tenant) => (await getAppFor(tenant)).acceptSuggestions(m[1] as string),
    },
    {
      method: "POST",
      pattern: /^\/api\/plans\/([\w-]{1,64})\/create$/u,
      signedIn: true,
      handle: async (m, _b, tenant) => (await getAppFor(tenant)).createPlan(m[1] as string),
    },
    {
      method: "GET",
      pattern: /^\/api\/items$/u,
      handle: async (_m, _b, tenant, url) => {
        const refresh = url.searchParams.get("refresh");
        return (await getAppFor(tenant)).listItems(refresh === "true" || refresh === "1");
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/builds$/u,
      handle: async (_m, _b, tenant) => (await getAppFor(tenant)).builds(),
    },
    {
      method: "POST",
      pattern: /^\/api\/issues\/(\d{1,9})\/decisions$/u,
      signedIn: true,
      handle: async (m, body, tenant) => {
        const input = DecideInput.parse(body);
        return (await getAppFor(tenant)).decide(Number(m[1]), {
          action: input.action,
          ...(input.lane ? { lane: input.lane } : {}),
          ...(input.runId ? { runId: input.runId } : {}),
        });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/issues\/(\d{1,9})\/replies\/(\d{1,15})$/u,
      handle: async (m, _b, tenant) => (await getAppFor(tenant)).reply(Number(m[1]), Number(m[2])),
    },
    {
      method: "GET",
      pattern: /^\/api\/issues\/(\d{1,9})\/context$/u,
      handle: async (m, _b, tenant, url) => ({
        markdown: await (
          await getAppFor(tenant)
        ).context(
          Number(m[1]),
          url.searchParams.get("draft") === "true" || url.searchParams.get("draft") === "1",
        ),
      }),
    },
    {
      method: "GET",
      pattern: /^\/api\/issues\/(\d{1,9})$/u,
      handle: async (m, _b, tenant) => (await getAppFor(tenant)).getIssueDetails(Number(m[1])),
    },
    {
      method: "PATCH",
      pattern: /^\/api\/issues\/(\d{1,9})$/u,
      signedIn: true,
      handle: async (m, body, tenant) =>
        (await getAppFor(tenant)).updateIssueDetails(Number(m[1]), UpdateIssueInput.parse(body)),
    },
    {
      method: "DELETE",
      pattern: /^\/api\/issues\/(\d{1,9})$/u,
      signedIn: true,
      handle: async (m, _b, tenant) => (await getAppFor(tenant)).deleteWork(Number(m[1])),
    },
    {
      method: "POST",
      pattern: /^\/api\/issues\/(\d{1,9})\/ai-refine$/u,
      signedIn: true,
      handle: async (m, body, tenant) =>
        (await getAppFor(tenant)).refineIssueWithAi(
          Number(m[1]),
          RefineIssueInput.parse(body).instruction,
        ),
    },
    {
      method: "GET",
      pattern: /^\/api\/auth\/status$/u,
      handle: async (_m, _b, tenant) => ({ oauthEnabled: deps.oauthEnabled(), tenant }),
    },
  ];
}

/** Finds and runs the route for a request whose transport-level checks already passed. */
export async function dispatch(
  routes: readonly Route[],
  deps: Pick<RouteDeps, "getManagerFor" | "requireSignIn">,
  request: { method: string; url: URL; body: unknown; tenant: string | null },
): Promise<unknown> {
  const route = routes.find(
    (candidate) =>
      candidate.method === request.method && candidate.pattern.test(request.url.pathname),
  );
  if (!route) throw new HttpError(404, "E_NOT_FOUND", "Unknown endpoint.");
  if (deps.requireSignIn && route.signedIn) {
    const mgr = await deps.getManagerFor(request.tenant);
    if (!mgr.isSignedIn)
      throw new HttpError(
        401,
        "E_AUTH",
        "Sign in with your own GitHub account to perform this action.",
      );
  }
  return route.handle(
    route.pattern.exec(request.url.pathname) as RegExpExecArray,
    request.body,
    request.tenant,
    request.url,
  );
}

export function errorResponse(
  error: unknown,
  logger: Logger,
  path: string,
): { status: number; body: { error: { code: string; message: string } } } {
  if (error instanceof HttpError)
    return { status: error.status, body: { error: { code: error.code, message: error.message } } };
  if (error instanceof z.ZodError)
    return { status: 400, body: { error: { code: "E_INPUT", message: z.prettifyError(error) } } };
  if (isAiDlcError(error))
    return { status: 422, body: { error: { code: error.code, message: error.message } } };
  logger.error("request failed", {
    path,
    error: error instanceof Error ? error.message : String(error),
  });
  return {
    status: 500,
    body: { error: { code: "E_INTERNAL", message: "Unexpected error. See the app logs." } },
  };
}
