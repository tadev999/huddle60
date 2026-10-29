/**
 * Labels and Issue form headings are part of the public contract: the parser
 * reads them back from Issues. Renaming one is a breaking change.
 */
export const LABELS = {
  request: "ai-dlc:request",
  planDraft: "ai-dlc:plan-draft",
  planCreated: "ai-dlc:plan-created",
  planPartial: "ai-dlc:plan-partial",
  fromPlan: "ai-dlc:from-plan",
  stale: "ai-dlc:stale",
  exempt: "ai-dlc:exempt",
  epic: "type:epic",
  story: "type:story",
  task: "type:task",
} as const;

export type WorkItemKind = "epic" | "story" | "task";

export const KIND_LABEL: Record<WorkItemKind, string> = {
  epic: LABELS.epic,
  story: LABELS.story,
  task: LABELS.task,
};

export const SECTIONS = {
  request: "Yêu cầu",
  goal: "Mục tiêu và người dùng",
  scope: "Phạm vi",
  parent: "Issue cha",
  blockedBy: "Blocked by",
  epicCriteria: "Tiêu chí nghiệm thu Epic",
  storyCriteria: "Acceptance Criteria",
  acRefs: "AC liên quan",
  technicalRefs: "Tham chiếu kỹ thuật",
  risks: "Câu hỏi và rủi ro",
} as const;

/** Sections that belong to the requirement content of each kind and therefore to its hash. */
export const REQUIREMENT_SECTIONS: Record<WorkItemKind, readonly string[]> = {
  epic: [
    SECTIONS.goal,
    SECTIONS.scope,
    SECTIONS.epicCriteria,
    SECTIONS.technicalRefs,
    SECTIONS.risks,
  ],
  story: [
    SECTIONS.goal,
    SECTIONS.scope,
    SECTIONS.parent,
    SECTIONS.blockedBy,
    SECTIONS.storyCriteria,
    SECTIONS.technicalRefs,
    SECTIONS.risks,
  ],
  task: [
    SECTIONS.goal,
    SECTIONS.scope,
    SECTIONS.parent,
    SECTIONS.blockedBy,
    SECTIONS.acRefs,
    SECTIONS.technicalRefs,
    SECTIONS.risks,
  ],
};

export const CRITERIA_SECTION: Record<WorkItemKind, string | null> = {
  epic: SECTIONS.epicCriteria,
  story: SECTIONS.storyCriteria,
  task: null,
};

export function kindFromLabels(labels: readonly string[]): WorkItemKind | null {
  const kinds = (Object.keys(KIND_LABEL) as WorkItemKind[]).filter((kind) =>
    labels.includes(KIND_LABEL[kind]),
  );
  return kinds.length === 1 ? (kinds[0] as WorkItemKind) : null;
}
