export const GLOBAL_TAG = "global"
export const GLOBAL_SHOW_TAG = "global:default"

export type SessionAttachment = {
  kind: "review" | "page"
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
  limit: number
  cursor?: {
    updatedAt: number
    createdAt?: number
    sessionID: string
    sessionRef?: string
  }
}
