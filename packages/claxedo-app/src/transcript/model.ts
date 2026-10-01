import type {
  AgentContentPart,
  AgentMessageAuthor,
  AgentPresentationMessage,
  AgentUserMessage,
} from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"

export function messageAuthor(message: { role: string; claxedo?: unknown }): AgentMessageAuthor | undefined {
  if (message.role !== "user") return undefined
  const author = asRecord(asRecord(message.claxedo)?.author)
  if (!author) return undefined
  if (typeof author.id !== "string" || typeof author.name !== "string") return undefined
  if (author.kind !== "human" && author.kind !== "agent") return undefined
  return {
    id: author.id,
    name: author.name,
    ...(typeof author.avatarUrl === "string" && author.avatarUrl ? { avatarUrl: author.avatarUrl } : {}),
    kind: author.kind,
  }
}

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
