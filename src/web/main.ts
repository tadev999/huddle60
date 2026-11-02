import { createBrowserEngine } from "./engine.js";
import { CredentialStorage } from "./credentials.js";

// Shared by the local and hosted UI.
export function startEngine(oauthEnabled: boolean) {
  const credentials = new CredentialStorage(sessionStorage, localStorage);
  const engine = createBrowserEngine({
    secrets: credentials,
    prefs: localStorage,
    oauthEnabled,
  });
  window.addEventListener("storage", (event) => {
    if (event.storageArea !== localStorage || !credentials.handleStorageChange(event.key)) return;
    engine.invalidateCredentials();
    window.dispatchEvent(new Event("huddle60-credentials-changed"));
  });
  return engine;
}
