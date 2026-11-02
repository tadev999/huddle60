import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../ui/theme.js", import.meta.url), "utf8");

function setup(saved: string | null = null, dark = false, blocked = false) {
  const values = new Map(saved ? [["huddle60:theme", saved]] : []);
  const listeners = new Map<string, (event?: unknown) => void>();
  const select = {
    value: "",
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
  };
  const status = { textContent: "" };
  const root = { dataset: { theme: "" } };
  const system = {
    matches: dark,
    addEventListener: (_name: string, fn: () => void) => listeners.set("system", fn),
  };
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (blocked) throw new Error("Storage blocked");
      values.set(key, value);
    },
  };
  const warn = vi.fn();
  runInNewContext(source, {
    localStorage: storage,
    console: { warn },
    window: {
      matchMedia: () => system,
      addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    },
    document: {
      documentElement: root,
      getElementById: (id: string) => (id === "theme-select" ? select : status),
      addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    },
  });
  const initialTheme = root.dataset.theme;
  listeners.get("DOMContentLoaded")?.();
  return { values, listeners, select, status, root, system, storage, warn, initialTheme };
}

describe("shared landing and app theme", () => {
  it("uses the system preference before DOMContentLoaded, defaulting to light", () => {
    expect(setup().initialTheme).toBe("light");
    expect(setup(null, true).initialTheme).toBe("dark");
    expect(setup("invalid").initialTheme).toBe("light");
  });

  it("restores the explicit choice before rendering and ignores system changes", () => {
    const state = setup("light", true);
    expect(state.initialTheme).toBe("light");
    expect(state.select.value).toBe("light");
    state.listeners.get("system")?.();
    expect(state.root.dataset.theme).toBe("light");
  });

  it("persists choices and follows system changes when set back to system", () => {
    const state = setup();
    state.listeners.get("change")?.({ target: { value: "dark" } });
    expect(state.values.get("huddle60:theme")).toBe("dark");
    expect(state.root.dataset.theme).toBe("dark");
    state.listeners.get("change")?.({ target: { value: "system" } });
    state.system.matches = true;
    state.listeners.get("system")?.();
    expect(state.root.dataset.theme).toBe("dark");
    state.system.matches = false;
    state.listeners.get("system")?.();
    expect(state.root.dataset.theme).toBe("light");
  });

  it("synchronizes tabs without reacting to unrelated preferences", () => {
    const state = setup();
    state.listeners.get("storage")?.({
      storageArea: state.storage,
      key: "huddle60:theme",
      newValue: "dark",
    });
    expect(state.root.dataset.theme).toBe("dark");
    expect(state.select.value).toBe("dark");
    state.listeners.get("storage")?.({
      storageArea: state.storage,
      key: "other",
      newValue: "light",
    });
    expect(state.root.dataset.theme).toBe("dark");
    state.listeners.get("storage")?.({ storageArea: state.storage, key: null, newValue: null });
    expect(state.root.dataset.theme).toBe("light");
  });

  it("keeps the UI usable and reports a persistence failure", () => {
    const state = setup(null, false, true);
    state.listeners.get("change")?.({ target: { value: "dark" } });
    expect(state.root.dataset.theme).toBe("dark");
    expect(state.status.textContent).toContain("Unable to save the theme");
    expect(state.warn).toHaveBeenCalledOnce();
  });
});
