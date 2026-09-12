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
  tags: string[]
  attachments: SessionAttachment[]
}

export type SessionMetaNavigationListInput = {
  workspaceID?: string
  directory?: string
  projectID?: string
  global?: boolean
  archived?: "active" | "all" | "archived"
  status?: string[]
  search?: string
  sort?: "updated_desc" | "created_desc" | "human_turn_desc"
  limit: number
  cursor?: {
    updatedAt: number
    createdAt?: number
    /** Absent when the cursor row has no human turn, which sorts it below every row that has one. */
    lastHumanTurnAt?: number
    sessionID: string
    sessionRef?: string
  }
}
