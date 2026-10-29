import { describe, expect, it } from "vitest";
import { canonicalJson, contentHash, normalizeText, sha256 } from "../../src/core/canonical.js";

describe("canonical JSON", () => {
  it("sorts keys recursively and is independent of insertion order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"x":2,"y":1}]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("drops undefined members and rejects non-finite numbers", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/Non-finite/u);
  });

  it("normalizes cosmetic text differences but keeps meaningful ones", () => {
    expect(normalizeText("\n\nline one  \r\nline two\t\n\n")).toBe("line one\nline two");
    expect(contentHash({ text: "a\r\nb  " })).toBe(contentHash({ text: "a\nb" }));
    expect(contentHash({ text: "a\nb" })).not.toBe(contentHash({ text: "a\nc" }));
  });

  it("normalizes Unicode to NFC so composed and decomposed Vietnamese text hash equally", () => {
    const composed = "Đăng nhập";
    const decomposed = composed.normalize("NFD");
    expect(composed).not.toBe(decomposed);
    expect(contentHash({ title: composed })).toBe(contentHash({ title: decomposed }));
  });

  it("ignores the contentHash field itself", () => {
    expect(contentHash({ a: 1, contentHash: "sha256:abc" })).toBe(contentHash({ a: 1 }));
  });

  it("formats hashes as sha256:<hex>", () => {
    expect(sha256("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
