import { createHash } from "node:crypto";

export const CANONICAL_VERSION = 1;

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Normalizes free text so that cosmetic edits do not change a hash:
 * Unicode NFC, LF line endings, no trailing whitespace, no leading/trailing blank lines.
 */
export function normalizeText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/^\n+/u, "")
    .replace(/\n+$/u, "");
}

function normalizeDeep(value: unknown, path: string): JsonValue {
  if (value === null) return null;
  if (typeof value === "string") return normalizeText(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path}`);
    return value;
  }
  if (Array.isArray(value))
    return value.map((item, index) => normalizeDeep(item, `${path}[${index}]`));
  if (typeof value === "object") {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      result[key] = normalizeDeep(item, `${path}.${key}`);
    }
    return result;
  }
  throw new TypeError(`Unsupported value of type ${typeof value} at ${path}`);
}

/**
 * RFC 8785 (JCS) serialization. Object keys are sorted by UTF-16 code units and
 * primitives use ECMAScript JSON serialization, which is what JCS specifies.
 */
export function canonicalJson(value: unknown): string {
  return serialize(normalizeDeep(value, "$"));
}

function serialize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(value[key] as JsonValue)}`).join(",")}}`;
}

export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** Hash of a payload, ignoring its own `contentHash` field. */
export function contentHash(payload: Record<string, unknown>): string {
  const { contentHash: _ignored, ...rest } = payload;
  return sha256(canonicalJson(rest));
}

export function shortHash(hash: string, length = 12): string {
  return hash.replace(/^sha256:/u, "").slice(0, length);
}
