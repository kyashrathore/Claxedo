import { claudeChildCorrelationKey, type ClaudeSubagentUsage } from "@claxedo/agent-event-runtime/harnesses/claude"
import type { SessionKey, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk"
import { asRecord } from "@claxedo/helpers/guards"
import { text } from "../shared/sdk-runtime-values"

type UnjoinedUsage = Omit<ClaudeSubagentUsage, "parent_tool_use_id">

/**
 * Joins a subagent's mirrored transcript entries to the child that sent them.
 *
 * Claude Code never forwards a subagent's stream events, and a child
 * `assistant` frame carries only its request's opening usage, so a subagent
 * request's final output count reaches this process only in the subagent
 * transcript the CLI mirrors through `sessionStore.append`. Those entries name
 * no tool call; the child is the one whose frame shares the entry's message
 * id. The mirror flushes on its own schedule, so either side can come first.
 *
 * An entry whose frame never arrives is still a request the turn paid for:
 * `meterUnjoined` hands each one to the main thread (`correlationKey`
 * undefined) once, when no frame is left to join it.
 */
export function createClaudeSubagentUsage(deliver: (correlationKey: string | undefined, usage: ClaudeSubagentUsage) => void) {
  const childByMessageId = new Map<string, string>()
  const unjoined = new Map<string, UnjoinedUsage[]>()
  return {
    observeFrame(message: unknown) {
      const row = asRecord(message)
      if (row?.type !== "assistant") return
      const correlationKey = claudeChildCorrelationKey(row)
      const messageId = text(asRecord(row.message)?.id)
      if (!correlationKey || !messageId) return
      childByMessageId.set(messageId, correlationKey)
      const waiting = unjoined.get(messageId) ?? []
      unjoined.delete(messageId)
      for (const usage of waiting) deliver(correlationKey, { ...usage, parent_tool_use_id: correlationKey })
    },
    observeEntries(key: SessionKey, entries: readonly SessionStoreEntry[]) {
      if (!key.subpath) return
      for (const entry of entries) {
        if (entry.type !== "assistant") continue
        const message = asRecord(entry.message)
        const id = text(message?.id)
        const usage = asRecord(message?.usage)
        if (!id || !usage) continue
        const found: UnjoinedUsage = { session_id: key.sessionId, message: { id, usage } }
        const correlationKey = childByMessageId.get(id)
        if (correlationKey) deliver(correlationKey, { ...found, parent_tool_use_id: correlationKey })
        else unjoined.set(id, [...(unjoined.get(id) ?? []), found])
      }
    },
    meterUnjoined() {
      const orphans = [...unjoined.values()].flat()
      unjoined.clear()
      for (const usage of orphans) deliver(undefined, { ...usage, parent_tool_use_id: null })
    },
  }
}
