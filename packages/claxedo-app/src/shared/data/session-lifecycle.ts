// Canonical `session.lifecycle` event envelope (rubric D4).
// Single source of truth for frontend consumers. The server's `bus.ts` keeps
// its own matching definition across the Bun/Node boundary.
export type SessionLifecycleEvent = {
  type: "session.lifecycle"
  phase: "creating" | "created" | "failed"
  directory: string
  sessionID?: string
  workspaceId?: string
  draftId?: string
  info?: unknown
  message?: string
  ts: number
}
