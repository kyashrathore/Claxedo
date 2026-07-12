export const GLOBAL_TAG = "global"
export const GLOBAL_SHOW_TAG = "global:default"

export type SessionAttachment = {
  kind: "review" | "page" | "planner"
  targetID: string
}

/**
 * First-class tools-only placement for a central/hybrid session. Persisted
 * verbatim so recovery reproduces the exact sandbox the session was created
 * with — including cases where the tool sandbox lives in a different workspace
 * than the session itself. Mirrors `SandboxRef` from `@claxedo/agent-sdk-runtime`.
 */
export type SessionToolSandbox =
  | { kind: "virtual"; id?: string }
  | { kind: "workspace-runtime"; workspaceId: string; directory?: string }

export type SessionMeta = {
  sessionRef?: string
  sessionID: string
  workspaceID?: string
  projectID?: string
  host: "central" | "workspace"
  directory?: string
  toolSandbox?: SessionToolSandbox
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
  limit: number
  cursor?: {
    updatedAt: number
    sessionID: string
    sessionRef?: string
  }
}
