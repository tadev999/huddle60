(function () {
  const form = document.getElementById("workspace-form");
  const slugInput = document.getElementById("workspace-slug");
  const suffixLabel = document.getElementById("workspace-domain-label");

  // Detect domain suffix
  const host = window.location.host;
  const protocol = window.location.protocol;
  const isLocal = host.includes("localhost") || host.includes("127.0.0.1");

  if (isLocal) {
    const port = window.location.port ? `:${window.location.port}` : "";
    suffixLabel.textContent = `.localhost${port}`;
  } else {
    // E.g. huddle60.app
    const parts = host.split(".");
    const rootDomain = parts.slice(-2).join(".");
    suffixLabel.textContent = `.${rootDomain}`;
  }

  function resolveToken() {
    const match = /(?:^|&)token=([\w-]+)/.exec(window.location.hash.slice(1));
    if (match) return match[1];
    const stored = sessionStorage.getItem("huddle60_session_token");
    if (stored) return stored;
    const meta = document.querySelector('meta[name="huddle60-session-token"]');
    if (meta && meta.content) return meta.content;
    const cookieMatch = /(?:^|;\s*)huddle60_token=([\w-]+)/.exec(document.cookie);
    if (cookieMatch) return cookieMatch[1];
    return null;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const slug = slugInput.value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "");
    if (!slug) return;

    let targetUrl;
    if (isLocal) {
      const port = window.location.port ? `:${window.location.port}` : "";
      targetUrl = `${protocol}//${slug}.localhost${port}/`;
    } else {
      const parts = host.split(".");
      const rootDomain = parts.slice(-2).join(".");
      targetUrl = `${protocol}//${slug}.${rootDomain}/`;
    }

    const token = resolveToken();
    if (token) {
      targetUrl += `#token=${token}`;
    }

    window.location.href = targetUrl;
  });
})();
