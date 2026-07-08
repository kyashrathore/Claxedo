import type { DecisionIntentKind, LoadoutKind, LoadoutScopeType, WorkItem } from "./types"

interface BaseIntent {
  intentKind: DecisionIntentKind
  subjectType: string
  subjectId: string
  confidence: number
  evidenceMd: string
  classification?: string
}

export interface AddNodeIntent extends BaseIntent {
  intentKind: "add_node"
  title: string
  description?: string
  parentId?: string | null
  labels?: string[]
  nodeType?: WorkItem["nodeType"]
}

export interface AddEdgeIntent extends BaseIntent {
  intentKind: "add_edge"
  source: string
  target: string
}

export interface RemoveEdgeIntent extends BaseIntent {
  intentKind: "remove_edge"
  source: string
  target: string
  inFlight?: boolean
}

export interface UpdateStatusIntent extends BaseIntent {
  intentKind: "update_status"
  nodeId: string
  status: WorkItem["status"]
}

export interface DeleteNodeIntent extends BaseIntent {
  intentKind: "delete_node"
  nodeId: string
}

export interface MergeNodesIntent extends BaseIntent {
  intentKind: "merge_nodes"
  sourceNodeIds: string[]
  targetNodeId: string
}

export interface SplitNodeIntent extends BaseIntent {
  intentKind: "split_node"
  nodeId: string
  newNodes?: Array<{ title: string; description?: string }>
}

export interface ReparentNodeIntent extends BaseIntent {
  intentKind: "reparent_node"
  nodeId: string
  parentId: string | null
}

export interface UpdateLoadoutIntent extends BaseIntent {
  intentKind: "update_loadout"
  scopeType: LoadoutScopeType
  scopeId: string | null
  loadoutKind: LoadoutKind
  payload: Record<string, unknown>
  previousPayload?: Record<string, unknown> | null
  broadScope?: boolean
}

export interface SyncSourceIntent extends BaseIntent {
  intentKind: "sync_source"
  sourceId?: string
  externalReferenceId?: string
  hardToUndo?: boolean
}

export type Intent =
  | AddNodeIntent
  | AddEdgeIntent
  | RemoveEdgeIntent
  | UpdateStatusIntent
  | DeleteNodeIntent
  | MergeNodesIntent
  | SplitNodeIntent
  | ReparentNodeIntent
  | UpdateLoadoutIntent
  | SyncSourceIntent

export interface RuleCondition {
  intentKind?: DecisionIntentKind | DecisionIntentKind[]
  subjectType?: string
  classification?: string
  minConfidence?: number
  maxConfidence?: number
  inFlight?: boolean
  broadScope?: boolean
  hardToUndo?: boolean
}

export interface RuleAction {
  outcome: "apply" | "clarification" | "action"
  promptMd?: string
  defaultAction?: string
}

export interface Rule {
  id: string
  condition: RuleCondition
  action: RuleAction
}

export interface RouteContext {
  confidenceFloor?: number
}

export interface PolicyDecision {
  kind: "clarification" | "action"
  intentKind: DecisionIntentKind
  subjectType: string
  subjectId: string
  promptMd: string
  recommendedIntentPayload: Intent
  alternatives: Intent[]
  confidence: number
  evidenceMd: string
  defaultAction: string
  autoApplyAllowed: boolean
}

export type RouteOutcome =
  | {
    outcome: "apply"
    firedRuleId: string
    intent: Intent
  }
  | {
    outcome: "clarification"
    firedRuleId: string
    decision: PolicyDecision
  }
  | {
    outcome: "action"
    firedRuleId: string
    decision: PolicyDecision
  }
