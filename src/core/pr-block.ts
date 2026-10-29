import { AiDlcError } from "./errors.js";

export const PR_BLOCK_BEGIN = "<!-- huddle60:begin -->";
export const PR_BLOCK_END = "<!-- huddle60:end -->";
export const LEGACY_PR_BLOCK_BEGIN = "<!-- ai-dlc:begin -->";
export const LEGACY_PR_BLOCK_END = "<!-- ai-dlc:end -->";

export interface PrBlock {
  issueNumber: number;
  baselineId: string;
  hash: string;
  acceptanceCriteria: string[];
}

/** Returns null when the PR has no block; throws when a block exists but is malformed. */
export function parsePrBlock(body: string | null | undefined): PrBlock | null {
  const text = (body ?? "").replace(/\r\n?/gu, "\n");
  let begin = text.indexOf(PR_BLOCK_BEGIN);
  let beginMarker = PR_BLOCK_BEGIN;
  let endMarker = PR_BLOCK_END;

  if (begin === -1) {
    begin = text.indexOf(LEGACY_PR_BLOCK_BEGIN);
    if (begin !== -1) {
      beginMarker = LEGACY_PR_BLOCK_BEGIN;
      endMarker = LEGACY_PR_BLOCK_END;
    }
  }
  if (begin === -1) return null;

  if (text.indexOf(beginMarker, begin + 1) !== -1) {
    throw new AiDlcError("E_PR_BLOCK", "PR body contains more than one huddle60 block.");
  }
  const end = text.indexOf(endMarker, begin);
  if (end === -1) throw new AiDlcError("E_PR_BLOCK", "huddle60 block is not closed.");
  const fields = new Map<string, string>();
  for (const line of text.slice(begin + beginMarker.length, end).split("\n")) {
    const match = /^(?:HUDDLE60|AI-DLC)-([A-Za-z]+):\s*(.*)$/iu.exec(line.trim());
    if (match) fields.set((match[1] as string).toLowerCase(), (match[2] as string).trim());
  }
  const issue = /^#(\d+)$/u.exec(fields.get("issue") ?? "");
  const baselineId = fields.get("baseline") ?? "";
  const hash = fields.get("hash") ?? "";
  if (!issue)
    throw new AiDlcError(
      "E_PR_BLOCK",
      "HUDDLE60-Issue must be `#<number>` in the same repository.",
    );
  if (!/^bl-\d+-[0-9a-f]{12}$/u.test(baselineId))
    throw new AiDlcError("E_PR_BLOCK", "HUDDLE60-Baseline is missing or invalid.");
  if (!/^sha256:[0-9a-f]{64}$/u.test(hash))
    throw new AiDlcError("E_PR_BLOCK", "HUDDLE60-Hash is missing or invalid.");
  const acceptanceCriteria = (fields.get("ac") ?? "")
    .split(/[\s,]+/u)
    .filter((value) => value.length > 0);
  for (const id of acceptanceCriteria) {
    if (!/^AC-\d{2,3}$/u.test(id))
      throw new AiDlcError("E_PR_BLOCK", `Invalid AC id \`${id}\` in HUDDLE60-AC.`);
  }
  return { issueNumber: Number(issue[1]), baselineId, hash, acceptanceCriteria };
}

export function renderPrBlock(block: PrBlock): string {
  return [
    PR_BLOCK_BEGIN,
    `HUDDLE60-Issue: #${block.issueNumber}`,
    `HUDDLE60-Baseline: ${block.baselineId}`,
    `HUDDLE60-Hash: ${block.hash}`,
    `HUDDLE60-AC: ${block.acceptanceCriteria.join(", ")}`,
    PR_BLOCK_END,
  ].join("\n");
}

/** Issue numbers referenced with GitHub closing keywords, which would auto-close Issues on merge. */
export function closingReferences(body: string | null | undefined): number[] {
  const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/giu;
  return [...new Set([...(body ?? "").matchAll(pattern)].map((match) => Number(match[1])))];
}
