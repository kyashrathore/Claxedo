import type { SessionTurnOutcome } from "../session-types"

export type { ProjectMeta } from "@/platform/query/project-meta"

export type SessionOwner = {
  name?: string
  avatarUrl?: string
  publicId?: string
}

export type SessionInventoryRow = {
  id: string
  sessionRef?: string
  title: string
  directory: string
  workspaceId?: string
  workspaceName?: string
  projectID: string
  parentID?: string
  rootID?: string
  tags: string[]
  attachments: Array<{ kind: string; targetID: string }>
  environment?: { kind?: string; driver?: string }
  git?: { repo?: string; branch?: string; remote?: string }
  owner?: SessionOwner
  archived?: boolean
  lastTurn?: SessionTurnOutcome
  time: { created: number; updated: number }
}

export type GlobalSessionItem = SessionInventoryRow
