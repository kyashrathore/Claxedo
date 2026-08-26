import type { Message, Part, Session, Todo } from "@opencode-ai/sdk/v2/client"
import type { SessionRef } from "@/platform/identity/session-ref"
import type { SessionTransportCapabilities } from "@/platform/runtime/capabilities"
import type {
  AgentRuntimeDirectory,
  AgentRuntimePermissionModeState,
} from "@/platform/runtime/agent/agent-runtime-client"

export type SessionTurnOutcome = (
  | { status: "completed"; completedAt: number; reason?: string }
  | { status: "failed"; completedAt: number; error: string }
  | { status: "cancelled"; completedAt: number; reason?: string }
) & { assistantMessageId?: string }

export type RuntimeSession = Session & {
  status?: string | null
  recovery_error?: string | null
  lastTurn?: SessionTurnOutcome
}

export type SessionMessageRow = {
  info: Message
  parts?: Part[]
}

export type SessionMessagesPage = {
  data?: SessionMessageRow[]
  maxEventOrdinal: number
  response: Response
}

export type SessionBackend = {
  usesScopedTransport: (sessionID: string | undefined, directory?: string) => boolean
  getSession: (input: {
    directory: string
    sessionID: string
    sessionRef?: SessionRef
  }) => Promise<{ data?: RuntimeSession }>
  getCapabilities: (input: {
    directory: string
    sessionID?: string
    sessionRef?: SessionRef
  }) => Promise<SessionTransportCapabilities>
  listMessages: (input: {
    directory: string
    sessionID: string
    sessionRef?: SessionRef
    limit: number
    before?: string
  }) => Promise<SessionMessagesPage>
  listTodos: (input: { directory: string; sessionID: string; sessionRef?: SessionRef }) => Promise<{ data?: Todo[] }>
  /**
   * The harness's own permission modes for this session.
   *
   * Session-scoped rather than harness-scoped because the answer genuinely
   * differs per session: an ACP agent advertises its modes on `session/new`, and
   * `currentModeId` is whatever THAT conversation is running under.
   */
  getPermissionModes: (input: {
    directory: AgentRuntimeDirectory
    sessionID: string
    sessionRef?: SessionRef
    /**
     * The harness the caller is asking ABOUT. Load-bearing on a draft, where
     * there is no session for the route to resolve an adapter from: omit it and
     * the runtime answers for the directory's default harness instead of the
     * one the composer targets.
     */
    harness?: string
  }) => Promise<{ data?: AgentRuntimePermissionModeState }>
  setPermissionMode: (input: {
    directory: AgentRuntimeDirectory
    sessionID: string
    modeId: string
    sessionRef?: SessionRef
  }) => Promise<{ data?: AgentRuntimePermissionModeState }>
}
