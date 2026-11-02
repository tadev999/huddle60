import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { utf8ToBase64, base64ToUtf8 } from "../../src/core/encoding.js";
import { sha256Hex } from "../../src/core/sha256.js";

describe("portable SHA-256", () => {
  it("matches the FIPS 180-4 test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("matches node:crypto for every length around block boundaries and for Unicode", () => {
    for (let length = 0; length <= 300; length += 1) {
      const bytes = randomBytes(length);
      expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    const text = "Người dùng đăng nhập bằng Google 🔐\r\n— AC-01";
    expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });
});

describe("portable base64", () => {
  it("round-trips UTF-8 and matches Buffer", () => {
    const text = "Tiếng Việt 🚀 ".repeat(5000);
    const encoded = utf8ToBase64(text);
    expect(encoded).toBe(Buffer.from(text, "utf8").toString("base64"));
    expect(base64ToUtf8(`${encoded.slice(0, 60)}\n${encoded.slice(60)}`)).toBe(text);
  });
});
