import type {
  ActionDecision,
  ClarificationDecision,
  DecisionIntentKind,
  ExternalReference,
  IntakeActivity,
  IntakeActivityKind,
  IntakeItem,
  IntakeItemKind,
  IntakeItemStatus,
  LoadoutKind,
  LoadoutScopeType,
  LoadoutSlot,
  ReviewBatch,
  ReviewableDecision,
  ReviewableDecisionStatus,
} from "./types"

export interface IntakeItemRow {
  id: string
  kind: string
  title: string | null
  body_md: string
  status: string
  repo_ref: string | null
  triage_mode_override: string | null
  linked_session_id: string | null
  created_at: string
  updated_at: string
  last_triaged_at: string | null
}

export interface IntakeActivityRow {
  id: string
  intake_item_id: string
  kind: string
  actor: string
  payload_json: string
  created_at: string
}

export interface ExternalReferenceRow {
  id: string
  intake_item_id: string
  provider: string
  external_id: string
  external_url: string | null
  last_known_state_json: string | null
  created_at: string
}

export interface ReviewableDecisionRow {
  id: string
  kind: string
  intent_kind: string
  subject_type: string
  subject_id: string
  prompt_md: string
  recommended_intent_payload_json: string
  alternatives_json: string
  free_text_answer: string | null
  confidence: number
  evidence_md: string
  default_action: string
  auto_apply_allowed: number
  status: string
  batch_id: string | null
  created_by: string
  created_at: string
  resolved_at: string | null
}

export interface ReviewBatchRow {
  id: string
  submitted_by: string
  submitted_at: string | null
  created_at: string
}

export interface LoadoutSlotRow {
  id: string
  scope_type: string
  scope_id: string | null
  kind: string
  payload_json: string
  created_at: string
  updated_at: string
}

export function rowToIntakeItem(row: IntakeItemRow): IntakeItem {
  return {
    id: row.id,
    kind: row.kind as IntakeItemKind,
    title: row.title,
    bodyMd: row.body_md,
    status: row.status as IntakeItemStatus,
    repoRef: row.repo_ref,
    triageModeOverride: row.triage_mode_override,
    linkedSessionId: row.linked_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTriagedAt: row.last_triaged_at,
  }
}

export function intakeItemToRow(item: IntakeItem): IntakeItemRow {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    body_md: item.bodyMd,
    status: item.status,
    repo_ref: item.repoRef,
    triage_mode_override: item.triageModeOverride,
    linked_session_id: item.linkedSessionId,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    last_triaged_at: item.lastTriagedAt,
  }
}

export function rowToIntakeActivity(row: IntakeActivityRow): IntakeActivity {
  return {
    id: row.id,
    intakeItemId: row.intake_item_id,
    kind: row.kind as IntakeActivityKind,
    actor: row.actor,
    payload: parseObject(row.payload_json),
    createdAt: row.created_at,
  }
}

export function intakeActivityToRow(activity: IntakeActivity): IntakeActivityRow {
  return {
    id: activity.id,
    intake_item_id: activity.intakeItemId,
    kind: activity.kind,
    actor: activity.actor,
    payload_json: JSON.stringify(activity.payload),
    created_at: activity.createdAt,
  }
}

export function rowToExternalReference(row: ExternalReferenceRow): ExternalReference {
  return {
    id: row.id,
    intakeItemId: row.intake_item_id,
    provider: row.provider,
    externalId: row.external_id,
    externalUrl: row.external_url,
    lastKnownState: row.last_known_state_json ? parseObject(row.last_known_state_json) : null,
    createdAt: row.created_at,
  }
}

export function externalReferenceToRow(reference: ExternalReference): ExternalReferenceRow {
  return {
    id: reference.id,
    intake_item_id: reference.intakeItemId,
    provider: reference.provider,
    external_id: reference.externalId,
    external_url: reference.externalUrl,
    last_known_state_json: reference.lastKnownState ? JSON.stringify(reference.lastKnownState) : null,
    created_at: reference.createdAt,
  }
}

export function rowToReviewableDecision(row: ReviewableDecisionRow): ReviewableDecision {
  return {
    id: row.id,
    kind: row.kind as ReviewableDecision["kind"],
    intentKind: row.intent_kind as DecisionIntentKind,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    promptMd: row.prompt_md,
    recommendedIntentPayload: parseObject(row.recommended_intent_payload_json),
    alternatives: parseObjectArray(row.alternatives_json),
    freeTextAnswer: row.free_text_answer,
    confidence: row.confidence,
    evidenceMd: row.evidence_md,
    defaultAction: row.default_action,
    autoApplyAllowed: row.auto_apply_allowed === 1,
    status: row.status as ReviewableDecisionStatus,
    batchId: row.batch_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}

export function rowToClarificationDecision(row: ReviewableDecisionRow): ClarificationDecision {
  return { ...rowToReviewableDecision(row), kind: "clarification" }
}

export function rowToActionDecision(row: ReviewableDecisionRow): ActionDecision {
  return { ...rowToReviewableDecision(row), kind: "action" }
}

export function reviewableDecisionToRow(decision: ReviewableDecision): ReviewableDecisionRow {
  return {
    id: decision.id,
    kind: decision.kind,
    intent_kind: decision.intentKind,
    subject_type: decision.subjectType,
    subject_id: decision.subjectId,
    prompt_md: decision.promptMd,
    recommended_intent_payload_json: JSON.stringify(decision.recommendedIntentPayload),
    alternatives_json: JSON.stringify(decision.alternatives),
    free_text_answer: decision.freeTextAnswer,
    confidence: decision.confidence,
    evidence_md: decision.evidenceMd,
    default_action: decision.defaultAction,
    auto_apply_allowed: decision.autoApplyAllowed ? 1 : 0,
    status: decision.status,
    batch_id: decision.batchId,
    created_by: decision.createdBy,
    created_at: decision.createdAt,
    resolved_at: decision.resolvedAt,
  }
}

export function rowToReviewBatch(row: ReviewBatchRow): ReviewBatch {
  return {
    id: row.id,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
  }
}

export function reviewBatchToRow(batch: ReviewBatch): ReviewBatchRow {
  return {
    id: batch.id,
    submitted_by: batch.submittedBy,
    submitted_at: batch.submittedAt,
    created_at: batch.createdAt,
  }
}

export function rowToLoadoutSlot(row: LoadoutSlotRow): LoadoutSlot {
  return {
    id: row.id,
    scopeType: row.scope_type as LoadoutScopeType,
    scopeId: row.scope_id,
    kind: row.kind as LoadoutKind,
    payload: parseObject(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function loadoutSlotToRow(slot: LoadoutSlot): LoadoutSlotRow {
  return {
    id: slot.id,
    scope_type: slot.scopeType,
    scope_id: slot.scopeId,
    kind: slot.kind,
    payload_json: JSON.stringify(slot.payload),
    created_at: slot.createdAt,
    updated_at: slot.updatedAt,
  }
}

function parseObject(json: string): Record<string, unknown> {
  const parsed = JSON.parse(json) as unknown
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  throw new Error("expected JSON object")
}

function parseObjectArray(json: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(json) as unknown
  if (!Array.isArray(parsed)) throw new Error("expected JSON object array")
  return parsed.map((item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) return item as Record<string, unknown>
    throw new Error("expected JSON object array")
  })
}
