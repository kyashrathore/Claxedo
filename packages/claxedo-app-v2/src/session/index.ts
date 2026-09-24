import type { Accessor } from "solid-js"
import type {
  AgentRequest,
  AgentRequestReply,
  AppError,
  FileDiff,
  GoalAction,
  PromptInput,
  RequestId,
  SessionCreateInput,
  SessionGoal,
  SessionRef,
  SessionRow,
  SessionStatus,
  Todo,
  TranscriptMessage,
  TranscriptPart,
} from "@/server"
import type { TranscriptConversation } from "@/transcript"
import type { SessionSubagent } from "./transcript/subagent-merge"
import type { QueuedMessages } from "./view/timeline/model"

export type SessionStatusView = SessionStatus | { readonly kind: "unknown" }

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
  readonly rows: Accessor<readonly SessionRowView[]>
  readonly hasMore: Accessor<boolean>
  readonly moreState: Accessor<LoadMoreState>
  readonly loadMore: () => Promise<void>
  readonly reload: () => Promise<void>
  readonly create: (input: SessionCreateInput) => Promise<SessionRef>
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

export type RequestState =
  | { readonly kind: "open" }
  | { readonly kind: "answering" }
  | { readonly kind: "answered" }
  | { readonly kind: "expired" }
  | { readonly kind: "failed"; readonly error: AppError }

export type SessionView = {
  readonly ref: SessionRef
  readonly state: Accessor<SessionLoadState>
  readonly row: Accessor<SessionRow | undefined>
  readonly status: Accessor<SessionStatusView>
  readonly messages: Accessor<readonly TranscriptMessage[]>
  readonly parts: (messageId: string) => readonly TranscriptPart[]
  readonly isPendingMessage: (messageId: string) => boolean
  readonly conversation: Accessor<TranscriptConversation | undefined>
  readonly turnSettlePending: (userMessageId: string) => boolean
  readonly queue: QueuedMessages
  readonly requests: Accessor<readonly AgentRequest[]>
  readonly requestState: (requestId: RequestId) => RequestState
  readonly todos: Accessor<readonly Todo[]>
  readonly diff: Accessor<readonly FileDiff[]>
  readonly subagents: Accessor<readonly SessionSubagent[]>
  readonly goal: Accessor<SessionGoal | undefined>
  readonly goalActions: Accessor<readonly GoalAction[]>
  readonly controlGoal: (action: GoalAction) => Promise<void>
  readonly hasOlder: Accessor<boolean>
  readonly olderState: Accessor<OlderState>
  readonly loadOlder: () => Promise<void>
  readonly reload: () => Promise<void>
  readonly send: (input: PromptInput) => Promise<void>
  readonly stop: () => Promise<void>
  readonly reply: (requestId: RequestId, reply: AgentRequestReply) => Promise<void>
}

export type { SessionSubagent }

export type SessionStores = {
  readonly list: SessionList
  readonly open: (ref: SessionRef) => SessionView
}

export { createSessionStores, SessionStoresProvider, useSessionStores } from "./store"
