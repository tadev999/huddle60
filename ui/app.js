// huddle60 browser app (AI-DLC). All user/model text is set via textContent.

const POLL_MS = 3000;
const POLL_MAX = 60;

const state = {
  session: null,
  items: [],
  filter: "mine",
  query: "",
  pending: new Map(), // issueNumber -> action
  draft: null,
  collapsed: new Set(),
  userRepos: [],
  loadingRepos: false,
  repositoryVersion: 0,
  itemsRequest: 0,
  itemsStatus: "idle",
  itemsError: "",
  switchingRepository: false,
  rolesDraft: { po: [], dev: [], maintainer: [] },
  canEditRoles: false,
  planAttachments: [],
};

// ---------- utilities ----------

const $ = (selector) => document.querySelector(selector);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function readTenant() {
  const meta = document.querySelector('meta[name="huddle60-tenant"]');
  if (meta?.content) return meta.content;
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts.length >= 1 && !["app", "landing", "index.html"].includes(parts[0])) {
    return parts[0];
  }
  return null;
}

const currentTenant = readTenant();

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let enginePromise = null;

function loadEngine() {
  enginePromise ??= import("/engine.js?v=20261102_9").then((mod) =>
    mod.startEngine(document.querySelector('meta[name="huddle60-oauth"]')?.content === "1"),
  );
  return enginePromise;
}

async function api(path, body, method) {
  const tenantToPass = state.session?.tenant || currentTenant;
  const engine = await loadEngine();
  const result = await engine.call(
    method ?? (body !== undefined ? "POST" : "GET"),
    path,
    body,
    tenantToPass,
  );
  if (result.status >= 400) {
    const error = result.body?.error ?? { code: "E_HTTP", message: `HTTP ${result.status}` };
    throw new ApiError(error.code, error.message);
  }
  return result.body;
}

function issueUrl(number) {
  return `${state.session.repo.url}/issues/${number}`;
}

function hasRole(role) {
  return state.session?.roles.includes(role) ?? false;
}

async function withBusy(button, fn) {
  button.disabled = true;
  button.classList.add("busy");
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.classList.remove("busy");
  }
}

// ---------- activity log ----------

function log(kind, title, detail) {
  const time = new Date().toLocaleTimeString("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const item = h("li", { class: kind }, h("span", { class: "time" }, time), title);
  const extra = h("div");
  item.append(extra);
  const set = (nextKind, nextTitle, nextDetail) => {
    item.className = nextKind;
    item.childNodes[1].textContent = nextTitle;
    extra.replaceChildren();
    if (nextDetail?.code) extra.append(h("code", {}, nextDetail.code));
    if (nextDetail?.text) extra.append(h("pre", {}, nextDetail.text));
  };
  set(kind, title, detail);
  $("#log").prepend(item);
  return set;
}

function logError(title, error) {
  log("fail", title, {
    text: error instanceof ApiError ? `${error.code}: ${error.message}` : String(error),
  });
}

// ---------- dialog ----------

function openDialog({ title, body, okLabel, copyText }) {
  const dialog = $("#dialog");
  $("#dialog-title").textContent = title;
  $("#dialog-body").replaceChildren(body);
  const ok = $("#dialog-ok");
  ok.hidden = !okLabel;
  ok.textContent = okLabel ?? "Confirm";
  const copy = $("#dialog-copy");
  copy.hidden = !copyText;
  copy.textContent = "Copy";
  copy.onclick = async () => {
    await navigator.clipboard.writeText(copyText);
    copy.textContent = "Copied";
  };
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true });
  });
}

// ---------- work items ----------

const STAGE_LABEL = {
  "awaiting-approval": "Awaiting approval",
  "awaiting-ready": "Awaiting developer",
  "in-progress": "In progress",
};

function displayTitle(item) {
  const title = item.title.trim();
  const prefix = /^\[(epic|story|task)\]\s*/i.exec(title);
  return prefix?.[1].toLowerCase() === item.kind
    ? title.slice(prefix[0].length).trim() || title
    : title;
}

function needsMe(item) {
  if (hasRole("po") && item.kind !== "task" && item.stage !== "awaiting-ready") return true;
  if (hasRole("dev") && item.stage === "awaiting-ready") return true;
  return false;
}

function visibleItems() {
  const query = state.query.trim().toLowerCase().replace(/^#/, "");
  return state.items.filter((item) => {
    if (state.filter === "mine" && !needsMe(item)) return false;
    if (!["mine", "all"].includes(state.filter) && item.stage !== state.filter) return false;
    if (!query) return true;
    return String(item.number) === query || displayTitle(item).toLowerCase().includes(query);
  });
}

function treeRows() {
  const byNumber = new Map(state.items.map((item) => [item.number, item]));
  const matched = new Set(visibleItems().map((item) => item.number));
  const included = new Set(matched);
  const searching = state.query.trim().length > 0;
  for (const number of [...included]) {
    let parent = byNumber.get(number)?.parent;
    while (byNumber.has(parent) && !included.has(parent)) {
      included.add(parent);
      parent = byNumber.get(parent).parent;
    }
  }
  const children = new Map();
  for (const item of state.items) {
    if (!included.has(item.number)) continue;
    const siblings = children.get(item.parent) ?? [];
    siblings.push(item);
    children.set(item.parent, siblings);
  }
  const rows = [];
  const visited = new Set();
  const walk = (item, depth, hidden = false) => {
    if (visited.has(item.number)) return;
    visited.add(item.number);
    const descendants = children.get(item.number) ?? [];
    const expanded = searching || !state.collapsed.has(`${state.filter}:${item.number}`);
    if (!hidden)
      rows.push({
        item,
        depth,
        hasChildren: descendants.length > 0,
        expanded,
        contextOnly: !matched.has(item.number),
      });
    for (const child of descendants) walk(child, depth + 1, hidden || !expanded);
  };
  for (const item of state.items) {
    if (included.has(item.number) && !included.has(item.parent)) walk(item, 0);
  }
  // Keep malformed cyclic relationships visible without traversing them forever.
  for (const item of state.items) {
    if (included.has(item.number) && !visited.has(item.number)) walk(item, 0);
  }
  return rows;
}

function readyLanes(item) {
  const lanes = Object.entries(state.session.lanes);
  if (item.kind === "task" || item.stage !== "awaiting-approval")
    return lanes.map(([lane]) => lane);
  return lanes.filter(([, lane]) => !lane.requiresPoApproval).map(([lane]) => lane);
}

function getShareUrl(itemNumber) {
  const session = state.session || {};
  const repo = session.repo;
  const owner = repo?.owner || session.tenant || session.viewer?.login;
  const repoName = repo?.repo;

  const hostname = window.location.hostname;
  const port = window.location.port ? `:${window.location.port}` : "";
  const protocol = window.location.protocol;

  if (owner && repoName) {
    if (hostname.toLowerCase().startsWith(`${owner.toLowerCase()}.`)) {
      return `${protocol}//${window.location.host}/${repoName}#${itemNumber}`;
    }
    if (hostname === "huddle60.app" || hostname.endsWith(".huddle60.app")) {
      return `https://${owner}.huddle60.app/${repoName}#${itemNumber}`;
    }
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return `${protocol}//${owner}.localhost${port}/${repoName}#${itemNumber}`;
    }
    return `${protocol}//${window.location.host}/${owner}/${repoName}#${itemNumber}`;
  }
  return `${window.location.origin}/#${itemNumber}`;
}

async function copyTaskShareLink(button, item) {
  const shareUrl = getShareUrl(item.number);
  try {
    await navigator.clipboard.writeText(shareUrl);
    const original = button.textContent;
    button.textContent = "✓ Copied!";
    button.classList.add("copied");
    log("ok", `Copied link to issue #${item.number}`, { text: shareUrl });
    setTimeout(() => {
      button.textContent = original;
      button.classList.remove("copied");
    }, 2000);
  } catch (_e) {
    prompt("Copy the issue link:", shareUrl);
  }
}

async function promptGuestLogin(actionName) {
  const result = await openDialog({
    title: `Sign in to ${actionName}`,
    body: h(
      "div",
      {},
      h("p", {}, "You are viewing this workspace as a guest (read-only)."),
      h(
        "p",
        {},
        `To ${actionName}, connect a GitHub account with the appropriate role in the repository policy.`,
      ),
    ),
    okLabel: "Open settings",
  });
  if (result === "ok") {
    switchView("settings");
  }
}

function closeActionsDropdowns() {
  document.querySelectorAll("details.actions-dropdown[open]").forEach((d) => (d.open = false));
}

window.addEventListener("click", (e) => {
  if (!e.target.closest("details.actions-dropdown")) {
    closeActionsDropdowns();
  }
});

function actionsFor(item) {
  const controls = [];
  const pending = state.pending.get(item.number);

  if (pending) {
    controls.push(
      h(
        "span",
        { class: "meta", title: "Waiting for GitHub Actions to process the command..." },
        `⏳ ${pending} · Waiting for Actions`,
      ),
    );
  } else {
    // 1. Primary state transition CTAs (Approve / Ready / Accept)
    const hasChildren = state.items.some((other) => other.parent === item.number);
    if (hasRole("dev") && item.stage !== "in-progress" && (item.kind === "task" || !hasChildren)) {
      const lanes = readyLanes(item);
      if (lanes.length > 0) {
        const select = h(
          "select",
          { title: "Delivery lane" },
          lanes.map((lane) => h("option", { value: lane, selected: lane === "standard" }, lane)),
        );
        controls.push(
          select,
          h(
            "button",
            {
              class: "btn",
              title: "Developer confirms readiness",
              onclick: (e) =>
                decide(e.currentTarget, item, { action: "ready", lane: select.value }),
            },
            "Ready",
          ),
        );
      }
    }
    if (hasRole("po") && item.kind !== "task" && item.stage === "awaiting-approval") {
      controls.push(
        h(
          "button",
          {
            class: "btn primary",
            title: "Product Owner approves the current requirements",
            onclick: (e) => decide(e.currentTarget, item, { action: "approve" }),
          },
          "Approve",
        ),
      );
    }
    if (hasRole("po") && item.kind !== "task" && item.stage === "in-progress") {
      controls.push(
        h(
          "button",
          {
            class: "btn primary",
            title: "Product Owner accepts a merged build",
            onclick: (e) => accept(e.currentTarget, item),
          },
          "Accept",
        ),
      );
    }

    // Guidance for Guest users (without role)
    if (!hasRole("dev") && !hasRole("po")) {
      if (item.stage === "awaiting-approval" && item.kind !== "task") {
        controls.push(
          h(
            "button",
            {
              class: "btn ghost",
              title: "Approve requirements (guests: click to sign in)",
              onclick: () => promptGuestLogin("approve requirements"),
            },
            "Approve",
          ),
        );
      } else if (item.stage !== "in-progress") {
        controls.push(
          h(
            "button",
            {
              class: "btn ghost",
              title: "Confirm readiness (guests: click to sign in)",
              onclick: () => promptGuestLogin("confirm readiness"),
            },
            "Ready",
          ),
        );
      }
    }
  }

  // 2. High-frequency Helper CTA: Context (for AI coding agents)
  controls.push(
    h(
      "button",
      {
        class: "btn ghost",
        title: "Copy context for a coding agent (Cursor / Claude Code)",
        onclick: (e) => showContext(e.currentTarget, item),
      },
      "Context",
    ),
  );

  // 3. Overflow Menu "···" (Edit, Share, GitHub, Delete)
  const menuItems = [];

  if (hasRole("dev") || hasRole("po")) {
    menuItems.push(
      h(
        "button",
        {
          class: "actions-menu-item",
          type: "button",
          title: "Edit specification and test criteria with AI",
          onclick: () => {
            closeActionsDropdowns();
            openSpecEditor(item);
          },
        },
        h("span", { class: "menu-icon" }, "✏️"),
        "Edit specification",
      ),
    );
  }

  menuItems.push(
    h(
      "button",
      {
        class: "actions-menu-item btn-share-task",
        type: "button",
        title: "Copy link to share with team",
        onclick: (e) => {
          copyTaskShareLink(e.currentTarget, item);
          setTimeout(closeActionsDropdowns, 400);
        },
      },
      h("span", { class: "menu-icon" }, "🔗"),
      "Share link",
    ),
    h(
      "a",
      {
        class: "actions-menu-item",
        href: item.url,
        target: "_blank",
        rel: "noopener noreferrer",
        title: "View on GitHub",
        onclick: () => closeActionsDropdowns(),
      },
      h("span", { class: "menu-icon" }, "↗"),
      "View on GitHub",
    ),
  );

  if (hasRole("po") || hasRole("maintainer")) {
    menuItems.push(
      h("hr", { class: "actions-menu-divider" }),
      h(
        "button",
        {
          class: "actions-menu-item danger",
          type: "button",
          title: "Delete this work and all child work",
          onclick: async (e) => {
            closeActionsDropdowns();
            await deleteWork(e.currentTarget, item);
          },
        },
        h("span", { class: "menu-icon" }, "🗑"),
        "Delete work",
      ),
    );
  }

  const dropdown = h(
    "details",
    {
      class: "actions-dropdown",
      onkeydown: (e) => {
        if (e.key === "Escape") closeActionsDropdowns();
      },
    },
    h(
      "summary",
      {
        class: "btn ghost btn-icon",
        "aria-label": "More options",
        title: "More options",
      },
      "•••",
    ),
    h("div", { class: "actions-menu" }, ...menuItems),
  );

  controls.push(dropdown);
  return controls;
}

function renderItems() {
  const entries = treeRows();
  const rows = entries.map(
    ({ item, depth = 0, hasChildren = false, expanded = false, contextOnly = false }) => {
      const meta = [];
      if (item.approvedBy) meta.push(h("div", {}, `Approved · ${item.approvedBy}`));
      if (item.ready) meta.push(h("div", {}, `Ready · ${item.ready.by} · ${item.ready.lane}`));
      if (item.changed) meta.push(h("div", { class: "changed" }, "Requirements changed"));
      const link = h(
        "a",
        { href: item.url, target: "_blank", rel: "noopener noreferrer" },
        displayTitle(item),
      );
      const toggle = hasChildren
        ? h(
            "button",
            {
              class: "tree-toggle",
              type: "button",
              "aria-expanded": String(expanded),
              "aria-label": `${expanded ? "Collapse" : "Expand"} #${item.number}`,
              title: `${expanded ? "Collapse" : "Expand"} #${item.number}`,
              onclick: () => {
                const key = `${state.filter}:${item.number}`;
                if (state.collapsed.has(key)) state.collapsed.delete(key);
                else state.collapsed.add(key);
                renderItems();
                document.querySelector(`[data-tree-toggle="${item.number}"]`)?.focus();
              },
              "data-tree-toggle": item.number,
              disabled: state.query.trim().length > 0,
            },
            h("span", { class: "tree-chevron", "aria-hidden": "true" }),
          )
        : h("span", { class: "tree-spacer", "aria-hidden": "true" });
      return h(
        "tr",
        {
          id: `item-${item.number}`,
          class: contextOnly ? "context-row" : "",
          "data-issue": item.number,
          "data-context": String(contextOnly),
        },
        h("td", { class: "num" }, `#${item.number}`),
        h("td", {}, h("span", { class: `badge ${item.kind}` }, item.kind)),
        h(
          "td",
          { class: "title-cell" },
          h(
            "div",
            { class: "item-tree-title" },
            Array.from({ length: depth }, () =>
              h("span", { class: "tree-indent", "aria-hidden": "true" }),
            ),
            toggle,
            link,
          ),
          item.parent && depth === 0 ? h("span", { class: "meta" }, `  ↳ #${item.parent}`) : null,
          item.error && !contextOnly ? h("span", { class: "err" }, item.error) : null,
        ),
        h(
          "td",
          {},
          contextOnly ? null : h("span", { class: `pill ${item.stage}` }, STAGE_LABEL[item.stage]),
        ),
        h("td", { class: "meta" }, contextOnly ? [] : meta),
        h("td", {}, contextOnly ? null : h("div", { class: "actions" }, actionsFor(item))),
      );
    },
  );
  $("#items-body").replaceChildren(...rows);
  const empty = $("#items-empty");
  empty.hidden = rows.length > 0;
  empty.textContent =
    state.itemsStatus === "loading"
      ? "Loading issues..."
      : state.itemsStatus === "error"
        ? `Could not load issues: ${state.itemsError}. Use Refresh to retry.`
        : state.session?.status !== "ready"
          ? state.session?.repo
            ? `Repository unavailable. ${state.session.lastError || "Check the repository setup or connection in Settings."}`
            : "Select a repository to view work."
          : state.items.length === 0
            ? "No open issues yet."
            : "No matching issues.";
  for (const chip of document.querySelectorAll("#filters .chip")) {
    const filter = chip.dataset.filter;
    const count = state.items.filter((item) =>
      filter === "all" ? true : filter === "mine" ? needsMe(item) : item.stage === filter,
    ).length;
    chip.replaceChildren(chip.dataset.label, h("span", { class: "count" }, count));
  }
}

function focusTargetTask() {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash || hash.startsWith("token=")) return;
  const match = /^(\d+)$/.exec(hash) || /^task-(\d+)$/.exec(hash) || /^issue-(\d+)$/.exec(hash);
  const targetNumber = match ? Number(match[1]) : null;
  if (!targetNumber) return;

  const itemExists = state.items.some((i) => i.number === targetNumber);
  if (!itemExists) return;

  const isVisible = visibleItems().some((i) => i.number === targetNumber);
  if (!isVisible) {
    state.filter = "all";
    for (const chip of document.querySelectorAll("#filters .chip")) {
      chip.classList.toggle("active", chip.dataset.filter === "all");
    }
    renderItems();
  }

  const row = document.getElementById(`item-${targetNumber}`);
  if (row) {
    row.classList.add("target-highlight");
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    log("ok", `Opened issue #${targetNumber} from a shared link`);
    setTimeout(() => {
      row.classList.remove("target-highlight");
    }, 4000);
  }
}

async function loadItems(force = false) {
  if (state.switchingRepository || state.session?.status !== "ready") return;
  const version = state.repositoryVersion;
  const request = ++state.itemsRequest;
  const button = $("#refresh");
  button.disabled = true;
  state.items = [];
  state.itemsStatus = "loading";
  renderItems();
  try {
    const url = force ? "/api/items?refresh=1" : "/api/items";
    const items = await api(url);
    if (version !== state.repositoryVersion || request !== state.itemsRequest) return;
    state.items = items;
    state.itemsStatus = "ready";
    renderItems();
    focusTargetTask();
  } catch (error) {
    if (version === state.repositoryVersion && request === state.itemsRequest) {
      state.items = [];
      state.itemsStatus = "error";
      state.itemsError = error.message;
      renderItems();
      logError("Could not load issues", error);
    }
  } finally {
    if (version === state.repositoryVersion && request === state.itemsRequest)
      button.disabled = false;
  }
}

async function decide(button, item, input) {
  const command = await withBusy(button, async () => {
    try {
      return await api(`/api/issues/${item.number}/decisions`, input);
    } catch (error) {
      logError(`#${item.number} ${input.action} failed`, error);
      return null;
    }
  });
  if (!command) return;
  state.pending.set(item.number, input.action);
  renderItems();
  const update = log("pending", `#${item.number} ${input.action} submitted`, {
    code: command.command,
  });
  pollReply(item.number, command.commentId, input.action, update);
}

async function pollReply(issueNumber, commentId, action, update) {
  const version = state.repositoryVersion;
  for (let attempt = 0; attempt < POLL_MAX; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (version !== state.repositoryVersion) return;
    try {
      const reply = await api(`/api/issues/${issueNumber}/replies/${commentId}`);
      if (version !== state.repositoryVersion) return;
      if (reply.status === "done") {
        update(
          reply.ok ? "ok" : "fail",
          `#${issueNumber} ${action}: ${reply.ok ? "recorded" : "rejected"}`,
          { text: reply.body },
        );
        state.pending.delete(issueNumber);
        await loadItems();
        return;
      }
    } catch (error) {
      if (error.code === "E_TOKEN") break;
    }
  }
  state.pending.delete(issueNumber);
  renderItems();
  update("fail", `#${issueNumber} ${action}: no response from GitHub Actions yet`, {
    text: "Check the huddle60 workflow in GitHub Actions, then refresh.",
  });
}

async function accept(button, item) {
  const builds = await withBusy(button, async () => {
    try {
      return await api("/api/builds");
    } catch (error) {
      logError("Could not load builds", error);
      return null;
    }
  });
  if (!builds) return;
  if (builds.length === 0) {
    await openDialog({
      title: `Accept #${item.number}`,
      body: h(
        "p",
        {},
        `No successful builds on ${state.session.defaultBranch}. Merge a PR and wait for the build to finish.`,
      ),
    });
    return;
  }
  const list = h(
    "div",
    {},
    h("p", { class: "muted" }, "Select a default-branch build to accept:"),
    builds.map((build, index) =>
      h(
        "label",
        { class: "build" },
        h("input", { type: "radio", name: "build", value: build.id, checked: index === 0 }),
        `run ${build.id}`,
        h("span", { class: "muted" }, build.headSha.slice(0, 7)),
        h("span", { class: "muted" }, build.path.split("/").pop()),
        h("a", { href: build.url, target: "_blank", rel: "noopener noreferrer" }, "↗"),
      ),
    ),
  );
  if (
    (await openDialog({
      title: `Accept #${item.number} · ${displayTitle(item)}`,
      body: list,
      okLabel: "Accept",
    })) !== "ok"
  )
    return;
  const runId = Number(list.querySelector("input[name=build]:checked")?.value);
  await decide(button, item, { action: "accept", runId });
}

/** Open descendants of an item on the board, cycle-safe. */
function descendantsOf(item) {
  const result = [];
  const visited = new Set([item.number]);
  const queue = [item.number];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const other of state.items) {
      if (other.parent !== current || visited.has(other.number)) continue;
      visited.add(other.number);
      result.push(other);
      queue.push(other.number);
    }
  }
  return result;
}

async function deleteWork(button, item) {
  const descendants = descendantsOf(item);
  const body = h(
    "div",
    {},
    h("p", {}, `Delete #${item.number} · ${displayTitle(item)}?`),
    descendants.length > 0
      ? h(
          "div",
          {},
          h(
            "p",
            { class: "muted" },
            `${descendants.length} child work item${descendants.length === 1 ? "" : "s"} will also be deleted:`,
          ),
          h(
            "ul",
            {},
            descendants.map((child) =>
              h("li", {}, `#${child.number} · ${child.kind} · ${displayTitle(child)}`),
            ),
          ),
        )
      : null,
    h(
      "p",
      { class: "muted" },
      "The Issues are closed as “not planned” on GitHub and can be reopened there.",
    ),
  );
  if ((await openDialog({ title: `Delete #${item.number}`, body, okLabel: "Delete" })) !== "ok")
    return false;
  const result = await withBusy(button, async () => {
    try {
      return await api(`/api/issues/${item.number}`, undefined, "DELETE");
    } catch (error) {
      logError(`#${item.number} delete failed`, error);
      return null;
    }
  });
  if (!result) return false;
  if (result.failed.length > 0) {
    log("fail", `#${item.number} deleted partially`, {
      text: [
        result.deleted.length > 0
          ? `Deleted: ${result.deleted.map((n) => `#${n}`).join(", ")}`
          : "Nothing deleted.",
        ...result.failed.map((f) => `#${f.number}: ${f.error}`),
      ].join("\n"),
    });
  } else {
    log("ok", `Deleted ${result.deleted.map((n) => `#${n}`).join(", ")}`);
  }
  await loadItems(true);
  return result.deleted.includes(item.number);
}

async function showContext(button, item, draft = false) {
  const result = await withBusy(button, async () => {
    try {
      const url = draft
        ? `/api/issues/${item.number}/context?draft=true`
        : `/api/issues/${item.number}/context`;
      return await api(url);
    } catch (error) {
      if (error.code === "E_NOT_READY" && !draft) {
        const viewDraft = await openDialog({
          title: `#${item.number} is not ready yet`,
          body: h(
            "div",
            {},
            h(
              "p",
              {},
              `#${item.number} does not have a confirmed Ready decision from GitHub Actions yet.`,
            ),
            h(
              "p",
              { class: "muted" },
              "Would you like to open the Draft Context for planning and reference?",
            ),
          ),
          okLabel: "View Draft Context",
        });
        if (viewDraft === "ok") {
          return await showContext(button, item, true);
        }
        return null;
      }
      logError(`#${item.number} context`, error);
      return null;
    }
  });
  if (!result) return;
  const isDraft = draft || result.markdown?.startsWith("# DRAFT context");
  await openDialog({
    title: `${isDraft ? "Draft Context" : "Context"} #${item.number} · ${displayTitle(item)}`,
    body: h("pre", {}, result.markdown),
    copyText: result.markdown,
  });
}

// ---------- spec editor ----------

let editingSpecItem = null;

async function openSpecEditor(item) {
  editingSpecItem = item;
  const dialog = $("#spec-dialog");
  $("#spec-kind-badge").className = `badge ${item.kind}`;
  $("#spec-kind-badge").textContent = item.kind;
  $("#spec-issue-num").textContent = `#${item.number}`;
  $("#spec-gh-link").href = item.url;
  $("#spec-alert-stale").hidden = item.stage === "awaiting-approval";

  // Share button inside spec modal
  const shareBtn = $("#spec-share-btn");
  if (shareBtn) {
    shareBtn.onclick = (e) => copyTaskShareLink(e.currentTarget, item);
  }

  // Delete button inside spec modal (Option 3)
  const deleteBtn = $("#spec-btn-delete");
  if (deleteBtn) {
    deleteBtn.hidden = !(hasRole("po") || hasRole("maintainer"));
    deleteBtn.onclick = async (e) => {
      const deleted = await deleteWork(e.currentTarget, item);
      if (deleted) dialog.close();
    };
  }

  $("#spec-input-title").value = "Loading...";
  $("#spec-input-body").value = "Loading from GitHub...";
  $("#spec-input-comment").value = "";
  $("#spec-ai-instruction").value = "";
  $("#spec-ai-feedback").hidden = true;
  $("#spec-save-status").textContent = "";

  dialog.showModal();

  try {
    const details = await api(`/api/issues/${item.number}`);
    $("#spec-input-title").value = details.title;
    $("#spec-input-body").value = details.body;
  } catch (error) {
    logError(`Could not load issue #${item.number}`, error);
    $("#spec-input-body").value = `Load failed: ${error.message}`;
  }
}

async function handleAiRefineSpec() {
  if (!editingSpecItem) return;
  const instruction = $("#spec-ai-instruction").value.trim();
  const feedback = $("#spec-ai-feedback");
  const button = $("#spec-btn-ai-refine");

  if (!instruction) {
    feedback.className = "test-msg err";
    feedback.textContent = "Enter instructions for the AI.";
    feedback.hidden = false;
    return;
  }

  feedback.hidden = true;
  await withBusy(button, async () => {
    try {
      const result = await api(`/api/issues/${editingSpecItem.number}/ai-refine`, { instruction });
      if (result.proposedTitle) {
        $("#spec-input-title").value = result.proposedTitle;
      }
      if (result.proposedBody) {
        $("#spec-input-body").value = result.proposedBody;
      }
      feedback.className = "test-msg ok";
      feedback.textContent = `✨ AI updated the draft: ${result.summary || "Requested changes applied."}`;
      feedback.hidden = false;
    } catch (error) {
      feedback.className = "test-msg err";
      feedback.textContent = `Error: ${error.message}`;
      feedback.hidden = false;
    }
  });
}

async function handleSaveSpecChanges() {
  if (!editingSpecItem) return;
  const button = $("#spec-btn-save");
  const status = $("#spec-save-status");
  const title = $("#spec-input-title").value.trim();
  const body = $("#spec-input-body").value;
  const comment = $("#spec-input-comment").value.trim();

  if (!title) {
    status.className = "status-msg err";
    status.textContent = "A title is required.";
    return;
  }

  status.className = "status-msg";
  status.textContent = "Saving to GitHub...";

  await withBusy(button, async () => {
    try {
      await api(
        `/api/issues/${editingSpecItem.number}`,
        {
          title,
          body,
          ...(comment ? { comment } : {}),
        },
        "PATCH",
      );
      status.className = "status-msg ok";
      status.textContent = "Saved successfully.";
      log("ok", `#${editingSpecItem.number} specification updated on GitHub`);
      $("#spec-dialog").close();
      await loadItems();
    } catch (error) {
      status.className = "status-msg err";
      status.textContent = `Save failed: ${error.message}`;
      logError(`#${editingSpecItem.number} specification update failed`, error);
    }
  });
}

// ---------- plan ----------

function renderNode(node, byParent) {
  const criteria =
    node.kind === "task"
      ? node.acRefs.map((id) => `→ ${id}`)
      : node.criteria.map((c) => `${c.id}: ${c.text}`);
  const created = state.draft?.created?.issues?.[node.localId];
  return h(
    "div",
    { class: "node" },
    h(
      "div",
      { class: "node-head" },
      h("span", { class: `badge ${node.kind}` }, node.kind),
      h("strong", {}, displayTitle(node)),
      h("span", { class: "node-id" }, node.localId),
      node.blockedBy.length
        ? h("span", { class: "node-id" }, `Depends on: ${node.blockedBy.join(", ")}`)
        : null,
      created
        ? h(
            "a",
            { href: issueUrl(created), target: "_blank", rel: "noopener noreferrer" },
            `#${created}`,
          )
        : null,
    ),
    criteria.length
      ? h(
          "ul",
          {},
          criteria.map((text) => h("li", {}, text)),
        )
      : null,
    node.riskNotes.length
      ? h(
          "ul",
          {},
          node.riskNotes.map((text) => h("li", { class: "risk" }, `⚠ ${text}`)),
        )
      : null,
    node.impact ? renderImpact(node.impact) : null,
    (byParent.get(node.localId) ?? []).map((child) => renderNode(child, byParent)),
  );
}

const CONFIDENCE_LABEL = { low: "low", medium: "medium", high: "high" };

function renderImpact(impact) {
  const group = (title, items) =>
    items.length
      ? [
          h("h4", {}, title),
          h(
            "ul",
            {},
            items.map((text) => h("li", {}, h("code", {}, text))),
          ),
        ]
      : [];
  return h(
    "details",
    { class: "impact" },
    h(
      "summary",
      {},
      `Impact map (AI suggestion · ${CONFIDENCE_LABEL[impact.confidence] ?? impact.confidence} confidence)`,
    ),
    ...group("Expected file changes", impact.files),
    ...(impact.reuse.length
      ? [
          h("h4", {}, "Reusable components"),
          h(
            "ul",
            {},
            impact.reuse.map((text) => h("li", {}, text)),
          ),
        ]
      : []),
    ...group("Related tests", impact.tests),
  );
}

function renderQuestion(question) {
  return h(
    "li",
    {},
    question.text,
    question.suggestedAnswer
      ? h(
          "div",
          { class: "suggestion" },
          `💡 Suggestion: ${question.suggestedAnswer}`,
          question.evidence
            ? h("span", { class: "muted small" }, ` — evidence: ${question.evidence}`)
            : null,
        )
      : null,
  );
}

function fillList(selector, items) {
  const list = $(selector);
  list.replaceChildren(
    ...(items.length
      ? items.map((text) => h("li", {}, text))
      : [h("li", { class: "muted" }, "None")]),
  );
}

function renderDraft() {
  const draft = state.draft;
  $("#plan-result").hidden = !draft;
  if (!draft) return;
  const { plan } = draft;
  $("#plan-summary").textContent = plan.summary;
  const byParent = new Map();
  for (const node of plan.nodes) {
    const list = byParent.get(node.parentLocalId) ?? [];
    list.push(node);
    byParent.set(node.parentLocalId, list);
  }
  $("#plan-tree").replaceChildren(
    ...(byParent.get(null) ?? []).map((node) => renderNode(node, byParent)),
  );
  const blocking = $("#plan-blocking");
  blocking.hidden = draft.blocking.length === 0;
  blocking
    .querySelector("ul")
    .replaceChildren(...plan.openQuestions.filter((q) => q.blocking).map(renderQuestion));
  const openQuestions = plan.openQuestions.filter((q) => !q.blocking);
  $("#plan-open").replaceChildren(
    ...(openQuestions.length
      ? openQuestions.map(renderQuestion)
      : [h("li", { class: "muted" }, "None")]),
  );
  fillList("#plan-assumptions", plan.assumptions);
  fillList("#plan-clarifications", draft.clarifications);

  const created = Boolean(draft.created);
  $("#refine-form").hidden = created;
  const suggestions = plan.openQuestions.filter((q) => q.suggestedAnswer).length;
  const acceptButton = $("#accept-suggestions-btn");
  acceptButton.hidden = created || suggestions === 0;
  acceptButton.textContent = `Use ${suggestions} AI suggestions`;
  const createButton = $("#create-btn");
  const reasons = [];
  if (!hasRole("po")) reasons.push("Only Product Owners can create issues");
  if (draft.blocking.length) reasons.push("Resolve blocking questions first");
  createButton.disabled = reasons.length > 0;
  createButton.textContent = `Create ${plan.nodes.length} issues`;
  $("#create-hint").textContent = reasons.join(" · ");

  const createdBox = $("#plan-created");
  createdBox.hidden = !created;
  if (created) {
    const links = [
      h(
        "li",
        {},
        "Request ",
        h(
          "a",
          {
            href: issueUrl(draft.created.requestIssue),
            target: "_blank",
            rel: "noopener noreferrer",
          },
          `#${draft.created.requestIssue}`,
        ),
      ),
      ...Object.entries(draft.created.issues).map(([localId, number]) =>
        h(
          "li",
          {},
          `${localId} `,
          h(
            "a",
            { href: issueUrl(number), target: "_blank", rel: "noopener noreferrer" },
            `#${number}`,
          ),
        ),
      ),
    ];
    createdBox.querySelector("ul").replaceChildren(...links);
  }
}

function getFileIcon(mimeType, name = "") {
  if (mimeType.startsWith("image/")) return "🖼️";
  if (mimeType === "application/pdf" || name.endsWith(".pdf")) return "📄";
  if (
    mimeType.includes("csv") ||
    name.endsWith(".csv") ||
    name.endsWith(".xlsx") ||
    name.endsWith(".xls")
  )
    return "📊";
  if (name.endsWith(".json")) return "⚙️";
  if (name.endsWith(".md")) return "📝";
  return "📎";
}

function renderPlanAttachments() {
  const container = $("#plan-attachment-previews") || $("#plan-image-previews");
  if (!container) return;
  if (!state.planAttachments || state.planAttachments.length === 0) {
    container.hidden = true;
    container.replaceChildren();
    return;
  }
  container.hidden = false;
  container.replaceChildren(
    ...state.planAttachments.map((att, index) => {
      const isImg = att.mimeType.startsWith("image/");
      const chip = h(
        "div",
        { class: `attachment-chip ${isImg ? "is-image" : "is-doc"}` },
        isImg
          ? h("img", {
              src: `data:${att.mimeType};base64,${att.dataBase64}`,
              alt: att.name || `File ${index + 1}`,
            })
          : [
              h("span", { class: "doc-icon" }, getFileIcon(att.mimeType, att.name)),
              h(
                "span",
                { class: "doc-name", title: att.name || "Attachment" },
                att.name || "Attachment",
              ),
            ],
        h(
          "button",
          {
            type: "button",
            class: "chip-remove",
            title: "Remove file",
            onclick: (e) => {
              e.stopPropagation();
              state.planAttachments.splice(index, 1);
              renderPlanAttachments();
            },
          },
          "×",
        ),
      );
      return chip;
    }),
  );
}

async function addPlanAttachmentFile(file) {
  if (!file) return;
  state.planAttachments = state.planAttachments || [];
  if (state.planAttachments.length >= 10) {
    alert("A plan supports up to 10 attachments.");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    alert(`File "${file.name}" exceeds 10 MB.`);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    if (typeof dataUrl === "string") {
      const base64 = dataUrl.split(",")[1];
      const mime =
        file.type ||
        (file.name.endsWith(".csv")
          ? "text/csv"
          : file.name.endsWith(".md")
            ? "text/markdown"
            : "application/octet-stream");
      state.planAttachments.push({
        mimeType: mime,
        dataBase64: base64,
        name: file.name,
      });
      renderPlanAttachments();
    }
  };
  reader.readAsDataURL(file);
}

function initPlanAttachments() {
  const dropzone = $("#plan-dropzone");
  const fileInput = $("#plan-file-input");
  const browseBtn = $("#plan-browse-btn");

  if (!dropzone || !fileInput) return;

  browseBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    fileInput.click();
  });

  dropzone.addEventListener("click", (e) => {
    if (e.target.closest(".chip-remove") || e.target.closest("button")) return;
    fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files) {
      for (const file of fileInput.files) {
        addPlanAttachmentFile(file);
      }
      fileInput.value = "";
    }
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove("dragover");
    });
  });

  dropzone.addEventListener("drop", (e) => {
    const files = e.dataTransfer?.files;
    if (files) {
      for (const file of files) {
        addPlanAttachmentFile(file);
      }
    }
  });

  // Global paste handler when in Plan view
  window.addEventListener("paste", (e) => {
    const planView = $("#view-plan");
    if (!planView || planView.hidden) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) addPlanAttachmentFile(file);
      }
    }
  });
}

async function generatePlan(event) {
  event.preventDefault();
  const request = $("#plan-request").value;
  const title = $("#plan-title").value;
  const linksRaw = $("#plan-links")
    ? $("#plan-links").value
    : $("#plan-figma")
      ? $("#plan-figma").value
      : "";
  const links = linksRaw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("http://") || l.startsWith("https://"));

  const attachments = (state.planAttachments || []).map((att) => ({
    name: att.name,
    mimeType: att.mimeType,
    dataBase64: att.dataBase64,
  }));
  const update = log("pending", "Generating plan…");
  await withBusy($("#plan-generate"), async () => {
    try {
      state.draft = await api("/api/plans", {
        title,
        request,
        links: links.length > 0 ? links : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      renderDraft();
      update(
        "ok",
        `Plan: ${state.draft.plan.nodes.length} items · ${state.draft.blocking.length} blocking questions`,
      );
    } catch (error) {
      update("fail", "Could not generate plan", { text: `${error.code ?? ""}: ${error.message}` });
    }
  });
}

async function refinePlan(event) {
  event.preventDefault();
  const clarification = $("#refine-text").value;
  const update = log("pending", "Updating plan…");
  await withBusy($("#refine-btn"), async () => {
    try {
      state.draft = await api(`/api/plans/${state.draft.draftId}/refine`, { clarification });
      $("#refine-text").value = "";
      renderDraft();
      update(
        "ok",
        `Updated: ${state.draft.plan.nodes.length} items · ${state.draft.blocking.length} blocking questions`,
      );
    } catch (error) {
      update("fail", "Could not update plan", {
        text: `${error.code ?? ""}: ${error.message}`,
      });
    }
  });
}

async function acceptSuggestions() {
  const update = log("pending", "Applying AI suggestions…");
  await withBusy($("#accept-suggestions-btn"), async () => {
    try {
      state.draft = await api(`/api/plans/${state.draft.draftId}/accept-suggestions`, {});
      renderDraft();
      update(
        "ok",
        `Updated: ${state.draft.plan.nodes.length} items · ${state.draft.blocking.length} blocking questions`,
      );
    } catch (error) {
      update("fail", "Could not apply suggestions", {
        text: `${error.code ?? ""}: ${error.message}`,
      });
    }
  });
}

async function createIssues() {
  const draft = state.draft;
  const confirm = await openDialog({
    title: "Create GitHub issues",
    body: h(
      "p",
      {},
      `Create one request and ${draft.plan.nodes.length} issues in ${state.session.repo.owner}/${state.session.repo.repo} as ${state.session.viewer.login}.`,
    ),
    okLabel: "Create issues",
  });
  if (confirm !== "ok") return;
  const update = log("pending", "Creating issues…");
  await withBusy($("#create-btn"), async () => {
    try {
      state.draft = await api(`/api/plans/${draft.draftId}/create`, {});
      renderDraft();
      update("ok", `Created ${Object.keys(state.draft.created.issues).length} issues`);
      loadItems();
    } catch (error) {
      update("fail", "Issue creation is incomplete. Select Create issues to resume.", {
        text: `${error.code ?? ""}: ${error.message}`,
      });
    }
  });
}

// ---------- settings ----------

async function loadSettings() {
  const msg = $("#save-status-msg");
  if (msg) msg.textContent = "";

  try {
    $("#remember-credentials").checked = (await loadEngine()).rememberCredentials;
    const data = await api("/api/settings");
    state.settings = data;
    updateRepoInitBanner();

    // GitHub
    const ghBadge = $("#github-status-badge");
    ghBadge.className = "badge";
    if (data.githubUser) {
      ghBadge.classList.add("ok");
      ghBadge.textContent = "Connected";
      $("#github-user-row").hidden = false;
      const connectSec = $("#github-connect-section");
      if (connectSec) connectSec.hidden = true;
      $("#github-user-login").textContent = `@${data.githubUser.login}`;
      $("#github-user-id").textContent = `GitHub ID · ${data.githubUser.id}`;
    } else {
      ghBadge.classList.add("danger");
      ghBadge.textContent = "Not connected";
      $("#github-user-row").hidden = true;
      const connectSec = $("#github-connect-section");
      if (connectSec) connectSec.hidden = false;
    }

    if (data.githubTokenMasked) {
      $("#input-github-token").placeholder = `${data.githubTokenMasked} (leave blank to keep)`;
    } else {
      $("#input-github-token").placeholder = "ghp_... (paste your token)";
    }

    const authStatus = await api("/api/auth/status");
    state.oauthEnabled = Boolean(authStatus.oauthEnabled);
    $("#btn-login-github").hidden = !state.oauthEnabled;
    $("#oauth-setup-note").hidden = state.oauthEnabled;
    if (!state.oauthEnabled && !data.githubUser) $("#pat-settings").open = true;

    // AI Planner
    const geminiBadge = $("#gemini-status-badge");
    geminiBadge.className = "badge";
    if (data.hasGeminiKey) {
      geminiBadge.classList.add("ok");
      geminiBadge.textContent = "Gemini";
      $("#ai-provider-name").textContent = data.geminiModel;
      $("#ai-provider-hint").textContent = "Using your Gemini API key.";
      $("#input-gemini-key").placeholder = `${data.geminiKeyMasked} (leave blank to keep)`;
    } else if (data.hasGithubToken) {
      geminiBadge.classList.add("ok");
      geminiBadge.textContent = "GitHub Models";
      $("#ai-provider-name").textContent = "GitHub Models · gpt-4o-mini";
      $("#ai-provider-hint").textContent =
        "Uses your connected GitHub account. No separate key required.";
      $("#input-gemini-key").placeholder =
        "AQ.Ab8... or AIzaSy... (leave blank to use GitHub Models)";
    } else {
      geminiBadge.classList.add("warn");
      geminiBadge.textContent = "Awaiting connection";
      $("#ai-provider-name").textContent = "GitHub Models";
      $("#ai-provider-hint").textContent =
        "Connect GitHub to get started, or configure Gemini below.";
      $("#input-gemini-key").placeholder = "AQ.Ab8... or AIzaSy...";
    }

    if (data.geminiModel) {
      $("#select-gemini-model").value = data.geminiModel;
    }

    // Roles section
    renderRolesSection(data.policyRoles, data.canEditRoles, data.policyStatus);

    // Alert
    const alert = $("#settings-alert");
    if (data.status === "needs_setup") {
      alert.hidden = false;
      const reasons = [];
      if (data.missing.includes("missing_github_token"))
        reasons.push("Connect your GitHub account");
      if (data.missing.includes("invalid_github_token"))
        reasons.push("GitHub token is invalid or expired");
      if (data.missing.includes("missing_repo")) reasons.push("Select a repository (owner/name)");
      if (data.missing.includes("repo_not_found"))
        reasons.push("Repository not found or your account does not have access");
      if (data.missing.includes("missing_policy"))
        reasons.push("Initialize AI-DLC using the repository banner");
      alert.replaceChildren(h("strong", {}, "Complete setup"), h("p", {}, reasons.join(" · ")));
    } else {
      alert.hidden = true;
    }
  } catch (err) {
    log("fail", "Could not load settings", { text: err.message });
  }
}

async function testGithubToken() {
  const tokenVal = $("#input-github-token").value.trim();
  const msgEl = $("#github-test-msg");
  msgEl.hidden = true;
  await withBusy($("#btn-test-github"), async () => {
    try {
      const res = await api("/api/settings/test-github", tokenVal ? { token: tokenVal } : {});
      msgEl.hidden = false;
      if (res.ok) {
        msgEl.className = "test-msg ok small";
        msgEl.textContent = `✓ Connected as @${res.viewer.login} (ID: ${res.viewer.id})`;
        if (tokenVal) {
          await api("/api/settings", { githubToken: tokenVal });
          $("#input-github-token").value = "";
          await loadSettings();
          await syncSession();
          await loadUserRepos(true);
        }
      } else {
        msgEl.className = "test-msg err small";
        msgEl.textContent = `✗ Connection test failed: ${res.error}`;
      }
    } catch (err) {
      msgEl.hidden = false;
      msgEl.className = "test-msg err small";
      msgEl.textContent = `✗ Error: ${err.message}`;
    }
  });
}

async function disconnectGithub() {
  const confirmed = confirm(
    "Sign out and clear your GitHub token and Gemini key across all tabs on this origin?",
  );
  if (!confirmed) return;
  try {
    await api("/api/auth/disconnect", {});
    log("ok", "Signed out and cleared GitHub token and Gemini key");
    state.userRepos = [];
    state.items = [];
    state.draft = null;
    renderDraft();
    await loadSettings();
    await syncSession();
    if (state.session?.status === "ready") {
      await loadItems();
    } else {
      renderItems();
      const countEpics = $("#count-epics");
      const countStories = $("#count-stories");
      const countTasks = $("#count-tasks");
      if (countEpics) countEpics.textContent = "0";
      if (countStories) countStories.textContent = "0";
      if (countTasks) countTasks.textContent = "0";
    }
  } catch (err) {
    logError("Sign-out failed", err);
  }
}

async function testGeminiKey() {
  const keyVal = $("#input-gemini-key").value.trim();
  const modelVal = $("#select-gemini-model").value;
  const msgEl = $("#gemini-test-msg");
  msgEl.hidden = true;
  await withBusy($("#btn-test-gemini"), async () => {
    try {
      const res = await api("/api/settings/test-gemini", {
        apiKey: keyVal || undefined,
        model: modelVal,
      });
      msgEl.hidden = false;
      if (res.ok) {
        msgEl.className = "test-msg ok small";
        msgEl.textContent = `✓ Connected to Gemini (${modelVal})`;
      } else {
        msgEl.className = "test-msg err small";
        msgEl.textContent = `✗ Connection test failed: ${res.error}`;
      }
    } catch (err) {
      msgEl.hidden = false;
      msgEl.className = "test-msg err small";
      msgEl.textContent = `✗ Error: ${err.message}`;
    }
  });
}

async function saveSettings() {
  const githubToken = $("#input-github-token").value.trim();
  const geminiApiKey = $("#input-gemini-key").value.trim();
  const geminiModel = $("#select-gemini-model").value;
  const statusMsg = $("#save-status-msg");

  const patch = {};
  if (githubToken) patch.githubToken = githubToken;
  if (geminiApiKey) patch.geminiApiKey = geminiApiKey;
  if (geminiModel) patch.geminiModel = geminiModel;

  await withBusy($("#btn-save-settings"), async () => {
    try {
      await api("/api/settings", patch);
      $("#input-github-token").value = "";
      $("#input-gemini-key").value = "";
      log("ok", "Settings updated");
      await loadSettings();
      await syncSession();
      if (patch.githubToken) {
        await loadUserRepos(true);
      }
      statusMsg.className = "save-status-msg ok";
      statusMsg.textContent = "Settings saved";
    } catch (err) {
      statusMsg.className = "save-status-msg err";
      statusMsg.textContent = `✗ Save failed: ${err.message}`;
      log("fail", "Could not save settings", { text: err.message });
    }
  });
}

// ---------- roles management ----------

function renderRolesSection(policyRoles, canEdit, policyStatus) {
  const badge = $("#roles-status-badge");
  const noPolicyMsg = $("#roles-no-policy-msg");
  const contentSec = $("#roles-content-section");
  if (!badge || !noPolicyMsg || !contentSec) return;

  if (policyStatus === "missing" || !policyRoles) {
    badge.className = "badge warn";
    badge.textContent = "No policy";
    noPolicyMsg.hidden = false;
    contentSec.hidden = true;
    return;
  }

  noPolicyMsg.hidden = true;
  contentSec.hidden = false;
  badge.className = "badge " + (canEdit ? "ok" : "story");
  badge.textContent = canEdit ? "Maintainer access" : "Read-only";

  state.canEditRoles = Boolean(canEdit);
  state.rolesDraft = {
    po: Array.isArray(policyRoles.po) ? [...policyRoles.po] : [],
    dev: Array.isArray(policyRoles.dev) ? [...policyRoles.dev] : [],
    maintainer: Array.isArray(policyRoles.maintainer) ? [...policyRoles.maintainer] : [],
  };

  renderRoleChips();
}

function renderRoleChips() {
  const roles = ["po", "dev", "maintainer"];
  for (const role of roles) {
    const list = state.rolesDraft[role] || [];
    const countBadge = $(`#${role}-count`);
    if (countBadge) {
      countBadge.textContent = `${list.length} ${role.toUpperCase()}`;
    }

    const container = $(`#${role}-members-list`);
    if (!container) continue;
    container.replaceChildren();

    if (list.length === 0) {
      container.append(
        h(
          "span",
          { class: "muted small", style: "padding: 6px 0; font-style: italic" },
          "(No members yet)",
        ),
      );
    } else {
      for (const m of list) {
        const chip = h("div", { class: "member-chip" });
        const initial = (m.login || "?").slice(0, 2).toUpperCase();
        const avatar = h("span", { class: "member-chip-avatar" }, initial);
        const login = h("span", { class: "member-chip-login" }, `@${m.login}`);
        const id = h("span", { class: "member-chip-id" }, `(#${m.id})`);
        chip.append(avatar, login, id);

        if (state.canEditRoles) {
          const removeBtn = h(
            "button",
            {
              class: "member-chip-remove",
              type: "button",
              title: `Remove @${m.login} from ${role.toUpperCase()}`,
            },
            "✕",
          );
          removeBtn.onclick = () => removeRoleMember(role, m.id);
          chip.append(removeBtn);
        }
        container.append(chip);
      }
    }

    // Toggle add row
    const addRow = document.querySelector(`.member-add-row[data-role="${role}"]`);
    if (addRow) {
      addRow.hidden = !state.canEditRoles;
    }
  }

  const saveBtn = $("#btn-save-roles");
  if (saveBtn) {
    saveBtn.hidden = !state.canEditRoles;
  }
}

async function handleAddMember(role) {
  if (!state.rolesDraft) state.rolesDraft = { po: [], dev: [], maintainer: [] };
  if (!state.rolesDraft[role]) state.rolesDraft[role] = [];
  const input = $(`#input-add-${role}`);
  const btn = $(`#btn-add-${role}`);
  if (!input) return;
  let username = input.value.trim().replace(/^@/, "");
  if (!username) {
    const roleName =
      role === "po" ? "Product Owner (PO)" : role === "dev" ? "Developer (DEV)" : "Maintainer";
    const promptVal = prompt(
      `Enter a GitHub username to add as ${roleName} (for example: tadev999 or octocat):`,
    );
    if (!promptVal || !promptVal.trim()) {
      input.focus();
      return;
    }
    username = promptVal.trim().replace(/^@/, "");
  }

  const runWithBtn = btn ? (fn) => withBusy(btn, fn) : (fn) => fn();
  await runWithBtn(async () => {
    try {
      const res = await api("/api/users/resolve", { username });
      if (state.rolesDraft[role].some((m) => m.id === res.id)) {
        alert(`@${res.login} is already in ${role.toUpperCase()}.`);
        return;
      }
      state.rolesDraft[role].push({ id: res.id, login: res.login });
      input.value = "";
      renderRoleChips();
      log("ok", `Added @${res.login} to the ${role.toUpperCase()} draft`);
    } catch (err) {
      alert(`Could not add @${username}: ${err.message}`);
    }
  });
}

function removeRoleMember(role, memberId) {
  if (role === "po" && state.rolesDraft.po.length <= 1) {
    alert("At least one Product Owner is required. This member cannot be removed.");
    return;
  }
  if (role === "maintainer" && state.rolesDraft.maintainer.length <= 1) {
    alert("At least one Maintainer is required. This member cannot be removed.");
    return;
  }
  state.rolesDraft[role] = state.rolesDraft[role].filter((m) => m.id !== memberId);
  renderRoleChips();
}

async function handleSaveRoles() {
  const btn = $("#btn-save-roles");
  const msg = $("#save-roles-msg");
  if (!btn) return;
  if (msg) {
    msg.className = "save-status-msg";
    msg.textContent = "";
  }

  if (state.rolesDraft.po.length === 0) {
    alert("At least one Product Owner is required.");
    return;
  }
  if (state.rolesDraft.maintainer.length === 0) {
    alert("At least one Maintainer is required.");
    return;
  }

  await withBusy(btn, async () => {
    try {
      log("pending", "Updating roles on GitHub (.github/huddle60/policy.yml)...");
      await api("/api/policy/roles", { roles: state.rolesDraft });
      if (msg) {
        msg.className = "save-status-msg ok";
        msg.textContent = "✓ Roles saved to GitHub";
      }
      log("ok", "Access policy updated on GitHub");
      await syncSession();
      await loadSettings();
    } catch (err) {
      if (msg) {
        msg.className = "save-status-msg err";
        msg.textContent = `✗ Save failed: ${err.message}`;
      }
      log("fail", "Could not update roles", { text: err.message });
    }
  });
}

function updateRepoInitBanner() {
  const banner = $("#repo-init-banner");
  if (!banner) return;
  const session = state.session;
  if (!session || !session.repo) {
    banner.hidden = true;
    return;
  }
  const repoStr = `${session.repo.owner}/${session.repo.repo}`;
  const isMissingPolicy = session.missing?.includes("missing_policy");

  if (!isMissingPolicy) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  const nameEl = $("#banner-repo-name");
  if (nameEl) nameEl.textContent = repoStr;

  const iconEl = $("#banner-init-icon");
  const titleEl = $("#banner-init-title");
  const descEl = $("#banner-init-desc");
  const btnInit = $("#btn-banner-init-repo");
  const btnViewGh = $("#btn-banner-view-github");
  const btnLoginMaintainer = $("#btn-banner-login-maintainer");

  // Determine if viewer has write/admin rights
  const canInit = Boolean(session.canInitRepo);

  if (canInit) {
    banner.classList.remove("info-mode");
    if (iconEl) iconEl.textContent = "⚠️";
    if (titleEl) {
      titleEl.innerHTML = `AI-DLC is not initialized for <code id="banner-repo-name">${repoStr}</code>.`;
    }
    if (descEl) {
      descEl.innerHTML = `No AI-DLC policy was found on the default branch. Initialize the repository to create <code>.github/huddle60/policy.yml</code> and the supporting labels and evidence branch.`;
    }
    if (btnInit) btnInit.hidden = false;
    if (btnViewGh) btnViewGh.hidden = true;
    if (btnLoginMaintainer) btnLoginMaintainer.hidden = true;
  } else {
    banner.classList.add("info-mode");
    if (iconEl) iconEl.textContent = "💡";
    if (titleEl) {
      titleEl.innerHTML = `AI-DLC is not configured for <code id="banner-repo-name">${repoStr}</code>.`;
    }
    if (descEl) {
      descEl.textContent =
        "This project has not enabled Huddle60. Select another repository above or view the source on GitHub.";
    }
    if (btnInit) btnInit.hidden = true;
    if (btnViewGh) {
      btnViewGh.href = session.repo.url || `https://github.com/${repoStr}`;
      btnViewGh.hidden = false;
    }
    if (btnLoginMaintainer) {
      btnLoginMaintainer.hidden = Boolean(session.viewer);
    }
  }
}

async function initRepository() {
  const confirm = await openDialog({
    title: "Initialize AI-DLC",
    body: h(
      "p",
      {},
      "This creates huddle60:* labels, the huddle60-evidence branch, and a policy file on the repository's default branch.",
    ),
    okLabel: "Initialize",
  });
  if (confirm !== "ok") return;

  const btn = $("#btn-banner-init-repo") || $("#btn-init-repo");
  const runWithBusy = btn ? (fn) => withBusy(btn, fn) : (fn) => fn();

  await runWithBusy(async () => {
    const update = log("pending", "Initializing repository…");
    try {
      const res = await api("/api/repo/init", {});
      update("ok", res.message || "Repository initialized.");
      await loadSettings();
      await syncSession();
    } catch (err) {
      update("fail", "Initialization failed", { text: err.message });
    }
  });
}

// ---------- boot ----------

function switchView(view) {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.view === view);
    tab.setAttribute("aria-selected", String(tab.dataset.view === view));
  }
  $("#view-items").hidden = view !== "items";
  $("#view-plan").hidden = view !== "plan";
  $("#view-settings").hidden = view !== "settings";

  if (view === "settings") {
    loadSettings();
  }
}

function fatal(message) {
  const box = $("#fatal");
  box.textContent = message;
  box.hidden = false;
}

async function switchRepository(repo) {
  if (state.switchingRepository) return;
  state.switchingRepository = true;
  state.repositoryVersion++;
  state.items = [];
  state.pending.clear();
  state.collapsed.clear();
  state.settings = null;
  state.query = "";
  $("#search").value = "";
  state.itemsStatus = "loading";
  $("#repo-switcher-select").disabled = true;
  $("#refresh").disabled = true;
  renderItems();
  switchView("items");
  try {
    log("pending", `Switching to repository: ${repo}...`);
    await api("/api/settings", { repo });
    log("ok", `Switched to repository: ${repo}`);
  } catch (err) {
    logError(`Could not switch to ${repo}`, err);
  } finally {
    state.switchingRepository = false;
    state.itemsStatus = "idle";
    $("#refresh").disabled = false;
    await syncSession();
  }
}

function renderRepoSwitcher() {
  const select = $("#repo-switcher-select");
  if (!select) return;
  const session = state.session || {};
  const isConnected = Boolean(
    session.viewer ||
    session.status === "ready" ||
    session.tenant ||
    session.repo ||
    state.userRepos?.length ||
    session.recentRepos?.length,
  );

  select.innerHTML = "";

  // 1. If not connected, do NOT show recent repos or allow switching
  if (!isConnected) {
    const unauthOpt = document.createElement("option");
    unauthOpt.value = "";
    unauthOpt.textContent = "No repository";
    unauthOpt.selected = true;
    unauthOpt.disabled = true;
    select.appendChild(unauthOpt);
    select.disabled = true;
    const repoGhLink = $("#repo-gh-link");
    if (repoGhLink) repoGhLink.hidden = true;
    return;
  }

  select.disabled = state.switchingRepository;
  const currentRepoStr = session.repo ? `${session.repo.owner}/${session.repo.repo}` : "";
  const recentRepos = session.recentRepos || (currentRepoStr ? [currentRepoStr] : []);

  if (!currentRepoStr) {
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "Select a repository...";
    defaultOpt.selected = true;
    defaultOpt.disabled = true;
    select.appendChild(defaultOpt);
  }

  // 2. Recent repos group
  if (recentRepos.length > 0) {
    const recentGroup = document.createElement("optgroup");
    recentGroup.label = "Recent repositories";
    for (const r of recentRepos) {
      const opt = document.createElement("option");
      opt.value = r;
      opt.textContent = r;
      if (r === currentRepoStr) opt.selected = true;
      recentGroup.appendChild(opt);
    }
    select.appendChild(recentGroup);
  }

  // 3. All repositories from GitHub
  if (state.loadingRepos) {
    const loadingGroup = document.createElement("optgroup");
    loadingGroup.label = "All GitHub repositories";
    const loadingOpt = document.createElement("option");
    loadingOpt.disabled = true;
    loadingOpt.value = "";
    loadingOpt.textContent = "Loading GitHub repositories...";
    loadingGroup.appendChild(loadingOpt);
    select.appendChild(loadingGroup);
  } else if (state.userRepos && state.userRepos.length > 0) {
    const allGroup = document.createElement("optgroup");
    allGroup.label = `All repositories (${state.userRepos.length})`;
    for (const r of state.userRepos) {
      const opt = document.createElement("option");
      opt.value = r.fullName;
      opt.textContent = r.isPrivate ? `🔒 ${r.fullName}` : r.fullName;
      if (r.fullName === currentRepoStr) opt.selected = true;
      allGroup.appendChild(opt);
    }
    select.appendChild(allGroup);
  }

  // 4. Action options
  const actionGroup = document.createElement("optgroup");
  actionGroup.label = "Actions";

  const refreshOpt = document.createElement("option");
  refreshOpt.value = "__refresh__";
  refreshOpt.textContent = "Refresh from GitHub...";
  actionGroup.appendChild(refreshOpt);

  const addOpt = document.createElement("option");
  addOpt.value = "__add__";
  addOpt.textContent = "Enter another repository...";
  actionGroup.appendChild(addOpt);

  select.appendChild(actionGroup);

  if (currentRepoStr) {
    select.value = currentRepoStr;
  }
}

async function loadUserRepos(forceRefresh = false) {
  if (state.loadingRepos) return;
  state.loadingRepos = true;
  renderRepoSwitcher();

  try {
    const query = forceRefresh ? "?refresh=true" : "";
    const res = await api(`/api/repos${query}`);
    state.userRepos = res.repos || [];

    // Update datalist for settings input
    const datalist = $("#repo-datalist");
    if (datalist) {
      datalist.innerHTML = "";
      for (const r of state.userRepos) {
        const opt = document.createElement("option");
        opt.value = r.fullName;
        if (r.description) opt.label = r.description;
        datalist.appendChild(opt);
      }
    }
  } catch (err) {
    console.warn("Could not load user repos:", err);
  } finally {
    state.loadingRepos = false;
    renderRepoSwitcher();
  }
}

async function removeRecentRepository(repo) {
  try {
    const currentList = state.settings?.recentRepos || [];
    const nextList = currentList.filter((r) => r !== repo);
    await api("/api/settings", { recentRepos: nextList });
    await loadSettings();
    await syncSession();
  } catch (err) {
    logError(`Could not remove ${repo}`, err);
  }
}

async function syncSession() {
  const version = state.repositoryVersion;
  try {
    const session = await api("/api/session");
    if (version !== state.repositoryVersion) return;
    state.session = session;
  } catch (error) {
    if (version !== state.repositoryVersion) return;
    state.items = [];
    state.itemsStatus = "error";
    state.itemsError = error.message;
    renderItems();
    fatal(`${error.code ?? "E"}: ${error.message}`);
    return;
  }

  const { session } = state;
  const isReady = session.status === "ready";

  const tenantBadge = $("#tenant-badge");
  if (tenantBadge) {
    tenantBadge.hidden = false;
    if (session.tenant) {
      tenantBadge.textContent = `@${session.tenant} ▾`;
      tenantBadge.title = `Workspace: ${session.tenant}`;
      tenantBadge.hidden = false;
      document.title = `huddle60 · ${session.tenant}`;
    } else {
      tenantBadge.textContent = "Choose workspace ▾";
      tenantBadge.title = "Choose a GitHub account or organization";
      document.title = "huddle60";
      document.title = "huddle60";
    }
  }

  // Tabs enable/disable - navigation tabs should always be clickable
  const itemsTab = document.querySelector('.tab[data-view="items"]');
  const planTab = document.querySelector('.tab[data-view="plan"]');
  if (itemsTab) itemsTab.disabled = false;
  if (planTab) planTab.disabled = false;

  // Render repo switcher dropdown with all repos
  renderRepoSwitcher();

  // If tenant, repo, or viewer exists and haven't fetched all repos yet, load in background
  if (
    (session.viewer || session.status === "ready" || session.tenant || session.repo) &&
    !state.userRepos.length &&
    !state.loadingRepos
  ) {
    loadUserRepos();
  }

  const repoGhLink = $("#repo-gh-link");
  if (repoGhLink) {
    const isConnected = Boolean(
      session.viewer || session.status === "ready" || session.tenant || session.repo,
    );
    if (session.repo && isConnected) {
      repoGhLink.href = session.repo.url;
      repoGhLink.hidden = false;
    } else {
      repoGhLink.hidden = true;
    }
  }

  const isGuest = !session.viewer || (!hasRole("po") && !hasRole("dev"));
  if (session.viewer) {
    $("#viewer").textContent = `@${session.viewer.login}`;
  } else {
    $("#viewer").textContent = "Guest";
  }

  $("#roles").replaceChildren(
    ...(session.roles && session.roles.length
      ? session.roles.map((role) => h("span", { class: "badge story" }, role))
      : isReady
        ? [h("span", { class: "badge story" }, "Read-only")]
        : [h("span", { class: "badge warn" }, "Setup required")]),
  );

  const dot = $("#planner-status");
  dot.classList.toggle("on", Boolean(session.planner));
  dot.title = session.planner
    ? `planner: ${session.planner.model}`
    : "Planner unavailable (connect GitHub or add a Gemini key)";

  if (!session.planner) {
    $("#plan-generate").disabled = true;
    $("#plan-hint").textContent = "Connect GitHub or configure Gemini to use the planner";
  } else {
    $("#plan-generate").disabled = false;
    const providerName = session.planner.provider === "gemini" ? "Google Gemini" : "GitHub Models";
    $("#plan-hint").textContent = `Using ${session.planner.model} (${providerName})`;
  }

  updateRepoInitBanner();

  if (session.policyRoles !== undefined) {
    renderRolesSection(session.policyRoles, session.canEditRoles, session.policyStatus);
  }

  const guestBanner = $("#guest-mode-banner");
  if (guestBanner) {
    guestBanner.hidden = !(isReady && isGuest);
  }

  if (!isReady) {
    state.items = [];
    state.itemsStatus = "idle";
    renderItems();
  } else {
    if (!hasRole("po") && !hasRole("dev")) {
      state.filter = "all";
      for (const chip of document.querySelectorAll("#filters .chip"))
        chip.classList.toggle("active", chip.dataset.filter === "all");
    }
    await loadItems();
  }
}

function getTargetRepoFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const qRepo = params.get("repo");
  if (qRepo && qRepo.trim()) {
    return qRepo.trim();
  }
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts.length === 2 && parts[0] !== "api") {
    return `${parts[0]}/${parts[1]}`;
  }
  if (parts.length === 1 && !["app", "landing", "index.html"].includes(parts[0])) {
    const tenant = state.session?.tenant || readTenant();
    if (tenant && parts[0] !== tenant) {
      return `${tenant}/${parts[0]}`;
    }
  }
  return null;
}

async function boot() {
  const workspaceDialog = $("#workspace-dialog");
  $("#tenant-badge").addEventListener("click", () => {
    $("#workspace-owner").value = state.session?.tenant || "";
    workspaceDialog.showModal();
  });
  $("#workspace-cancel").addEventListener("click", () => workspaceDialog.close());
  $("#workspace-switch-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const owner = $("#workspace-owner").value.trim().toLowerCase();
    const target = new URL("/app", location.origin);
    target.searchParams.set("tenant", owner);
    if (
      owner !== state.session?.tenant &&
      (!state.draft || confirm("Switch workspace? Unsaved plan drafts will be discarded."))
    ) {
      location.assign(target.href);
    } else {
      workspaceDialog.close();
    }
  });
  const engine = await loadEngine();
  $("#remember-credentials").checked = engine.rememberCredentials;
  const match = /(?:^|&)gh_token=([^&]+)/.exec(location.hash.slice(1));
  if (match) {
    history.replaceState(null, "", location.pathname + (location.search || ""));
    try {
      await api("/api/settings", { githubToken: decodeURIComponent(match[1]) });
    } catch (error) {
      logError("Could not save GitHub sign-in", error);
    }
  }

  $("#remember-credentials").addEventListener("change", (event) => {
    try {
      engine.setRememberCredentials(event.target.checked);
      log(
        "ok",
        event.target.checked
          ? "Remember this device enabled"
          : "Sign-in will only be kept in this tab",
      );
    } catch (error) {
      event.target.checked = engine.rememberCredentials;
      logError("Could not change credential storage", error);
    }
  });
  window.addEventListener("huddle60-credentials-changed", async () => {
    state.userRepos = [];
    state.items = [];
    state.draft = null;
    state.pending.clear();
    renderDraft();
    $("#input-github-token").value = "";
    $("#input-gemini-key").value = "";
    renderItems();
    $("#spec-dialog").close();
    switchView("settings");
    log("pending", "Credentials changed in another tab. Plan drafts must be recreated.");
    await syncSession();
    await loadSettings();
  });

  for (const chip of document.querySelectorAll("#filters .chip")) {
    chip.dataset.label = chip.textContent;
    chip.addEventListener("click", () => {
      state.filter = chip.dataset.filter;
      for (const other of document.querySelectorAll("#filters .chip"))
        other.classList.toggle("active", other === chip);
      renderItems();
    });
  }

  for (const tab of document.querySelectorAll(".tab"))
    tab.addEventListener("click", () => switchView(tab.dataset.view));

  $("#search").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderItems();
  });
  $("#refresh").addEventListener("click", () => loadItems(true));
  $("#btn-guest-login")?.addEventListener("click", () => switchView("settings"));
  $("#log-clear").addEventListener("click", () => $("#log").replaceChildren());
  $("#plan-form").addEventListener("submit", generatePlan);
  $("#refine-form").addEventListener("submit", refinePlan);
  $("#accept-suggestions-btn").addEventListener("click", acceptSuggestions);
  $("#create-btn").addEventListener("click", createIssues);
  initPlanAttachments();

  // Repo switcher handler
  $("#repo-switcher-select")?.addEventListener("change", async (event) => {
    const value = event.target.value;
    const current = state.session?.repo
      ? `${state.session.repo.owner}/${state.session.repo.repo}`
      : "";

    if (value === "__refresh__") {
      event.target.value = current;
      await loadUserRepos(true);
      return;
    }
    if (value === "__add__") {
      event.target.value = current;
      const tenant = state.session?.tenant;
      const promptMsg = tenant
        ? `Enter a repository in @${tenant} (for example: ${tenant}/my-repo or my-repo):`
        : "Enter a GitHub repository (owner/repo):";
      const customRepo = prompt(promptMsg);
      if (customRepo && customRepo.trim()) {
        let repoToSwitch = customRepo.trim();
        if (tenant && !repoToSwitch.includes("/")) {
          repoToSwitch = `${tenant}/${repoToSwitch}`;
        }
        await switchRepository(repoToSwitch);
      }
      return;
    }
    if (value && value !== current) {
      await switchRepository(value);
    }
  });

  // Settings handlers
  $("#btn-test-github").addEventListener("click", testGithubToken);
  $("#btn-disconnect-github")?.addEventListener("click", disconnectGithub);
  $("#btn-login-github")?.addEventListener("click", (e) => {
    if (state.oauthEnabled) {
      e.currentTarget.href = `/api/auth/github?returnUrl=${encodeURIComponent(location.pathname + location.search)}`;
      return;
    }
    if (!state.oauthEnabled) {
      e.preventDefault();
      alert(
        "GitHub OAuth is not configured on this server (GITHUB_CLIENT_ID is missing).\n\n" +
          "Use a Personal Access Token (PAT) below.",
      );
    }
  });
  $("#btn-test-gemini").addEventListener("click", testGeminiKey);
  $("#btn-save-settings").addEventListener("click", saveSettings);
  $("#btn-banner-init-repo")?.addEventListener("click", initRepository);
  $("#btn-banner-login-maintainer")?.addEventListener("click", () => switchView("settings"));
  $("#btn-init-repo")?.addEventListener("click", initRepository);

  // Role management handlers
  $("#btn-add-po")?.addEventListener("click", () => handleAddMember("po"));
  $("#btn-add-dev")?.addEventListener("click", () => handleAddMember("dev"));
  $("#btn-add-maintainer")?.addEventListener("click", () => handleAddMember("maintainer"));

  $("#input-add-po")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddMember("po");
    }
  });
  $("#input-add-dev")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddMember("dev");
    }
  });
  $("#input-add-maintainer")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddMember("maintainer");
    }
  });

  $("#btn-save-roles")?.addEventListener("click", handleSaveRoles);

  // Spec editor handlers
  $("#spec-btn-ai-refine").addEventListener("click", handleAiRefineSpec);
  $("#spec-btn-save").addEventListener("click", handleSaveSpecChanges);
  $("#spec-btn-cancel").addEventListener("click", () => $("#spec-dialog").close());
  $("#spec-modal-close-x").addEventListener("click", () => $("#spec-dialog").close());

  await syncSession();
  loadSettings().catch(() => {});
  if (state.session?.status === "ready") {
    log(
      "ok",
      state.session.viewer
        ? `Connected · @${state.session.viewer.login}`
        : "Viewing as a guest · sign in to GitHub to make changes",
    );
  }

  // Check URL for target repo (e.g. /skill_bento or /tadev999/skill_bento or ?repo=...)
  const targetCandidate = getTargetRepoFromUrl();
  if (targetCandidate) {
    let fullRepo = targetCandidate;
    if (!fullRepo.includes("/")) {
      const owner =
        state.session.tenant || state.session.repo?.owner || state.session.viewer?.login;
      if (owner) {
        fullRepo = `${owner}/${fullRepo}`;
      }
    }
    const currentRepoStr = state.session.repo
      ? `${state.session.repo.owner}/${state.session.repo.repo}`
      : "";
    if (
      fullRepo &&
      fullRepo.includes("/") &&
      fullRepo.toLowerCase() !== currentRepoStr.toLowerCase()
    ) {
      await switchRepository(fullRepo);
    }
  }

  window.addEventListener("hashchange", focusTargetTask);
}

boot().catch((error) => fatal(`Could not start the app: ${error.message}`));
