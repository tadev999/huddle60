export const ErrorCodes = [
  "E_POLICY_INVALID",
  "E_SYNTAX",
  "E_ROLE",
  "E_FORM",
  "E_HASH_MISMATCH",
  "E_BASELINE_NOT_FOUND",
  "E_NOT_APPROVED",
  "E_NOT_READY",
  "E_DEPENDENCY_OPEN",
  "E_BUILD_INVALID",
  "E_CONFLICT",
  "E_DECISION_NOT_FOUND",
  "E_GITHUB_API",
  "E_GEMINI",
  "E_PLAN_SCHEMA",
  "E_PLAN_NOT_FOUND",
  "E_PLAN_STALE",
  "E_PLAN_LIMIT",
  "E_PLAN_BLOCKED",
  "E_PLAN_PARTIAL",
  "E_PLANNER_DISABLED",
  "E_NOT_REQUEST",
  "E_PR_BLOCK",
  "E_STALE",
  "E_SENSITIVE_PATH",
  "E_CLOSING_KEYWORD",
  "E_WRONG_KIND",
  "E_CONFIG",
] as const;

export type ErrorCode = (typeof ErrorCodes)[number];

/** An expected, user-facing failure. The message must be safe to post on GitHub. */
export class AiDlcError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AiDlcError";
    this.code = code;
  }
}

export function isAiDlcError(error: unknown): error is AiDlcError {
  return error instanceof AiDlcError;
}
