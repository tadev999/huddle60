import { AiDlcError } from "./errors.js";

export const COMMAND_PREFIX = "/ai-dlc";

interface CommandSpec {
  required: readonly string[];
  optional: readonly string[];
  handler: "deterministic" | "planner";
}

export const COMMAND_SPECS = {
  baseline: { required: [], optional: [], handler: "deterministic" },
  approve: { required: ["baseline", "hash"], optional: [], handler: "deterministic" },
  ready: { required: ["baseline", "hash", "lane"], optional: [], handler: "deterministic" },
  accept: { required: ["baseline", "run", "commit"], optional: [], handler: "deterministic" },
  revoke: { required: ["decision", "reason"], optional: [], handler: "deterministic" },
  refine: { required: ["plan"], optional: [], handler: "planner" },
  "create-plan": { required: ["plan", "hash"], optional: [], handler: "planner" },
  "resume-plan": { required: ["plan"], optional: [], handler: "planner" },
} as const satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof COMMAND_SPECS;

export interface ParsedCommand {
  name: CommandName;
  args: Record<string, string>;
  /** Text after the first line; used as free-form clarification for `refine`. */
  note: string;
}

/** Quick check used to route events without fully parsing them. */
export function looksLikeCommand(body: string | null | undefined): boolean {
  return (
    firstLine(body ?? "").startsWith(`${COMMAND_PREFIX} `) ||
    firstLine(body ?? "") === COMMAND_PREFIX
  );
}

export function commandHandler(name: CommandName): "deterministic" | "planner" {
  return COMMAND_SPECS[name].handler;
}

function firstLine(body: string): string {
  return (body.replace(/\r\n?/gu, "\n").split("\n")[0] ?? "").trim();
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /([a-z][a-z-]*)=(?:"((?:[^"\\]|\\.)*)"|(\S+))|(\S+)/gu;
  for (const match of input.matchAll(pattern)) {
    if (match[4] !== undefined) {
      throw new AiDlcError("E_SYNTAX", `Unexpected token \`${match[4]}\`. Use key=value.`);
    }
    const value = match[2] !== undefined ? match[2].replace(/\\(.)/gu, "$1") : (match[3] as string);
    tokens.push(`${match[1]}=${value}`);
  }
  return tokens;
}

/**
 * Parses a command that must be on the first line of a comment.
 * Commands in quotes or code blocks never reach this function because their
 * first line does not start with the prefix.
 */
export function parseCommand(body: string): ParsedCommand {
  const normalized = body.replace(/\r\n?/gu, "\n");
  const [head = "", ...rest] = normalized.split("\n");
  const line = head.trim();
  if (!line.startsWith(COMMAND_PREFIX)) {
    throw new AiDlcError(
      "E_SYNTAX",
      `Commands must start with \`${COMMAND_PREFIX}\` on the first line.`,
    );
  }
  const remainder = line.slice(COMMAND_PREFIX.length).trim();
  const [rawName = "", ...argParts] = remainder.split(/\s+/u);
  if (!(rawName in COMMAND_SPECS)) {
    throw new AiDlcError(
      "E_SYNTAX",
      `Unknown command \`${rawName || "(empty)"}\`. Known commands: ${Object.keys(COMMAND_SPECS).join(", ")}.`,
    );
  }
  const name = rawName as CommandName;
  const spec: CommandSpec = COMMAND_SPECS[name];
  const args: Record<string, string> = {};
  for (const token of tokenize(argParts.join(" "))) {
    const separator = token.indexOf("=");
    const key = token.slice(0, separator);
    const value = token.slice(separator + 1);
    if (!spec.required.includes(key) && !spec.optional.includes(key)) {
      throw new AiDlcError("E_SYNTAX", `Unknown argument \`${key}\` for \`${name}\`.`);
    }
    if (key in args) throw new AiDlcError("E_SYNTAX", `Duplicate argument \`${key}\`.`);
    if (value.length === 0) throw new AiDlcError("E_SYNTAX", `Argument \`${key}\` is empty.`);
    args[key] = value;
  }
  const missing = spec.required.filter((key) => !(key in args));
  if (missing.length > 0) {
    throw new AiDlcError("E_SYNTAX", `Missing argument(s) for \`${name}\`: ${missing.join(", ")}.`);
  }
  return { name, args, note: rest.join("\n").trim() };
}
