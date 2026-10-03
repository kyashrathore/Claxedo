import type { SessionListSort, SessionOrderKey } from "../navigation-order"
import type { AgentTurnOutcome, SessionAttentionFacts, SessionReaderState } from "@claxedo/agent-runtime-contract"
import type { SessionReaderFilter } from "../navigation-reader"

export const GLOBAL_TAG = "global"
export const GLOBAL_SHOW_TAG = "global:default"

/** The attachment kinds a session can carry. The runtime list is what boundary parsers narrow against. */
export const SESSION_ATTACHMENT_KINDS = ["review", "page"] as const

export type SessionAttachment = {
  kind: (typeof SESSION_ATTACHMENT_KINDS)[number]
  targetID: string
}

export type SessionMeta = {
  sessionRef?: string
  sessionID: string
  workspaceID?: string
  projectID?: string
  host: "workspace"
  directory?: string
  model?: { providerID: string; modelID: string }
  title?: string
  parentID?: string
  rootID?: string
  archived?: number
  createdAt: number
  updatedAt: number
  attention?: SessionAttentionFacts
  lastTurn?: AgentTurnOutcome
  reader?: SessionReaderState
  /** When a human last started a turn here; absent when only agents ever have. */
  lastHumanTurnAt?: number
  tags: string[]
  attachments: SessionAttachment[]
}

export type SessionMetaNavigationListInput = SessionReaderFilter & {
  sessionID?: string
  readerId?: string
  /** Live runtimes this local navigation read admitted, determined before paging. */
  /** Canonical local workspace population for an all-workspace inventory source. */
  workspaceIDs?: readonly string[]
  excludeWorkspaces?: string[]
  workspaceID?: string
  directory?: string
  projectID?: string
  global?: boolean
  archived?: "active" | "all" | "archived"
  status?: string[]
  search?: string
  sort?: SessionListSort
  limit: number
  cursor?: SessionOrderKey
}
