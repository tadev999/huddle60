// huddle60 local app (AI-DLC). Plain ES module, no build step. All user/model text is set via textContent.

const TOKEN_KEY = "ai-dlc-token";
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

function readToken() {
  const match = /(?:^|&)token=([\w-]+)/.exec(location.hash.slice(1));
  if (match) {
    sessionStorage.setItem(TOKEN_KEY, match[1]);
    history.replaceState(null, "", location.pathname);
    return match[1];
  }
  const stored = sessionStorage.getItem(TOKEN_KEY);
  if (stored) return stored;

  const meta = document.querySelector('meta[name="huddle60-session-token"]');
  if (meta && meta.content) {
    sessionStorage.setItem(TOKEN_KEY, meta.content);
    return meta.content;
  }

  const cookieMatch = /(?:^|;\s*)huddle60_token=([\w-]+)/.exec(document.cookie);
  if (cookieMatch) {
    sessionStorage.setItem(TOKEN_KEY, cookieMatch[1]);
    return cookieMatch[1];
  }

  return null;
}

const token = readToken();

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function api(path, body, method) {
  const init = {
    headers: { "x-ai-dlc-token": token ?? "" },
    method: method ?? (body !== undefined ? "POST" : "GET"),
  };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data.error ?? { code: "E_HTTP", message: `HTTP ${response.status}` };
    throw new ApiError(error.code, error.message);
  }
  return data;
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
  const time = new Date().toLocaleTimeString([], {
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
  ok.textContent = okLabel ?? "Xác nhận";
  const copy = $("#dialog-copy");
  copy.hidden = !copyText;
  copy.textContent = "Sao chép";
  copy.onclick = async () => {
    await navigator.clipboard.writeText(copyText);
    copy.textContent = "Đã sao chép";
  };
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true });
  });
}

// ---------- work items ----------

const STAGE_LABEL = {
  "awaiting-approval": "Chờ PO duyệt",
  "awaiting-ready": "Chờ DEV xác nhận",
  "in-progress": "Đang triển khai",
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

function actionsFor(item) {
  const pending = state.pending.get(item.number);
  if (pending) return [h("span", { class: "meta" }, `${pending} · Chờ Actions`)];
  const buttons = [
    h(
      "a",
      {
        class: "btn ghost",
        href: item.url,
        target: "_blank",
        rel: "noopener noreferrer",
        title: "Mở trên GitHub",
      },
      "↗",
    ),
  ];
  if (hasRole("dev") || hasRole("po")) {
    buttons.push(
      h(
        "button",
        {
          class: "btn ghost",
          title: "Sửa đặc tả & kế hoạch (kèm AI hỗ trợ)",
          onclick: () => openSpecEditor(item),
        },
        "✏️ Sửa",
      ),
    );
  }
  if (item.stage === "in-progress") {
    buttons.push(
      h(
        "button",
        {
          class: "btn ghost",
          title: "Context cho coding agent",
          onclick: (e) => showContext(e.currentTarget, item),
        },
        "Context",
      ),
    );
  }
  if (hasRole("dev") && item.stage !== "in-progress") {
    const lanes = readyLanes(item);
    if (lanes.length > 0) {
      const select = h(
        "select",
        { title: "Luồng triển khai" },
        lanes.map((lane) => h("option", { value: lane, selected: lane === "standard" }, lane)),
      );
      buttons.push(
        select,
        h(
          "button",
          {
            class: "btn",
            title: "DEV xác nhận sẵn sàng triển khai",
            onclick: (e) => decide(e.currentTarget, item, { action: "ready", lane: select.value }),
          },
          "Ready",
        ),
      );
    }
  }
  if (hasRole("po") && item.kind !== "task" && item.stage === "awaiting-approval") {
    buttons.push(
      h(
        "button",
        {
          class: "btn primary",
          title: "PO duyệt nội dung hiện tại",
          onclick: (e) => decide(e.currentTarget, item, { action: "approve" }),
        },
        "Approve",
      ),
    );
  }
  if (hasRole("po") && item.kind !== "task" && item.stage === "in-progress") {
    buttons.push(
      h(
        "button",
        {
          class: "btn primary",
          title: "PO nghiệm thu trên build đã merge",
          onclick: (e) => accept(e.currentTarget, item),
        },
        "Accept",
      ),
    );
  }
  return buttons;
}

function renderItems() {
  const entries = treeRows();
  const rows = entries.map(
    ({ item, depth = 0, hasChildren = false, expanded = false, contextOnly = false }) => {
      const meta = [];
      if (item.approvedBy) meta.push(h("div", {}, `Đã duyệt · ${item.approvedBy}`));
      if (item.ready) meta.push(h("div", {}, `Ready · ${item.ready.by} · ${item.ready.lane}`));
      if (item.changed) meta.push(h("div", { class: "changed" }, "Nội dung đã thay đổi"));
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
              "aria-label": `${expanded ? "Thu gọn" : "Mở rộng"} #${item.number}`,
              title: `${expanded ? "Thu gọn" : "Mở rộng"} #${item.number}`,
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
    state.items.length === 0 ? "Chưa có công việc đang mở." : "Không có công việc phù hợp.";
  for (const chip of document.querySelectorAll("#filters .chip")) {
    const filter = chip.dataset.filter;
    const count = state.items.filter((item) =>
      filter === "all" ? true : filter === "mine" ? needsMe(item) : item.stage === filter,
    ).length;
    chip.replaceChildren(chip.dataset.label, h("span", { class: "count" }, count));
  }
}

async function loadItems() {
  const button = $("#refresh");
  await withBusy(button, async () => {
    try {
      state.items = await api("/api/items");
      renderItems();
    } catch (error) {
      logError("Không tải được công việc", error);
    }
  });
}

async function decide(button, item, input) {
  const command = await withBusy(button, async () => {
    try {
      return await api(`/api/issues/${item.number}/decisions`, input);
    } catch (error) {
      logError(`#${item.number} ${input.action} thất bại`, error);
      return null;
    }
  });
  if (!command) return;
  state.pending.set(item.number, input.action);
  renderItems();
  const update = log("pending", `#${item.number} ${input.action} đã gửi`, {
    code: command.command,
  });
  pollReply(item.number, command.commentId, input.action, update);
}

async function pollReply(issueNumber, commentId, action, update) {
  for (let attempt = 0; attempt < POLL_MAX; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    try {
      const reply = await api(`/api/issues/${issueNumber}/replies/${commentId}`);
      if (reply.status === "done") {
        update(
          reply.ok ? "ok" : "fail",
          `#${issueNumber} ${action}: ${reply.ok ? "đã ghi nhận" : "bị từ chối"}`,
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
  update("fail", `#${issueNumber} ${action}: chưa thấy phản hồi từ GitHub Actions`, {
    text: "Kiểm tra workflow huddle60 trong GitHub Actions, sau đó tải lại.",
  });
}

async function accept(button, item) {
  const builds = await withBusy(button, async () => {
    try {
      return await api("/api/builds");
    } catch (error) {
      logError("Không tải được danh sách build", error);
      return null;
    }
  });
  if (!builds) return;
  if (builds.length === 0) {
    await openDialog({
      title: `Nghiệm thu #${item.number}`,
      body: h(
        "p",
        {},
        `Chưa có build thành công trên ${state.session.defaultBranch}. Merge PR và chờ build hoàn tất.`,
      ),
    });
    return;
  }
  const list = h(
    "div",
    {},
    h("p", { class: "muted" }, "Chọn build đã chạy trên nhánh chính để nghiệm thu:"),
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
      title: `Nghiệm thu #${item.number} · ${displayTitle(item)}`,
      body: list,
      okLabel: "Accept",
    })) !== "ok"
  )
    return;
  const runId = Number(list.querySelector("input[name=build]:checked")?.value);
  await decide(button, item, { action: "accept", runId });
}

async function showContext(button, item) {
  const result = await withBusy(button, async () => {
    try {
      return await api(`/api/issues/${item.number}/context`);
    } catch (error) {
      logError(`#${item.number} context`, error);
      return null;
    }
  });
  if (!result) return;
  await openDialog({
    title: `Context #${item.number} · ${displayTitle(item)}`,
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

  $("#spec-input-title").value = "Đang tải...";
  $("#spec-input-body").value = "Đang tải dữ liệu từ GitHub...";
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
    logError(`Không tải được chi tiết #${item.number}`, error);
    $("#spec-input-body").value = `Lỗi tải: ${error.message}`;
  }
}

async function handleAiRefineSpec() {
  if (!editingSpecItem) return;
  const instruction = $("#spec-ai-instruction").value.trim();
  const feedback = $("#spec-ai-feedback");
  const button = $("#spec-btn-ai-refine");

  if (!instruction) {
    feedback.className = "test-msg err";
    feedback.textContent = "Vui lòng nhập yêu cầu chỉnh sửa cho AI.";
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
      feedback.textContent = `✨ AI đã cập nhật: ${result.summary || "Đã áp dụng các sửa đổi theo yêu cầu."}`;
      feedback.hidden = false;
    } catch (error) {
      feedback.className = "test-msg err";
      feedback.textContent = `Lỗi: ${error.message}`;
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
    status.textContent = "Tiêu đề không được để trống.";
    return;
  }

  status.className = "status-msg";
  status.textContent = "Đang lưu lên GitHub...";

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
      status.textContent = "Đã lưu thành công!";
      log("ok", `#${editingSpecItem.number} đã cập nhật đặc tả trên GitHub`);
      $("#spec-dialog").close();
      await loadItems();
    } catch (error) {
      status.className = "status-msg err";
      status.textContent = `Lỗi lưu: ${error.message}`;
      logError(`#${editingSpecItem.number} cập nhật đặc tả thất bại`, error);
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
        ? h("span", { class: "node-id" }, `Phụ thuộc: ${node.blockedBy.join(", ")}`)
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
    (byParent.get(node.localId) ?? []).map((child) => renderNode(child, byParent)),
  );
}

function fillList(selector, items) {
  const list = $(selector);
  list.replaceChildren(
    ...(items.length
      ? items.map((text) => h("li", {}, text))
      : [h("li", { class: "muted" }, "Không có")]),
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
  blocking.querySelector("ul").replaceChildren(...draft.blocking.map((text) => h("li", {}, text)));
  fillList(
    "#plan-open",
    plan.openQuestions.filter((q) => !q.blocking).map((q) => q.text),
  );
  fillList("#plan-assumptions", plan.assumptions);
  fillList("#plan-clarifications", draft.clarifications);

  const created = Boolean(draft.created);
  $("#refine-form").hidden = created;
  const createButton = $("#create-btn");
  const reasons = [];
  if (!hasRole("po")) reasons.push("Chỉ PO được tạo Issue");
  if (draft.blocking.length) reasons.push("Cần làm rõ câu hỏi chặn");
  createButton.disabled = reasons.length > 0;
  createButton.textContent = `Tạo ${plan.nodes.length} Issue`;
  $("#create-hint").textContent = reasons.join(" · ");

  const createdBox = $("#plan-created");
  createdBox.hidden = !created;
  if (created) {
    const links = [
      h(
        "li",
        {},
        "Yêu cầu ",
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

async function generatePlan(event) {
  event.preventDefault();
  const request = $("#plan-request").value;
  const title = $("#plan-title").value;
  const update = log("pending", "Đang tạo kế hoạch…");
  await withBusy($("#plan-generate"), async () => {
    try {
      state.draft = await api("/api/plans", { title, request });
      renderDraft();
      update(
        "ok",
        `Kế hoạch: ${state.draft.plan.nodes.length} công việc · ${state.draft.blocking.length} câu hỏi chặn`,
      );
    } catch (error) {
      update("fail", "Không thể tạo kế hoạch", { text: `${error.code ?? ""}: ${error.message}` });
    }
  });
}

async function refinePlan(event) {
  event.preventDefault();
  const clarification = $("#refine-text").value;
  const update = log("pending", "Đang cập nhật kế hoạch…");
  await withBusy($("#refine-btn"), async () => {
    try {
      state.draft = await api(`/api/plans/${state.draft.draftId}/refine`, { clarification });
      $("#refine-text").value = "";
      renderDraft();
      update(
        "ok",
        `Đã cập nhật: ${state.draft.plan.nodes.length} công việc · ${state.draft.blocking.length} câu hỏi chặn`,
      );
    } catch (error) {
      update("fail", "Không thể cập nhật kế hoạch", {
        text: `${error.code ?? ""}: ${error.message}`,
      });
    }
  });
}

async function createIssues() {
  const draft = state.draft;
  const confirm = await openDialog({
    title: "Tạo Issue trên GitHub",
    body: h(
      "p",
      {},
      `Tạo 1 yêu cầu và ${draft.plan.nodes.length} Issue trong ${state.session.repo.owner}/${state.session.repo.repo} bằng tài khoản ${state.session.viewer.login}.`,
    ),
    okLabel: "Tạo Issue",
  });
  if (confirm !== "ok") return;
  const update = log("pending", "Đang tạo Issue…");
  await withBusy($("#create-btn"), async () => {
    try {
      state.draft = await api(`/api/plans/${draft.draftId}/create`, {});
      renderDraft();
      update("ok", `Đã tạo ${Object.keys(state.draft.created.issues).length} Issue`);
      loadItems();
    } catch (error) {
      update("fail", "Tạo Issue chưa hoàn tất. Chọn Tạo Issue để tiếp tục.", {
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
    const data = await api("/api/settings");
    state.settings = data;

    // Repo
    $("#input-repo").value = data.repo || "";
    const sourceHints = {
      cli: "(Được truyền qua cờ dòng lệnh --repo)",
      git: "(Tự động nhận diện từ git remote local)",
      env: "(Lấy từ biến môi trường GITHUB_REPOSITORY)",
      config: "(Được lưu trong file cấu hình local)",
      none: "",
    };
    $("#repo-source-hint").textContent = sourceHints[data.repoSource] || "";

    // Recent repos chips
    const recentWrap = $("#recent-repos-wrap");
    const chipsContainer = $("#recent-repos-chips");
    const currentRepo = data.repo || "";
    const recentRepos = data.recentRepos || (currentRepo ? [currentRepo] : []);

    // Update datalist with user repos
    const datalist = $("#repo-datalist");
    if (datalist && state.userRepos.length > 0 && !datalist.children.length) {
      datalist.innerHTML = "";
      for (const r of state.userRepos) {
        const opt = document.createElement("option");
        opt.value = r.fullName;
        if (r.description) opt.label = r.description;
        datalist.appendChild(opt);
      }
    }

    if (recentRepos.length > 0) {
      recentWrap.hidden = false;
      chipsContainer.replaceChildren(
        ...recentRepos.map((r) => {
          const isActive = r === currentRepo;
          const chip = h(
            "div",
            { class: `recent-chip ${isActive ? "active" : ""}` },
            h(
              "span",
              {
                onclick: async () => {
                  if (r !== currentRepo) {
                    await switchRepository(r);
                  }
                },
              },
              `📁 ${r}`,
            ),
            h(
              "button",
              {
                class: "recent-chip-remove",
                title: "Xóa khỏi danh sách gần đây",
                onclick: async (e) => {
                  e.stopPropagation();
                  await removeRecentRepository(r);
                },
              },
              "✕",
            ),
          );
          return chip;
        }),
      );
    } else {
      recentWrap.hidden = true;
    }

    const repoBadge = $("#repo-status-badge");
    repoBadge.className = "badge";
    if (data.policyStatus === "ready") {
      repoBadge.classList.add("ok");
      repoBadge.textContent = "✓ Sẵn sàng (AI-DLC)";
    } else if (data.repo) {
      repoBadge.classList.add("warn");
      repoBadge.textContent = "Chưa khởi tạo policy";
    } else {
      repoBadge.classList.add("danger");
      repoBadge.textContent = "Chưa chọn repo";
    }

    $("#repo-init-card").hidden = !(
      data.hasGithubToken &&
      data.repo &&
      data.policyStatus !== "ready"
    );

    // GitHub
    const ghBadge = $("#github-status-badge");
    ghBadge.className = "badge";
    if (data.githubUser) {
      ghBadge.classList.add("ok");
      ghBadge.textContent = `✓ Đã kết nối (@${data.githubUser.login})`;
      $("#github-user-row").hidden = false;
      $("#github-user-login").textContent = `@${data.githubUser.login}`;
      $("#github-user-id").textContent = `ID: ${data.githubUser.id}`;
    } else if (data.hasGithubToken) {
      ghBadge.classList.add("warn");
      ghBadge.textContent = "Token đã cấu hình";
      $("#github-user-row").hidden = true;
    } else {
      ghBadge.classList.add("danger");
      ghBadge.textContent = "Chưa có token";
      $("#github-user-row").hidden = true;
    }

    if (data.githubTokenMasked) {
      $("#input-github-token").placeholder = `${data.githubTokenMasked} (để trống để giữ nguyên)`;
    }

    try {
      const authStatus = await api("/api/auth/status");
      const oauthSection = $("#github-oauth-section");
      if (oauthSection) {
        oauthSection.hidden = !authStatus.oauthEnabled || Boolean(data.githubUser);
      }
    } catch {}

    // Gemini
    const geminiBadge = $("#gemini-status-badge");
    geminiBadge.className = "badge";
    if (data.hasGeminiKey) {
      geminiBadge.classList.add("ok");
      geminiBadge.textContent = `✓ Sẵn sàng (${data.geminiModel})`;
      $("#input-gemini-key").placeholder = `${data.geminiKeyMasked} (để trống để giữ nguyên)`;
    } else {
      geminiBadge.classList.add("warn");
      geminiBadge.textContent = "Chưa có API key";
      $("#input-gemini-key").placeholder = "AQ.Ab8... hoặc AIzaSy... (để trống để tắt planner)";
    }

    if (data.geminiModel) {
      $("#select-gemini-model").value = data.geminiModel;
    }

    // Alert
    const alert = $("#settings-alert");
    if (data.status === "needs_setup") {
      alert.hidden = false;
      const reasons = [];
      if (data.missing.includes("missing_github_token"))
        reasons.push("Nhập Personal Access Token của GitHub");
      if (data.missing.includes("invalid_github_token"))
        reasons.push("GitHub Token không hợp lệ hoặc đã hết hạn");
      if (data.missing.includes("missing_repo"))
        reasons.push("Nhập tên Repository cần quản lý (owner/name)");
      if (data.missing.includes("repo_not_found"))
        reasons.push(
          "Không tìm thấy Repository trên GitHub hoặc tài khoản không có quyền truy cập",
        );
      if (data.missing.includes("missing_policy"))
        reasons.push("Repository chưa khởi tạo AI-DLC policy (bấm nút Khởi tạo bên dưới)");
      alert.innerHTML = `<strong>⚠️ Cần hoàn tất cấu hình để sử dụng:</strong><ul>${reasons.map((r) => `<li>${r}</li>`).join("")}</ul>`;
    } else {
      alert.hidden = true;
    }
  } catch (err) {
    log("fail", "Không thể tải cài đặt", { text: err.message });
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
        msgEl.textContent = `✓ Kết nối GitHub thành công: @${res.viewer.login} (ID: ${res.viewer.id})`;
      } else {
        msgEl.className = "test-msg err small";
        msgEl.textContent = `✗ Lỗi kiểm tra: ${res.error}`;
      }
    } catch (err) {
      msgEl.hidden = false;
      msgEl.className = "test-msg err small";
      msgEl.textContent = `✗ Lỗi: ${err.message}`;
    }
  });
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
        msgEl.textContent = `✓ Kết nối Gemini AI thành công (${modelVal})!`;
      } else {
        msgEl.className = "test-msg err small";
        msgEl.textContent = `✗ Lỗi kiểm tra: ${res.error}`;
      }
    } catch (err) {
      msgEl.hidden = false;
      msgEl.className = "test-msg err small";
      msgEl.textContent = `✗ Lỗi: ${err.message}`;
    }
  });
}

async function saveSettings() {
  const repo = $("#input-repo").value.trim();
  const githubToken = $("#input-github-token").value.trim();
  const geminiApiKey = $("#input-gemini-key").value.trim();
  const geminiModel = $("#select-gemini-model").value;
  const statusMsg = $("#save-status-msg");

  const patch = {};
  if (repo) patch.repo = repo;
  if (githubToken) patch.githubToken = githubToken;
  if (geminiApiKey) patch.geminiApiKey = geminiApiKey;
  if (geminiModel) patch.geminiModel = geminiModel;

  await withBusy($("#btn-save-settings"), async () => {
    try {
      await api("/api/settings", patch);
      $("#input-github-token").value = "";
      $("#input-gemini-key").value = "";
      statusMsg.className = "save-status-msg ok";
      statusMsg.textContent = "✓ Đã lưu cài đặt!";
      log("ok", "Đã cập nhật cài đặt hệ thống");
      await loadSettings();
      await syncSession();
    } catch (err) {
      statusMsg.className = "save-status-msg err";
      statusMsg.textContent = `✗ Lỗi khi lưu: ${err.message}`;
      log("fail", "Lưu cài đặt thất bại", { text: err.message });
    }
  });
}

async function initRepository() {
  const confirm = await openDialog({
    title: "Khởi tạo AI-DLC cho Repository",
    body: h(
      "p",
      {},
      "Thao tác này sẽ tạo nhãn huddle60:*, tạo nhánh huddle60-evidence và commit file policy vào default branch của repository.",
    ),
    okLabel: "Khởi tạo ngay",
  });
  if (confirm !== "ok") return;

  await withBusy($("#btn-init-repo"), async () => {
    const update = log("pending", "Đang khởi tạo Repository…");
    try {
      const res = await api("/api/repo/init", {});
      update("ok", res.message || "Khởi tạo thành công!");
      await loadSettings();
      await syncSession();
    } catch (err) {
      update("fail", "Khởi tạo thất bại", { text: err.message });
    }
  });
}

// ---------- boot ----------

function switchView(view) {
  for (const tab of document.querySelectorAll(".tab"))
    tab.classList.toggle("active", tab.dataset.view === view);
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
  try {
    log("pending", `Đang chuyển sang repository: ${repo}...`);
    await api("/api/settings", { repo });
    log("ok", `Đã chuyển sang repository: ${repo}`);
    await syncSession();
    if (state.session?.status === "ready") {
      await loadItems();
    } else {
      switchView("settings");
      await loadSettings();
    }
  } catch (err) {
    logError(`Chuyển sang ${repo} thất bại`, err);
  }
}

function renderRepoSwitcher() {
  const select = $("#repo-switcher-select");
  if (!select) return;
  const session = state.session || {};
  const currentRepoStr = session.repo ? `${session.repo.owner}/${session.repo.repo}` : "";
  const recentRepos = session.recentRepos || (currentRepoStr ? [currentRepoStr] : []);

  select.innerHTML = "";

  if (!currentRepoStr) {
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "Chưa chọn repo...";
    defaultOpt.selected = true;
    defaultOpt.disabled = true;
    select.appendChild(defaultOpt);
  }

  // 1. Recent repos group
  if (recentRepos.length > 0) {
    const recentGroup = document.createElement("optgroup");
    recentGroup.label = "🕒 Dự án gần đây";
    for (const r of recentRepos) {
      const opt = document.createElement("option");
      opt.value = r;
      opt.textContent = `📁 ${r}`;
      if (r === currentRepoStr) opt.selected = true;
      recentGroup.appendChild(opt);
    }
    select.appendChild(recentGroup);
  }

  // 2. All repositories from GitHub
  if (state.loadingRepos) {
    const loadingGroup = document.createElement("optgroup");
    loadingGroup.label = "📂 Tất cả Repositories (GitHub)";
    const loadingOpt = document.createElement("option");
    loadingOpt.disabled = true;
    loadingOpt.value = "";
    loadingOpt.textContent = "⏳ Đang tải tất cả repos từ GitHub...";
    loadingGroup.appendChild(loadingOpt);
    select.appendChild(loadingGroup);
  } else if (state.userRepos && state.userRepos.length > 0) {
    const allGroup = document.createElement("optgroup");
    allGroup.label = `📂 Tất cả Repositories (${state.userRepos.length})`;
    for (const r of state.userRepos) {
      const opt = document.createElement("option");
      opt.value = r.fullName;
      const icon = r.isPrivate ? "🔒" : "🌐";
      opt.textContent = `${icon} ${r.fullName}`;
      if (r.fullName === currentRepoStr) opt.selected = true;
      allGroup.appendChild(opt);
    }
    select.appendChild(allGroup);
  }

  // 3. Action options
  const actionGroup = document.createElement("optgroup");
  actionGroup.label = "Thao tác";

  const refreshOpt = document.createElement("option");
  refreshOpt.value = "__refresh__";
  refreshOpt.textContent = "🔄 Tải lại danh sách từ GitHub...";
  actionGroup.appendChild(refreshOpt);

  const addOpt = document.createElement("option");
  addOpt.value = "__add__";
  addOpt.textContent = "➕ Nhập repository khác...";
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
    logError(`Xóa ${repo} thất bại`, err);
  }
}

async function syncSession() {
  try {
    state.session = await api("/api/session");
  } catch (error) {
    fatal(
      error.code === "E_TOKEN"
        ? "Session token không hợp lệ (app đã khởi động lại?).\nMở URL mới trong terminal."
        : `${error.code ?? "E"}: ${error.message}`,
    );
    return;
  }

  const { session } = state;
  const isReady = session.status === "ready";

  const tenantBadge = $("#tenant-badge");
  if (tenantBadge) {
    if (session.tenant) {
      tenantBadge.textContent = session.tenant;
      tenantBadge.hidden = false;
    } else {
      tenantBadge.hidden = true;
    }
  }

  // Tabs enable/disable
  const itemsTab = document.querySelector('.tab[data-view="items"]');
  const planTab = document.querySelector('.tab[data-view="plan"]');
  if (itemsTab) itemsTab.disabled = !isReady;
  if (planTab) planTab.disabled = !isReady;

  // Render repo switcher dropdown with all repos
  renderRepoSwitcher();

  // If connected to GitHub and haven't fetched all repos yet, load in background
  if (
    (session.viewer || session.status === "ready") &&
    !state.userRepos.length &&
    !state.loadingRepos
  ) {
    loadUserRepos();
  }

  const repoGhLink = $("#repo-gh-link");
  if (repoGhLink) {
    if (session.repo) {
      repoGhLink.href = session.repo.url;
      repoGhLink.hidden = false;
    } else {
      repoGhLink.hidden = true;
    }
  }

  if (session.viewer) {
    $("#viewer").textContent = `@${session.viewer.login}`;
  } else {
    $("#viewer").textContent = "Chưa kết nối";
  }

  $("#roles").replaceChildren(
    ...(session.roles && session.roles.length
      ? session.roles.map((role) => h("span", { class: "badge story" }, role))
      : isReady
        ? [h("span", { class: "muted" }, "Chưa có vai trò")]
        : [h("span", { class: "badge warn" }, "Cần cài đặt")]),
  );

  const dot = $("#planner-status");
  dot.classList.toggle("on", Boolean(session.planner));
  dot.title = session.planner
    ? `planner: ${session.planner.model}`
    : "planner off (GEMINI_API_KEY)";

  if (!session.planner) {
    $("#plan-generate").disabled = true;
    $("#plan-hint").textContent = "Gemini chưa cấu hình: vào Cài đặt để thêm API Key";
  } else {
    $("#plan-generate").disabled = false;
    $("#plan-hint").textContent = "";
  }

  if (!isReady) {
    switchView("settings");
  } else {
    if (!hasRole("po") && !hasRole("dev")) {
      state.filter = "all";
      for (const chip of document.querySelectorAll("#filters .chip"))
        chip.classList.toggle("active", chip.dataset.filter === "all");
    }
    await loadItems();
  }
}

async function boot() {
  if (!token) {
    fatal("Thiếu session token.\nMở đúng URL mà lệnh `huddle60 ui` in ra trong terminal.");
    return;
  }

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
  $("#refresh").addEventListener("click", loadItems);
  $("#log-clear").addEventListener("click", () => $("#log").replaceChildren());
  $("#plan-form").addEventListener("submit", generatePlan);
  $("#refine-form").addEventListener("submit", refinePlan);
  $("#create-btn").addEventListener("click", createIssues);

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
      switchView("settings");
      $("#input-repo").focus();
      event.target.value = current;
      return;
    }
    if (value && value !== current) {
      await switchRepository(value);
    }
  });

  // Settings handlers
  $("#btn-test-github").addEventListener("click", testGithubToken);
  $("#btn-test-gemini").addEventListener("click", testGeminiKey);
  $("#btn-save-settings").addEventListener("click", saveSettings);
  $("#btn-init-repo").addEventListener("click", initRepository);

  // Spec editor handlers
  $("#spec-btn-ai-refine").addEventListener("click", handleAiRefineSpec);
  $("#spec-btn-save").addEventListener("click", handleSaveSpecChanges);
  $("#spec-btn-cancel").addEventListener("click", () => $("#spec-dialog").close());
  $("#spec-modal-close-x").addEventListener("click", () => $("#spec-dialog").close());

  await syncSession();
  if (state.session?.status === "ready") {
    log("ok", `Đã kết nối · @${state.session.viewer.login}`);
  }
}

boot();
