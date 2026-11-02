export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const CREDENTIAL_KEYS = ["huddle60:githubToken", "huddle60:geminiApiKey"] as const;
export const REMEMBERED_CREDENTIALS = "huddle60:remembered-credentials";
export const SIGN_OUT_EVENT = "huddle60:sign-out";

export class CredentialStorage implements KeyValueStore {
  constructor(
    private readonly session: KeyValueStore,
    private readonly local: KeyValueStore,
  ) {}

  get remember(): boolean {
    return this.local.getItem(REMEMBERED_CREDENTIALS) !== null;
  }

  private readRemembered(): Record<string, string> {
    const data: unknown = JSON.parse(this.local.getItem(REMEMBERED_CREDENTIALS) ?? "{}");
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error(
        "Stored credentials are invalid. Clear this site's storage and sign in again.",
      );
    const values: Record<string, string> = {};
    for (const key of CREDENTIAL_KEYS) {
      if (key in data) {
        const value: unknown = Reflect.get(data, key);
        if (typeof value !== "string")
          throw new Error(
            "Stored credentials are invalid. Clear this site's storage and sign in again.",
          );
        values[key] = value;
      }
    }
    return values;
  }

  getItem(key: string): string | null {
    return this.remember ? (this.readRemembered()[key] ?? null) : this.session.getItem(key);
  }

  setItem(key: string, value: string): void {
    if (this.getItem(key) === value) return;
    if (this.remember) {
      this.local.setItem(
        REMEMBERED_CREDENTIALS,
        JSON.stringify({ ...this.readRemembered(), [key]: value }),
      );
    } else {
      this.session.setItem(key, value);
    }
  }

  removeItem(key: string): void {
    if (this.remember) {
      const values = this.readRemembered();
      if (key in values) {
        delete values[key];
        this.local.setItem(REMEMBERED_CREDENTIALS, JSON.stringify(values));
      }
    }
    this.session.removeItem(key);
  }

  setRemember(remember: boolean): void {
    if (remember === this.remember) return;
    const values: Record<string, string> = {};
    for (const key of CREDENTIAL_KEYS) {
      const value = this.getItem(key);
      if (value) values[key] = value;
    }
    if (remember) {
      this.local.setItem(REMEMBERED_CREDENTIALS, JSON.stringify(values));
      this.clearSession();
    } else {
      for (const [key, value] of Object.entries(values)) this.session.setItem(key, value);
      this.local.removeItem(REMEMBERED_CREDENTIALS);
    }
  }

  clear(): void {
    this.clearSession();
    this.local.removeItem(REMEMBERED_CREDENTIALS);
    this.local.setItem(SIGN_OUT_EVENT, `${Date.now()}:${Math.random()}`);
  }

  private clearSession(): void {
    for (const key of CREDENTIAL_KEYS) this.session.removeItem(key);
  }

  handleStorageChange(key: string | null): boolean {
    if (key !== null && key !== REMEMBERED_CREDENTIALS && key !== SIGN_OUT_EVENT) return false;
    this.clearSession();
    return true;
  }
}
