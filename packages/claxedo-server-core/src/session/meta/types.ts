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
  sort?: "updated_desc" | "created_desc"
  /**
   * Which side of the staleness boundary to return. `active` is every session a human
   * started a turn in since the cutoff, `settled` the rest — the two bands the session
   * list renders. The caller passes one cutoff for every page of a listing, so a row
   * cannot change band between page one and page two.
   */
  band?: { side: "active" | "settled"; humanTurnSince: number }
  limit: number
  cursor?: {
    updatedAt: number
    createdAt?: number
    sessionID: string
    sessionRef?: string
  }
}
