import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import { asRecord } from "@claxedo/helpers/guards"
import { OpenCodeServerAdapterError } from "./errors"
import { OpenCodeEventTranslator, errorText, type OpenCodeLeafEvent } from "./translate"

// OpenCode orders messages by their ID, including when deciding whether the
// latest user prompt has been answered. Its schema permits any msg-prefixed ID.
// Extending the latest remote ID sorts after existing history and before the
// next native timestamp/counter ID, without depending on the client's clock.
function messageId(ids: string[]) {
  const latest = ids.reduce((max, id) => id > max ? id : max, "msg_00000000000000000000000000")
  const prior = /^(msg.+)~claxedo-([0-9a-f]{8})-[0-9a-f]{32}$/.exec(latest)
  const sequence = prior ? Number.parseInt(prior[2]!, 16) + 1 : 0
  if (sequence > 0xffffffff) throw new OpenCodeServerAdapterError("invalid_response", "OpenCode prompt ordering sequence exhausted")
  // Repeated user-only/aborted turns increment in place rather than growing IDs.
  return `${prior?.[1] ?? latest}~claxedo-${sequence.toString(16).padStart(8, "0")}-${crypto.randomUUID().replaceAll("-", "")}`
}

export class OpenCodeTurn {
  readonly userMessageId: string
  private readonly assistantIds = new Set<string>()
  private readonly translator = new OpenCodeEventTranslator()
  private snapshotOnly = false

  constructor(existingMessageIds: string[]) {
    this.userMessageId = messageId(existingMessageIds)
  }

  translate(event: OpenCodeLeafEvent): AgentRuntimeEvent[] {
    if (event.type === "message.updated") {
      const info = asRecord(event.properties.info)
      if (info) this.observe(info)
      return []
    }
    if (event.type === "message.part.updated" || event.type === "message.part.delta") {
      if (this.snapshotOnly) return []
      const id = asRecord(event.properties.part)?.messageID ?? event.properties.messageID
      if (typeof id !== "string" || !this.assistantIds.has(id)) return []
    }
    return this.translator.translate(event)
  }

  reconcile(messages: Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[] }>) {
    // SSE has no revision tying a part delta to this snapshot. After reconciling,
    // queued and reconnected content can overlap or omit bytes; only subsequent
    // authoritative snapshots may advance content for the remainder of the turn.
    this.snapshotOnly = true
    const current = messages.filter((message) => this.observe(message.info)).sort((a, b) => String(a.info.id) < String(b.info.id) ? -1 : 1)
    const events = current.flatMap((message) => message.parts.flatMap((part) => this.translator.translate({ type: "message.part.updated", properties: { part } })))
    const last = current.at(-1)
    const completed = typeof asRecord(last?.info.time)?.completed === "number"
    const failure = completed && last?.info.error ? errorText(last.info.error) : undefined
    const finished = completed && typeof last?.info.finish === "string" && !["tool-calls", "unknown"].includes(last.info.finish)
      && !last.parts.some((part) => part.type === "tool" && !asRecord(part.metadata)?.providerExecuted)
    return { events, failure, finished }
  }

  private observe(info: Record<string, unknown>) {
    if (info.role !== "assistant" || info.parentID !== this.userMessageId || info.summary === true || typeof info.id !== "string") return false
    this.assistantIds.add(info.id)
    return true
  }
}
