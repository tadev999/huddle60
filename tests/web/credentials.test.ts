import { describe, expect, it } from "vitest";
import {
  CredentialStorage,
  CREDENTIAL_KEYS,
  REMEMBERED_CREDENTIALS,
  SIGN_OUT_EVENT,
  type KeyValueStore,
} from "../../src/web/credentials.js";

class MapStore implements KeyValueStore {
  readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

const [TOKEN, GEMINI] = CREDENTIAL_KEYS;

describe("credential storage", () => {
  it("defaults to tab-only credentials and survives a reload, not a fresh tab", () => {
    const session = new MapStore();
    const local = new MapStore();
    const credentials = new CredentialStorage(session, local);
    credentials.setItem(TOKEN, "gho_me");
    credentials.setItem(GEMINI, "AIza_me");
    expect(local.map.size).toBe(0);
    expect(new CredentialStorage(session, local).getItem(TOKEN)).toBe("gho_me");
    expect(new CredentialStorage(new MapStore(), local).getItem(TOKEN)).toBeNull();
  });

  it("migrates existing credentials when enabled and restores both in a new tab", () => {
    const session = new MapStore();
    const local = new MapStore();
    const first = new CredentialStorage(session, local);
    first.setItem(TOKEN, "gho_me");
    first.setItem(GEMINI, "AIza_me");
    first.setRemember(true);
    expect(session.map.size).toBe(0);
    const next = new CredentialStorage(new MapStore(), local);
    expect(next.remember).toBe(true);
    expect(next.getItem(TOKEN)).toBe("gho_me");
    expect(next.getItem(GEMINI)).toBe("AIza_me");
    next.setItem(TOKEN, "gho_other");
    expect(first.getItem(TOKEN)).toBe("gho_other");
  });

  it("remembers the choice before OAuth redirects and before any key is entered", () => {
    const local = new MapStore();
    new CredentialStorage(new MapStore(), local).setRemember(true);
    const callback = new CredentialStorage(new MapStore(), local);
    callback.setItem(TOKEN, "gho_callback");
    expect(new CredentialStorage(new MapStore(), local).getItem(TOKEN)).toBe("gho_callback");
  });

  it("disabling remember removes persistent secrets but preserves the current tab", () => {
    const local = new MapStore();
    const first = new CredentialStorage(new MapStore(), local);
    first.setRemember(true);
    first.setItem(TOKEN, "gho_me");
    first.setItem(GEMINI, "AIza_me");
    first.setRemember(false);
    expect(local.getItem(REMEMBERED_CREDENTIALS)).toBeNull();
    expect(first.getItem(TOKEN)).toBe("gho_me");
    expect(first.getItem(GEMINI)).toBe("AIza_me");
    expect(new CredentialStorage(new MapStore(), local).getItem(TOKEN)).toBeNull();
  });

  it("sign-out clears both stores and invalidates stale session credentials in other tabs", () => {
    const local = new MapStore();
    const first = new CredentialStorage(new MapStore(), local);
    const other = new CredentialStorage(new MapStore(), local);
    other.setItem(TOKEN, "stale-token");
    other.setItem(GEMINI, "stale-key");
    first.setRemember(true);
    first.setItem(TOKEN, "gho_me");
    first.setItem(GEMINI, "AIza_me");
    first.clear();
    expect(first.remember).toBe(false);
    expect(first.getItem(TOKEN)).toBeNull();
    expect(local.getItem(SIGN_OUT_EVENT)).not.toBeNull();
    expect(other.handleStorageChange(SIGN_OUT_EVENT)).toBe(true);
    expect(other.getItem(TOKEN)).toBeNull();
    expect(other.getItem(GEMINI)).toBeNull();
  });

  it("ignores preference changes but clears stale credentials on account change or storage clear", () => {
    const credentials = new CredentialStorage(new MapStore(), new MapStore());
    credentials.setItem(TOKEN, "old");
    expect(credentials.handleStorageChange("huddle60:repo")).toBe(false);
    expect(credentials.getItem(TOKEN)).toBe("old");
    expect(credentials.handleStorageChange(REMEMBERED_CREDENTIALS)).toBe(true);
    expect(credentials.getItem(TOKEN)).toBeNull();
    credentials.setItem(TOKEN, "old");
    expect(credentials.handleStorageChange(null)).toBe(true);
    expect(credentials.getItem(TOKEN)).toBeNull();
  });

  it("does not share credentials between origins", () => {
    const first = new CredentialStorage(new MapStore(), new MapStore());
    first.setRemember(true);
    first.setItem(TOKEN, "gho_me");
    const differentOrigin = new CredentialStorage(new MapStore(), new MapStore());
    expect(differentOrigin.remember).toBe(false);
    expect(differentOrigin.getItem(TOKEN)).toBeNull();
  });

  it("reports blocked writes and invalid persisted credentials", () => {
    const local = new MapStore();
    const credentials = new CredentialStorage(new MapStore(), local);
    credentials.setItem(TOKEN, "gho_me");
    local.setItem = () => {
      throw new Error("Storage blocked");
    };
    expect(() => credentials.setRemember(true)).toThrow("Storage blocked");
    expect(credentials.getItem(TOKEN)).toBe("gho_me");
    local.map.set(REMEMBERED_CREDENTIALS, '{"huddle60:githubToken":42}');
    expect(() => credentials.getItem(TOKEN)).toThrow("Stored credentials are invalid");
  });
});
