import type { SessionInventoryRow, ProjectMeta } from "../../shared/query/types"
import type { ClaxedoSession } from "../../shared/data/session-types"

export type { SessionInventoryRow, ProjectMeta } from "../../shared/query/types"

export type SessionCacheValue = {
  at: number
  limit: number
  total: number
  session: ClaxedoSession[]
}

export type DirState = {
  lastAccessAt: number
}

export type EvictPlan = {
  stores: string[]
  state: Map<string, DirState>
  pins: Set<string>
  max: number
  ttl: number
  now: number
}

export type DisposeCheck = {
  directory: string
  hasStore: boolean
  pinned: boolean
  booting: boolean
  loadingSessions: boolean
}

export type WorkspaceGroup = {
  key?: string
  directory: string
  workspaceId?: string
  workspaceName?: string
  projectID: string
  sessions: SessionInventoryRow[]
  hasMore: boolean
  total: number
  nextCursor?: number
}

export const MAX_DIR_STORES = 30
export const DIR_IDLE_TTL_MS = 20 * 60 * 1000
export const SESSION_RECENT_WINDOW = 4 * 60 * 60 * 1000
export const SESSION_RECENT_LIMIT = 50
