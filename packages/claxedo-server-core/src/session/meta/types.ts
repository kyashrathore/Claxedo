import type { SessionLastTurn } from "@claxedo/agent-runtime-contract"
import type { SessionListSettledMode, SessionListSort, SessionOrderKey } from "../navigation-order"

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
  /** When a human last started a turn here; absent when only agents ever have. */
  lastHumanTurnAt?: number
  lastTurn?: SessionLastTurn
  tags: string[]
  attachments: SessionAttachment[]
}

export type SessionMetaNavigationListInput = {
  reader: string
  workspaceID?: string
  directory?: string
  projectID?: string
  sessionID?: string
  global?: boolean
  archived?: "active" | "all" | "archived"
  settled?: SessionListSettledMode
  status?: string[]
  search?: string
  sort?: SessionListSort
  limit: number
  cursor?: SessionOrderKey
}
