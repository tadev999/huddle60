import type { ModelPlan, PlanNode, PlanRecord } from "./plan.js";
import { blockingQuestions, creationOrder } from "./plan.js";
import { SECTIONS } from "./vocabulary.js";

/**
 * Model and user text is untrusted. Neutralize mentions, hidden HTML comments
 * (which could forge automation markers) and raw HTML before posting it.
 */
export function sanitize(text: string): string {
  return text
    .replace(/<!--/gu, "&lt;!--")
    .replace(/</gu, "&lt;")
    .replace(/(^|[^\w`])@(?=[\w-])/gu, "$1@\u200b")
    .replace(/^\/(?:huddle60|ai-dlc)/gmu, "\\/huddle60");
}

export function marker(name: string, value: string): string {
  return `<!-- huddle60:${name}:${value} -->`;
}

export function findMarker(body: string | null | undefined, name: string): string | null {
  const match = new RegExp(`<!-- (?:huddle60|ai-dlc):${name}:([^\\s>]+) -->`, "u").exec(body ?? "");
  return match ? (match[1] as string) : null;
}

export function planNodeMarker(planId: string, localId: string): string {
  return marker("plan-node", `${planId}/${localId}`);
}

const KIND_TITLE = { epic: "Epic", story: "Story", task: "Task" } as const;

export function bulletList(items: readonly string[], empty = "_(không có)_"): string {
  return items.length === 0 ? empty : items.map((item) => `- ${sanitize(item)}`).join("\n");
}

export function issueTitle(node: PlanNode): string {
  return `[${KIND_TITLE[node.kind]}] ${sanitize(node.title).replace(/\s+/gu, " ")}`;
}

/** Body of an Issue created from a plan. Headings match the Issue forms so the same parser applies. */
export function renderNodeBody(
  record: PlanRecord,
  node: PlanNode,
  numbers: ReadonlyMap<string, number>,
): string {
  const ref = (localId: string) => {
    const number = numbers.get(localId);
    if (number === undefined) throw new Error(`Issue number for ${localId} is not known yet`);
    return `#${number}`;
  };
  const scope = [
    ...node.scope.map((item) => `- Trong phạm vi: ${sanitize(item)}`),
    ...node.outOfScope.map((item) => `- Ngoài phạm vi: ${sanitize(item)}`),
  ];
  const sections: [string, string][] = [
    [SECTIONS.goal, sanitize(node.goal)],
    [SECTIONS.scope, scope.join("\n") || "_(chưa xác định)_"],
  ];
  if (node.kind !== "epic") {
    sections.push([SECTIONS.parent, node.parentLocalId ? ref(node.parentLocalId) : ""]);
    sections.push([SECTIONS.blockedBy, node.blockedBy.map(ref).join(", ")]);
  }
  if (node.kind === "epic") {
    sections.push([
      SECTIONS.epicCriteria,
      node.criteria.map((c) => `- ${c.id}: ${sanitize(c.text)}`).join("\n"),
    ]);
  } else if (node.kind === "story") {
    sections.push([
      SECTIONS.storyCriteria,
      node.criteria.map((c) => `- ${c.id}: ${sanitize(c.text)}`).join("\n"),
    ]);
  } else {
    sections.push([SECTIONS.acRefs, node.acRefs.join(", ")]);
  }
  sections.push([SECTIONS.technicalRefs, record.technicalRefs ?? ""]);
  sections.push([SECTIONS.risks, bulletList(node.riskNotes, "")]);

  const rendered = sections
    .map(([heading, value]) => `### ${heading}\n\n${value || "_No response_"}`)
    .join("\n\n");
  return [
    rendered,
    "",
    "---",
    `_Tạo từ kế hoạch \`${record.planId}\` cho request #${record.source.issueNumber} sau khi PO xác nhận. Nội dung do AI đề xuất; PO/DEV có thể chỉnh sửa trước khi chốt baseline._`,
    planNodeMarker(record.planId, node.localId),
  ].join("\n");
}

export function renderTree(plan: ModelPlan): string {
  const children = new Map<string | null, PlanNode[]>();
  for (const node of plan.nodes) {
    const list = children.get(node.parentLocalId) ?? [];
    list.push(node);
    children.set(node.parentLocalId, list);
  }
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const node of children.get(parent) ?? []) {
      const blocked =
        node.blockedBy.length > 0 ? ` _(blocked by ${node.blockedBy.join(", ")})_` : "";
      lines.push(
        `${"  ".repeat(depth)}- **${KIND_TITLE[node.kind]}** \`${node.localId}\`: ${sanitize(node.title)}${blocked}`,
      );
      const criteria =
        node.kind === "task"
          ? node.acRefs.map((id) => `${id}`)
          : node.criteria.map((c) => `${c.id}: ${sanitize(c.text)}`);
      for (const criterion of criteria) lines.push(`${"  ".repeat(depth + 1)}- ${criterion}`);
      walk(node.localId, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join("\n");
}

export function renderPlanComment(record: PlanRecord): string {
  const { plan } = record;
  const blocking = blockingQuestions(plan);
  const nonBlocking = plan.openQuestions
    .filter((question) => !question.blocking)
    .map((question) => question.text);
  const counts = (["epic", "story", "task"] as const)
    .map((kind) => [kind, plan.nodes.filter((node) => node.kind === kind).length] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${KIND_TITLE[kind]}`)
    .join(", ");
  const next =
    blocking.length > 0
      ? [
          "**Cần PO trả lời các câu hỏi chặn trước khi tạo Issues.** Trả lời bằng một comment mới:",
          "",
          "```text",
          `/huddle60 refine plan=${record.planId}`,
          "<câu trả lời của bạn, mỗi ý một dòng>",
          "```",
        ]
      : [
          "**Nếu đồng ý, PO xác nhận để App tạo các Issues:**",
          "",
          "```text",
          `/huddle60 create-plan plan=${record.planId} hash=${record.planHash}`,
          "```",
          "",
          `Muốn chỉnh sửa: \`/huddle60 refine plan=${record.planId}\` kèm yêu cầu ở các dòng tiếp theo.`,
        ];
  return [
    `## Kế hoạch đề xuất (revision ${record.revision})`,
    "",
    sanitize(plan.summary),
    "",
    `**Phạm vi:** ${counts}. Model: \`${record.model}\`.`,
    "",
    "### Cây công việc",
    "",
    renderTree(plan),
    "",
    "### Câu hỏi chặn",
    "",
    bulletList(blocking),
    "",
    "### Câu hỏi khác",
    "",
    bulletList(nonBlocking),
    "",
    "### Giả định cần xác nhận",
    "",
    bulletList(plan.assumptions),
    "",
    ...next,
    "",
    `<sub>Plan \`${record.planId}\` · hash \`${record.planHash}\` · hết hạn ${record.expiresAt.slice(0, 10)}. Đây là đề xuất của AI, chưa phải quyết định; chưa có Issue nào được tạo.</sub>`,
    marker("plan", record.planId),
  ].join("\n");
}

export function renderCreationSummary(
  record: PlanRecord,
  numbers: ReadonlyMap<string, number>,
  complete: boolean,
  failures: readonly string[],
): string {
  const lines = creationOrder(record.plan.nodes).map((node) => {
    const number = numbers.get(node.localId);
    return `- ${KIND_TITLE[node.kind]} \`${node.localId}\`: ${number ? `#${number}` : "_chưa tạo_"}`;
  });
  return [
    complete
      ? `## Đã tạo Issues từ \`${record.planId}\``
      : `## Tạo Issues chưa hoàn tất cho \`${record.planId}\``,
    "",
    ...lines,
    "",
    ...(failures.length > 0 ? ["**Lỗi:**", "", bulletList(failures), ""] : []),
    complete
      ? "Bước tiếp theo: PO ưu tiên trong Project; DEV review khả thi và chia việc; chốt baseline khi Story sẵn sàng (`/huddle60 baseline`)."
      : `Không xóa các Issue đã tạo. Thử lại an toàn bằng \`/huddle60 resume-plan plan=${record.planId}\`.`,
    marker("plan-result", record.planId),
  ].join("\n");
}
