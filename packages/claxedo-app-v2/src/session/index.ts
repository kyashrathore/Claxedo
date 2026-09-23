import type { Accessor } from "solid-js"
import type {
  AgentRequest,
  AgentRequestReply,
  FileDiff,
  PromptInput,
  RequestId,
  SessionRef,
  SessionRow,
  SessionStatus,
  Todo,
  TranscriptMessage,
  TranscriptPart,
} from "@/server"

export type SessionRowView = SessionRow & {
  readonly status: SessionStatus
  readonly waitingOnUser: boolean
  readonly pending: boolean
}

export type SessionListState =
  | { readonly kind: "subscribing" }
  | { readonly kind: "fetching" }
  | { readonly kind: "live" }
  | { readonly kind: "rereading" }
  | { readonly kind: "failed"; readonly message: string }

export type SessionList = {
  readonly state: Accessor<SessionListState>
  readonly rows: Accessor<readonly SessionRowView[]>
  readonly hasMore: Accessor<boolean>
  readonly loadMore: () => Promise<void>
}

export type SessionLoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly message: string }

export type SessionView = {
  readonly ref: SessionRef
  readonly state: Accessor<SessionLoadState>
  readonly row: Accessor<SessionRow | undefined>
  readonly status: Accessor<SessionStatus>
  readonly messages: Accessor<readonly TranscriptMessage[]>
  readonly parts: (messageId: string) => readonly TranscriptPart[]
  readonly requests: Accessor<readonly AgentRequest[]>
  readonly todos: Accessor<readonly Todo[]>
  readonly diff: Accessor<readonly FileDiff[]>
  readonly hasOlder: Accessor<boolean>
  readonly loadOlder: () => Promise<void>
  readonly send: (input: PromptInput) => Promise<void>
  readonly stop: () => Promise<void>
  readonly reply: (requestId: RequestId, reply: AgentRequestReply) => Promise<void>
}

export type SessionStores = {
  readonly list: SessionList
  readonly open: (ref: SessionRef) => SessionView
}
