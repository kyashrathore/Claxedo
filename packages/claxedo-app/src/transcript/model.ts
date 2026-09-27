import type {
  AgentAssistantMessage,
  AgentContentPart,
  AgentPresentationMessage,
  AgentUserMessage,
} from "@claxedo/agent-runtime-contract"

export type OptimisticUserMessage = AgentUserMessage & {
  readonly origin: "optimistic"
  readonly parts: AgentContentPart[]
}

export type TranscriptUserMessage = AgentUserMessage | OptimisticUserMessage

export type TranscriptAssistantMessage = AgentAssistantMessage

export type ConversationMessage = AgentPresentationMessage | OptimisticUserMessage

export type TranscriptConversation = {
  readonly messages: ConversationMessage[]
  readonly parts: Record<string, AgentContentPart[]>
  readonly folded: ReadonlyMap<string, { readonly foldableCount: number }>
  readonly partsWithText: Readonly<Record<string, true>>
}
