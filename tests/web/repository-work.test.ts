import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../ui/app.js", import.meta.url), "utf8");
const loadSource = source.slice(
  source.indexOf("async function loadItems("),
  source.indexOf("async function decide("),
);
const switchSource = source.slice(
  source.indexOf("async function switchRepository("),
  source.indexOf("function renderRepoSwitcher("),
);

function harness() {
  const state = {
    session: { status: "ready" },
    repositoryVersion: 0,
    itemsRequest: 0,
    items: [{ number: 1 }],
    itemsStatus: "ready",
    itemsError: "",
    switchingRepository: false,
    pending: new Map([[1, "approve"]]),
    collapsed: new Set(["all:1"]),
    settings: {},
    query: "old query",
  };
  const api = vi.fn();
  const renderItems = vi.fn();
  const button = { disabled: false, value: "" };
  const syncSession = vi.fn();
  const logError = vi.fn();
  const context = {
    state,
    api,
    renderItems,
    syncSession,
    logError,
    $: () => button,
    focusTargetTask: vi.fn(),
    switchView: vi.fn(),
    log: vi.fn(),
  };
  const actions = runInNewContext(
    `${loadSource}\n${switchSource}\n({loadItems, switchRepository})`,
    context,
  ) as { loadItems: () => Promise<void>; switchRepository: (repo: string) => Promise<void> };
  return { ...context, ...actions, button };
}

describe("Work repository transitions", () => {
  it("clears previous work and shows the new repository's issues", async () => {
    const app = harness();
    app.api.mockResolvedValue([{ number: 2 }]);
    await app.loadItems();
    expect(app.state.items).toEqual([{ number: 2 }]);
    expect(app.state.itemsStatus).toBe("ready");
  });

  it("clears old issues and surfaces failures instead of keeping stale work", async () => {
    const app = harness();
    app.api.mockRejectedValue(new Error("Rate limit exceeded"));
    await app.loadItems();
    expect(app.state.items).toEqual([]);
    expect(app.state.itemsStatus).toBe("error");
    expect(app.state.itemsError).toBe("Rate limit exceeded");
    expect(app.logError).toHaveBeenCalled();
    expect(app.button.disabled).toBe(false);
  });

  it("ignores an old repository's response after switching", async () => {
    const app = harness();
    let finish!: (items: { number: number }[]) => void;
    app.api.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const pending = app.loadItems();
    app.state.repositoryVersion++;
    app.state.items = [{ number: 99 }];
    finish([{ number: 1 }]);
    await pending;
    expect(app.state.items).toEqual([{ number: 99 }]);
  });

  it("does not let an older refresh overwrite a newer response", async () => {
    const app = harness();
    let finish!: (items: { number: number }[]) => void;
    app.api.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    app.api.mockResolvedValueOnce([{ number: 2 }]);
    const first = app.loadItems();
    await app.loadItems();
    finish([{ number: 1 }]);
    await first;
    expect(app.state.items).toEqual([{ number: 2 }]);
  });

  it("resets repository-scoped work, prevents overlapping switches, and loads only once", async () => {
    const app = harness();
    let finish!: () => void;
    app.api.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const pending = app.switchRepository("owner/new");
    expect(app.state.items).toEqual([]);
    expect(app.state.pending.size).toBe(0);
    expect(app.state.collapsed.size).toBe(0);
    expect(app.state.query).toBe("");
    expect(app.button.disabled).toBe(true);
    await app.switchRepository("owner/other");
    expect(app.api).toHaveBeenCalledTimes(1);
    finish();
    await pending;
    expect(app.syncSession).toHaveBeenCalledTimes(1);
    expect(app.state.switchingRepository).toBe(false);
  });
});
