import type {
  AgentAssistantMessage,
  AgentContentPart,
  AgentPresentationMessage,
  AgentUserMessage,
} from "@claxedo/agent-runtime-contract"

export type OptimisticUserMessage = {
  readonly origin: "optimistic"
  readonly id: string
  readonly role: "user"
  readonly time: { readonly created: number }
  readonly summary?: undefined
}

export type TranscriptUserMessage = AgentUserMessage | OptimisticUserMessage

export type TranscriptAssistantMessage = AgentAssistantMessage

export type ConversationMessage = AgentPresentationMessage | OptimisticUserMessage

export type TranscriptConversation = {
  readonly messages: ConversationMessage[]
  readonly parts: Record<string, AgentContentPart[]>
  readonly fragmentParts: ReadonlySet<string>
  readonly partsWithText: Readonly<Record<string, true>>
}

export function isRuntimeMessage(message: ConversationMessage): message is AgentPresentationMessage {
  return !("origin" in message)
}
