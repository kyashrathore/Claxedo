import type {
  AgentPartInput,
  FilePartInput,
  Message,
  OutputFormat,
  Part,
  Session,
  TextPartInput,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import type { AgentRuntimeDirectory } from "@/platform/runtime/agent/agent-runtime-urls"
import type { SessionRef } from "@/platform/identity/session-ref"
import type { SessionTransportCapabilities } from "@/platform/runtime/capabilities"
import type { AgentRuntimeGoalMutationResult } from "@/platform/runtime/agent/agent-runtime-client"
import type { AgentRuntimeGoalState } from "@/platform/runtime/agent/agent-runtime-goal-client"

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

export type SessionMessageView = "latest-turn" | "latest-surface"

export type SessionMessagePageRequest =
  | {
      view: SessionMessageView
      limit?: never
      before?: never
    }
  | {
      view?: never
      limit: number
      before?: string
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
    harness?: string
    sessionRef?: SessionRef
    signal?: AbortSignal
  }) => Promise<SessionTransportCapabilities>
  /**
   * The session's Goal capabilities AND its current Goal, in ONE round-trip.
   *
   * Every activation needs both, and the runtime has to derive the capabilities
   * to answer either, so the backend exposes only the combined read rather than
   * two endpoints a caller would always have to chain.
   */
  getGoalState: (input: {
    directory: AgentRuntimeDirectory
    sessionID: string
    sessionRef?: SessionRef
    signal?: AbortSignal
  }) => Promise<AgentRuntimeGoalState>
  startGoal: (input: {
    directory: AgentRuntimeDirectory
    sessionID: string
    objective: string
    sessionRef?: SessionRef
    signal?: AbortSignal
  }) => Promise<AgentRuntimeGoalMutationResult>
  pauseGoal: (input: { directory: AgentRuntimeDirectory; sessionID: string; sessionRef?: SessionRef; signal?: AbortSignal }) => Promise<AgentRuntimeGoalMutationResult>
  resumeGoal: (input: { directory: AgentRuntimeDirectory; sessionID: string; sessionRef?: SessionRef; signal?: AbortSignal }) => Promise<AgentRuntimeGoalMutationResult>
  stopGoal: (input: { directory: AgentRuntimeDirectory; sessionID: string; sessionRef?: SessionRef; signal?: AbortSignal }) => Promise<AgentRuntimeGoalMutationResult>
  deleteGoal: (input: { directory: AgentRuntimeDirectory; sessionID: string; sessionRef?: SessionRef; signal?: AbortSignal }) => Promise<AgentRuntimeGoalMutationResult>
  listMessages: (input: {
    directory: string
    sessionID: string
    sessionRef?: SessionRef
    signal?: AbortSignal
  } & SessionMessagePageRequest) => Promise<SessionMessagesPage>
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

/**
 * One permission mode as the harness describes it.
 *
 * Declared here rather than imported from `@claxedo/agent-sdk-runtime` because
 * this is a WIRE shape — what the route actually serialises — and the app must
 * keep parsing it even when the runtime package moves ahead of the client.
 * `packages/claxedo-app/src/features/session/permission/modes.test.ts` pins it
 * against the runtime's own declaration so the two cannot drift unnoticed.
 */
export type AgentRuntimePermissionMode = {
  id: string
  name: string
  description?: string
  level?: "ask" | "auto" | "full"
}
export type AgentRuntimePermissionModeState = {
  modes: AgentRuntimePermissionMode[]
  currentModeId?: string
  unsupported?: string
  appliesFrom: "next-turn" | "next-session"
}

export type AgentRuntimeMessageRow = {
  info: Message
  parts?: Part[]
}

export type AgentRuntimeMessagesPage = {
  data?: AgentRuntimeMessageRow[]
  maxEventOrdinal: number
  response: Response
}

/**
 * A workspace directory as the runtime transport addresses it.
 * Exported so callers can name the concept instead of writing a bare string
 * parameter. Directory-string-shape routing is this codebase's largest single
 * piece of debt, and the architecture ratchet counts every new raw string
 * directory parameter; naming the type is the direction out of that debt, not a
 * way around the count.
 * (Written without the raw declaration spelled out, because the ratchet matches
 * on text and would count this comment as another offender.)
 */
export type AgentRuntimePromptPayload = {
  sessionID: string
  directory: AgentRuntimeDirectory
  agent: string
  model: { providerID: string; modelID: string }
  messageID: string
  parts: Array<(TextPartInput | FilePartInput | AgentPartInput) & { id: string }>
  variant?: string
  system?: string
  format?: OutputFormat
  /**
   * The permission mode this turn should run under, applied by the runtime
   * BEFORE the prompt reaches the harness.
   *
   * On the prompt rather than a separate call because of the FIRST turn: the
   * session is created by this very message, so a mode chosen in the composer
   * beforehand has no session to be written to yet. Sending it here is the only
   * way a user's choice can govern the opening turn instead of arriving after
   * the agent has already acted.
   */
  permissionMode?: string
}
