import { describe, expect, it } from "vitest";
import { commandHandler, looksLikeCommand, parseCommand } from "../../src/core/command.js";
import { AiDlcError } from "../../src/core/errors.js";

function expectSyntaxError(body: string, message: RegExp) {
  let caught: unknown;
  try {
    parseCommand(body);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AiDlcError);
  expect((caught as AiDlcError).code).toBe("E_SYNTAX");
  expect((caught as AiDlcError).message).toMatch(message);
}

describe("parseCommand", () => {
  it("parses arguments and the free-form note", () => {
    const command = parseCommand(
      "/huddle60 refine plan=plan-1-r1-abcd\r\nDùng Google login\nKhông cần đăng ký",
    );
    expect(command).toEqual({
      name: "refine",
      args: { plan: "plan-1-r1-abcd" },
      note: "Dùng Google login\nKhông cần đăng ký",
    });
    const legacy = parseCommand("/ai-dlc baseline");
    expect(legacy.name).toBe("baseline");
  });

  it("supports quoted values with spaces and escapes", () => {
    const command = parseCommand('/huddle60 revoke decision=dec-1 reason="sai baseline \\"cũ\\""');
    expect(command.args).toEqual({ decision: "dec-1", reason: 'sai baseline "cũ"' });
  });

  it("only accepts the command on the first line", () => {
    expectSyntaxError("Xin chào\n/huddle60 baseline", /first line/u);
    expectSyntaxError("> /huddle60 baseline", /first line/u);
    expectSyntaxError("```\n/huddle60 baseline\n```", /first line/u);
    expect(looksLikeCommand("> /huddle60 baseline")).toBe(false);
    expect(looksLikeCommand("/huddle60 baseline")).toBe(true);
    expect(looksLikeCommand("/huddle60x baseline")).toBe(false);
    expect(looksLikeCommand("/ai-dlc baseline")).toBe(true);
  });

  it("rejects unknown commands, unknown, duplicate, empty and missing arguments", () => {
    expectSyntaxError("/huddle60 deploy", /Unknown command/u);
    expectSyntaxError("/huddle60 approve baseline=bl-1 hash=x extra=1", /Unknown argument/u);
    expectSyntaxError("/huddle60 approve baseline=a baseline=b hash=x", /Duplicate/u);
    expectSyntaxError('/huddle60 approve baseline="" hash=x', /empty/u);
    expectSyntaxError("/huddle60 ready baseline=bl-1 hash=x", /Missing argument\(s\).*lane/u);
    expectSyntaxError("/huddle60 approve bl-1", /Unexpected token/u);
  });

  it("routes planner and deterministic commands to different handlers", () => {
    expect(commandHandler("create-plan")).toBe("planner");
    expect(commandHandler("refine")).toBe("planner");
    expect(commandHandler("approve")).toBe("deterministic");
    expect(commandHandler("baseline")).toBe("deterministic");
  });
});
