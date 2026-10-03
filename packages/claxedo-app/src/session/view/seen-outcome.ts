import { sessionAttention, type SessionRow, type TranscriptMessage, type TranscriptPart } from "@/server"
import { assistantMessageSettled, partHasText } from "@claxedo/agent-runtime-contract/turn-fold"

type OutcomeTarget = { userMessageId: string } & (
  | { kind: "Error" | "TurnFold" }
  | { kind: "content"; messageId: string; partId: string }
)

export function displayedOutcome(row: SessionRow | undefined, messages: readonly TranscriptMessage[], parts: Readonly<Record<string, readonly TranscriptPart[]>>): { row: SessionRow; target: OutcomeTarget } | undefined {
  if (!row?.attention || !sessionAttention(row.attention, row.reader).unseen) return undefined
  const outcome = row.attention.outcome
  const turn = row.lastTurn
  if (!outcome || !turn || outcome.completedAt !== turn.completedAt || outcome.status !== turn.status) return undefined
  const assistant = messages.find((message) => message.id === turn.assistantMessageId)
  if (!assistant || assistant.role !== "assistant" || !assistant.parentID || !assistantMessageSettled(assistant)) return undefined
  const userMessageId = assistant.parentID
  if (outcome.status === "failed") return { row, target: { userMessageId, kind: "Error" } }
  const result = parts[assistant.id]?.findLast((part) => part.type === "text" && partHasText(part))
  return { row, target: result ? { userMessageId, kind: "content", messageId: assistant.id, partId: result.id } : { userMessageId, kind: "TurnFold" } }
}

export function outcomeTargetSelector(target: OutcomeTarget): string {
  const user = `[data-message-id="${CSS.escape(target.userMessageId)}"]`
  return target.kind === "content"
    ? `${user}[data-content-message-id="${CSS.escape(target.messageId)}"][data-content-part-id="${CSS.escape(target.partId)}"]`
    : `${user}[data-timeline-row="${target.kind}"]`
}
