export interface WorkItem {
  id: string
  title: string
  description: string
  status: "open" | "in_progress" | "done"
  labels: string[]
  context?: string
  provider?: string
  providerMeta?: Record<string, any>
  providerUrl?: string
  createdAt: string
  updatedAt: string
}

export interface WorkEdge {
  source: string
  target: string
}

export type ScratchpadPriority = "fyi" | "blocking" | "scope_change"

export interface ScratchpadEntry {
  id: string
  workItemId: string
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

export interface WorkGraphState {
  items: Record<string, WorkItem>
  edges: WorkEdge[]
  scratchpads: ScratchpadEntry[]
}
