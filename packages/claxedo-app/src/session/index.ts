import type { Accessor } from "solid-js"
import type {
  AgentRequest,
  AgentRequestReply,
  AppError,
  BackgroundWork,
  FileDiff,
  GoalAction,
  ProjectId,
  PromptInput,
  RequestId,
  SessionCreateInput,
  SessionGoal,
  SessionId,
  SessionOutline,
  SessionLocation,
  SessionRow,
  SessionStatus,
  Todo,
  TranscriptMessage,
  TranscriptPart,
} from "@/server"
import type { TranscriptConversation } from "@/transcript"
import type { TranscriptViewport } from "./transcript-viewport"
import type { SessionSubagent } from "./transcript/subagent-merge"
import type { QueuedMessages } from "./view/timeline/model"

export type SessionStatusView = SessionStatus | { readonly kind: "unknown" }

export type SentPrompt = PromptInput & { readonly messageId: string; readonly sentAt: number }

export type SessionRowView = SessionRow & {
  readonly status: SessionStatusView
  readonly waitingOnUser: boolean
  readonly pending: boolean
}

export type SessionListState =
  | { readonly kind: "subscribing" }
  | { readonly kind: "fetching" }
  | { readonly kind: "live" }
  | { readonly kind: "rereading" }
  | { readonly kind: "failed"; readonly message: string; readonly error: AppError }

export type LoadMoreState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly error: AppError }

export type SessionList = {
  readonly state: Accessor<SessionListState>
  readonly order: Accessor<readonly SessionLocation[]>
  readonly view: (sessionId: SessionId) => SessionRowView | undefined
  readonly rowOf: (sessionId: SessionId) => SessionRow | undefined
  readonly hasMore: (projectId: ProjectId) => boolean
  readonly moreState: (projectId: ProjectId) => LoadMoreState
  readonly pageFailure: (projectId: ProjectId) => AppError | undefined
  readonly pageDegraded: (projectId: ProjectId) => boolean
  readonly loadMore: (projectId: ProjectId) => Promise<void>
  readonly reload: () => Promise<void>
  readonly create: (input: SessionCreateInput) => Promise<SessionLocation>
}

export type SessionLoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly message: string; readonly error: AppError }

export type OlderState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly error: AppError }

export type OutlineState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly outline: SessionOutline }
  | { readonly kind: "unavailable" }

export type RequestState =
  | { readonly kind: "open" }
  | { readonly kind: "answering" }
  | { readonly kind: "answered" }
  | { readonly kind: "expired" }
  | { readonly kind: "failed"; readonly error: AppError }

export type SessionView = {
  readonly ref: SessionLocation
  readonly state: Accessor<SessionLoadState>
  readonly row: Accessor<SessionRow | undefined>
  readonly status: Accessor<SessionStatusView>
  readonly backgroundWork: Accessor<BackgroundWork>
  readonly messages: Accessor<readonly TranscriptMessage[]>
  readonly parts: (messageId: string) => readonly TranscriptPart[]
  readonly pendingDeltas: Accessor<boolean>
  readonly commitDeltas: () => void
  readonly conversation: Accessor<TranscriptConversation | undefined>
  readonly turnSettlePending: (userMessageId: string) => boolean
  readonly queue: QueuedMessages
  readonly replaceQueued: (seq: number, input: PromptInput) => Promise<boolean>
  readonly requests: Accessor<readonly AgentRequest[]>
  readonly requestsError: Accessor<AppError | undefined>
  readonly requestState: (requestId: RequestId) => RequestState
  readonly todos: Accessor<readonly Todo[]>
  readonly diff: Accessor<readonly FileDiff[]>
  readonly subagents: Accessor<readonly SessionSubagent[]>
  readonly goal: Accessor<SessionGoal | undefined>
  readonly goalActions: Accessor<readonly GoalAction[]>
  readonly goalAvailable: Accessor<boolean | undefined>
  readonly controlGoal: (action: GoalAction) => Promise<void>
  readonly hasOlder: Accessor<boolean>
  readonly olderState: Accessor<OlderState>
  readonly outline: Accessor<OutlineState>
  readonly loadOlder: () => Promise<void>
  readonly loadPart: (messageId: string, partId: string) => Promise<void>
  readonly reload: () => Promise<void>
  readonly send: (input: PromptInput) => Promise<void>
  readonly showSent: (prompt: SentPrompt) => void
  readonly stop: () => Promise<void>
  readonly reply: (requestId: RequestId, reply: AgentRequestReply) => Promise<void>
}

export type { SessionSubagent }

export type SessionStores = {
  readonly list: SessionList
  readonly unseenFailures: {
    readonly has: (sessionId: SessionId) => boolean
    readonly raised: (sessionId: SessionId) => void
    readonly seen: (sessionId: SessionId) => void
  }
  readonly open: (ref: SessionLocation) => SessionView
  readonly recordViewport: (viewport: TranscriptViewport) => void
}

export { SessionStoresProvider, useSessionStores } from "./store/provider"
export { sessionActivity, type SessionActivity } from "./list/activity"
export { draftSessionPaneKind, sessionPaneKind, subagentPanelView } from "./view"
