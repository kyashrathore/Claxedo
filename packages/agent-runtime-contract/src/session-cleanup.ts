export type SessionCleanupPosition = Readonly<{
  sessionId: string
  generation: number
  activitySequence: number
}>

export type SessionCleanupTarget = SessionCleanupPosition & Readonly<{
  workspaceId: string
  readerRevision: number
  descendants: readonly SessionCleanupPosition[]
}>

export type SessionCleanupCandidate = SessionCleanupTarget & Readonly<{
  title: string
  createdAt: number
  activityAt: number
  settledAt?: number
  seen: boolean
  settled: boolean
}>

export type SessionCleanupIncompleteSource = Readonly<{
  workspaceId?: string
  sessionId?: string
  reason: string
}>

export type SessionCleanupPage = Readonly<{
  candidates: readonly SessionCleanupCandidate[]
  incompleteSources: readonly SessionCleanupIncompleteSource[]
  nextCursor?: string
}>

export type SessionCleanupDeleteResult = Readonly<{
  sessionId: string
  workspaceId: string
}> & (
  | Readonly<{ status: "deleted"; deletedSessionIds: readonly string[] }>
  | Readonly<{ status: "failed"; code: string; message: string; deletedSessionIds?: readonly string[] }>
  | Readonly<{ status: "unknown"; code: "outcome_unknown"; message: string }>
)
