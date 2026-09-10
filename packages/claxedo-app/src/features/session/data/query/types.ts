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
  time: {
    created: number
    updated: number
    /**
     * When a human last started a turn here — the rail bands on this rather than
     * `updated`, which any actor's turn advances. Absent for a session only agents
     * have driven, and for one that predates the field.
     */
    lastHumanTurn?: number
  }
}

export type GlobalSessionItem = SessionInventoryRow
