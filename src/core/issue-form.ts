import { AiDlcError } from "./errors.js";

const NO_RESPONSE = "_No response_";

/** Parses the `### Label` sections that GitHub renders for Issue forms. */
export function parseIssueForm(body: string | null | undefined): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = (body ?? "").replace(/\r\n?/gu, "\n").split("\n");
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current === null) return;
    const value = buffer.join("\n").trim();
    sections.set(current, value === NO_RESPONSE ? "" : value);
  };
  for (const line of lines) {
    const heading = /^###\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      flush();
      current = heading[1] as string;
      buffer = [];
    } else if (current !== null) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

export function requireSection(sections: Map<string, string>, label: string): string {
  const value = sections.get(label);
  if (value === undefined || value.length === 0) {
    throw new AiDlcError("E_FORM", `Required section \`### ${label}\` is missing or empty.`);
  }
  return value;
}

export interface Criterion {
  id: string;
  text: string;
}

const CRITERION_LINE = /^-\s+((?:AC|EC)-\d{2,3}):\s+(.+)$/u;

/** Extracts AC/EC lines. Non-empty lines that look like bullets but are malformed are rejected. */
export function parseCriteria(text: string): Criterion[] {
  const criteria: Criterion[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const match = CRITERION_LINE.exec(line);
    if (!match) {
      if (/^-\s+(AC|EC)/u.test(line)) {
        throw new AiDlcError(
          "E_FORM",
          `Malformed criterion line: \`${line}\`. Use \`- AC-01: ...\`.`,
        );
      }
      continue;
    }
    const id = match[1] as string;
    if (seen.has(id)) throw new AiDlcError("E_FORM", `Duplicate criterion id \`${id}\`.`);
    seen.add(id);
    criteria.push({ id, text: (match[2] as string).trim() });
  }
  return criteria;
}

/** Parses `#12, #13` style references; only same-repository references are supported. */
export function parseIssueRefs(text: string | undefined): number[] {
  if (!text) return [];
  const refs = new Set<number>();
  for (const part of text.split(/[\s,]+/u)) {
    if (part.length === 0) continue;
    const match = /^#(\d+)$/u.exec(part);
    if (!match) {
      throw new AiDlcError("E_FORM", `Invalid issue reference \`${part}\`. Use \`#123\`.`);
    }
    refs.add(Number(match[1]));
  }
  return [...refs].sort((a, b) => a - b);
}
