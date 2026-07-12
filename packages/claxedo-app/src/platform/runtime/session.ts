import type { Message, Part, Session, Todo } from "@opencode-ai/sdk/v2/client"
import type { SessionRef } from "@/platform/identity/session-ref"
import type { SessionTransportCapabilities } from "@/platform/runtime/capabilities"

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
  getSession: (input: { directory: string; sessionID: string; sessionRef?: SessionRef }) => Promise<{ data?: RuntimeSession }>
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
}
