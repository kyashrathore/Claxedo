import type { AgentSession, SessionAttentionPage } from "@claxedo/agent-runtime-contract"

/** Read-only view of the committed sessions this runtime owns. */
export type WorkspaceSessionInventory = {
  sessions(): AgentSession[]
  /** Committed root-session tombstones in this workspace. */
  removed(): string[]
  session(sessionId: string): AgentSession | undefined
  attention(sessionId: string, after: number, limit: number): SessionAttentionPage
}
