import type { AgentSessionStartBinding } from "@claxedo/agent-runtime-contract"
// The app's copy of the runtime's `SessionLifecycleEvent`
// (`workspace-runtime/src/routes/session-core.ts`), which crosses the wire on
// `wr/events`. A `creating`/`failed` frame is delivered to its creator only
// (`actorId`); the app matches it by `draftId`.
export type SessionLifecycleEvent = {
  type: "session.lifecycle"
  phase: "creating" | "created" | "failed"
  directory: string
  sessionID?: string
  start?: AgentSessionStartBinding
  workspaceId?: string
  draftId?: string
  actorId?: string
  info?: unknown
  message?: string
  ts: number
}
