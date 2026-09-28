import type {
  AgentContentPart,
  AgentPresentationMessage,
  AgentUserMessage,
} from "@claxedo/agent-runtime-contract"

export type OptimisticUserMessage = AgentUserMessage & {
  readonly origin: "optimistic"
  readonly parts: AgentContentPart[]
}

export type TranscriptUserMessage = AgentUserMessage | OptimisticUserMessage

export type ConversationMessage = AgentPresentationMessage | OptimisticUserMessage

export type TranscriptConversation = {
  readonly messages: ConversationMessage[]
  readonly parts: Record<string, AgentContentPart[]>
  readonly partsWithText: Readonly<Record<string, true>>
}
