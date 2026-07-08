export type SourceKind =
  | "spec"
  | "doc"
  | "markdown"
  | "task"
  | "issue"
  | "template_instance"
  | "recurring_trigger"

export interface RunSource {
  run_id: string
  kind: SourceKind
  title: string
  content: string
  source_path: string | null
  created_at: string
}

export interface RunSourceInput {
  kind: SourceKind
  title: string
  content: string
  source_path?: string
}

export type WorkNodeType = "task" | "mission" | "synthesis"

export interface WorkItem {
  id: string
  sourceId?: string
  parentId?: string | null
  repoRef?: string | null
  repoLabel?: string | null
  title: string
  description: string
  nodeType: WorkNodeType
  status: "open" | "in_progress" | "done"
  archivedAt?: string
  archivedReason?: string
  deletedAt?: string
  deletedReason?: string
  labels: string[]
  context?: string
  provider?: string
  providerMeta?: Record<string, unknown>
  providerUrl?: string
  createdAt: string
  updatedAt: string
}

export interface WorkEdge {
  source: string
  target: string
}

export type ScratchpadPriority = "fyi" | "blocking" | "scope_change"
export type ScratchpadKind = "triage" | "executor"
export type ScratchpadSubjectType = "run_node" | "intake_item"

export interface ScratchpadEntry {
  id: string
  subjectType: ScratchpadSubjectType
  subjectId: string
  workItemId: string
  agentRunId?: string
  kind: ScratchpadKind
  content: string
  priority: ScratchpadPriority
  needsReview: boolean
  promotedToItemId?: string
  dismissedAt?: string
  actor: string
  createdAt: string
}

export interface WorkEvent {
  id: string
  seq: number
  type: WorkEventType
  payload: string
  actor: string
  createdAt: string
}

export type WorkEventType =
  | "item_created"
  | "item_updated"
  | "item_removed"
  | "edge_added"
  | "edge_removed"
  | "item_hydrated"
  | "item_synced"
  | "scratchpad_written"
  | "scratchpad_promoted"
  | "scratchpad_dismissed"
  | "intake_item_created"
  | "intake_item_updated"
  | "intake_activity_appended"
  | "external_reference_linked"
  | "external_reference_unlinked"
  | "decision_created"
  | "decision_resolved"
  | "decision_snoozed"
  | "decision_expired"
  | "review_batch_submitted"
  | "loadout_slot_set"
  | "loadout_slot_cleared"
  | "captain_proposed"
  | "captain_failed"

export type IntakeItemKind = "manual" | "external"
export type IntakeItemStatus = "captured" | "triaging" | "triaged" | "archived"
export type IntakeActivityKind =
  | "capture"
  | "triage_failed"
  | "external_edit"
  | "external_status_change"
  | "external_comment"
  | "retriage_request"
  | "human_edit"

export interface IntakeItem {
  id: string
  kind: IntakeItemKind
  title: string | null
  bodyMd: string
  status: IntakeItemStatus
  repoRef: string | null
  triageModeOverride: string | null
  linkedSessionId: string | null
  createdAt: string
  updatedAt: string
  lastTriagedAt: string | null
}

export interface IntakeActivity {
  id: string
  intakeItemId: string
  kind: IntakeActivityKind
  actor: string
  payload: Record<string, unknown>
  createdAt: string
}

export interface ExternalReference {
  id: string
  intakeItemId: string
  provider: string
  externalId: string
  externalUrl: string | null
  lastKnownState: Record<string, unknown> | null
  createdAt: string
}

export type DecisionKind = "clarification" | "action"
export type DecisionIntentKind =
  | "add_node"
  | "add_edge"
  | "remove_edge"
  | "update_status"
  | "delete_node"
  | "merge_nodes"
  | "split_node"
  | "reparent_node"
  | "update_loadout"
  | "sync_source"
export type ReviewableDecisionStatus = "open" | "applied" | "rejected" | "snoozed" | "expired" | "superseded"

export interface ReviewableDecision {
  id: string
  kind: DecisionKind
  intentKind: DecisionIntentKind
  subjectType: string
  subjectId: string
  promptMd: string
  recommendedIntentPayload: Record<string, unknown>
  alternatives: Array<Record<string, unknown>>
  freeTextAnswer: string | null
  confidence: number
  evidenceMd: string
  defaultAction: string
  autoApplyAllowed: boolean
  status: ReviewableDecisionStatus
  batchId: string | null
  createdBy: string
  createdAt: string
  resolvedAt: string | null
}

export interface ClarificationDecision extends ReviewableDecision {
  kind: "clarification"
}

export interface ActionDecision extends ReviewableDecision {
  kind: "action"
}

export interface ReviewBatch {
  id: string
  submittedBy: string
  submittedAt: string | null
  createdAt: string
}

export type LoadoutKind =
  | "triage_mode"
  | "model"
  | "harness"
  | "role"
  | "source_context"
  | "memory_provider"
  | "auto_policy"
export type LoadoutScopeType =
  | "intake_item"
  | "work_item"
  | "mission"
  | "repo"
  | "role"
  | "source_adapter"
  | "task_kind"
  | "system"

export interface LoadoutSlot {
  id: string
  scopeType: LoadoutScopeType
  scopeId: string | null
  kind: LoadoutKind
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface Provenance {
  actor: "triage" | "executor" | "captain" | "human" | "system"
  at: string
  confidence: number | null
  evidence: string | null
  sourceIntakeItemId: string | null
  firedRuleId: string | null
}

export interface WorkGraphState {
  items: Record<string, WorkItem>
  edges: WorkEdge[]
  scratchpads: ScratchpadEntry[]
  intakeItems: Record<string, IntakeItem>
  intakeActivities: IntakeActivity[]
  externalReferences: Record<string, ExternalReference>
  decisions: Record<string, ReviewableDecision>
  batches: Record<string, ReviewBatch>
  loadoutSlots: Record<string, LoadoutSlot>
}
