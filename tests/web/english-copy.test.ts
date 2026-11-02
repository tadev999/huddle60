import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const vietnamese = /[ĂăĐđĨĩŨũƠơƯưẠ-ỹ]/u;

describe("English web interface", () => {
  it("explains project data storage without claiming that no information is stored anywhere", () => {
    const html = readFileSync(new URL("../../ui/landing.html", import.meta.url), "utf8").replace(
      /\s+/g,
      " ",
    );
    expect(html).toContain("no project data is persisted on huddle60 servers");
    expect(html).toContain("credentials, and preferences stay in your browser");
    expect(html).toContain("your configured AI provider");
    expect(html).not.toContain("your source code is never stored by huddle60");
  });

  it.each(["index.html", "landing.html"])("%s declares English as its language", (file) => {
    const html = readFileSync(new URL(`../../ui/${file}`, import.meta.url), "utf8");
    expect(html).toContain('<html lang="en">');
  });

  it.each(["index.html", "landing.html", "app.js", "theme.js"])(
    "%s contains no hard-coded Vietnamese copy",
    (file) => {
      const source = readFileSync(new URL(`../../ui/${file}`, import.meta.url), "utf8");
      expect(source).not.toMatch(vietnamese);
    },
  );
});
