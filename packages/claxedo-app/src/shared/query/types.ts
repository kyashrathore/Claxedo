import type { SessionTurnOutcome } from "../data/session-types"

export type ProjectMeta = {
  name?: string
  icon?: {
    override?: string
    color?: string
  }
  commands?: {
    start?: string
  }
}

export type SessionInventoryRow = {
  id: string
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
  archived?: boolean
  lastTurn?: SessionTurnOutcome
  time: { created: number; updated: number }
}

export type GlobalSessionItem = SessionInventoryRow
