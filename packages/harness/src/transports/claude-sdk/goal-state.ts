import type { SDKActiveGoalMessage, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/agent-runtime-contract"
import { goalSnapshotFromRecord, type SessionBroker } from "../../contract"
import { TransportError } from "../../contract/errors"
import { claudeTranslator } from "./translate"

export function activeGoal(sessionId: string, message: SDKActiveGoalMessage): RuntimeGoalSnapshot | null {
  if (!message.value) return null
  const createdAt = message.value.set_at < 1_000_000_000_000 ? message.value.set_at * 1_000 : message.value.set_at
  return goalSnapshotFromRecord(sessionId, { objective: message.value.condition, status: "active", createdAt,
    updatedAt: Date.now(), iteration: message.value.iterations,
    ...(message.value.last_reason ? { lastReason: message.value.last_reason } : {}) },
  { invalid: () => new TransportError("claude", "protocol", "Claude returned an invalid goal") })
}

export function transcriptGoal(sessionId: string, entry: SessionStoreEntry, previous: RuntimeGoalSnapshot | null): RuntimeGoalSnapshot | null | undefined {
  if (entry.type !== "attachment") return undefined
  const row = asRecord(entry.attachment)
  if (!row) return undefined
  if (row.type !== "goal_status") return undefined
  if (row.met === true) return null
  if (row.met !== false || typeof row.condition !== "string" || !row.condition) return undefined
  const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN
  const updatedAt = Number.isFinite(timestamp) ? timestamp : Date.now()
  return goalSnapshotFromRecord(sessionId, { objective: row.condition, status: "active", updatedAt,
    createdAt: previous?.objective === row.condition ? previous.createdAt : updatedAt,
    iteration: row.iterations, ...(typeof row.reason === "string" && row.reason ? { lastReason: row.reason } : {}) },
  { invalid: () => new TransportError("claude", "protocol", "Claude returned an invalid goal") })
}

export function goalSessionStore(broker: SessionBroker, signal: AbortSignal, usage?: {
  runtime: ReturnType<typeof claudeTranslator>["runtime"]; assistantMessageId: string; directory: string
}): SessionStore {
  const runtime = usage?.runtime ?? claudeTranslator(broker.sessionId).runtime
  return {
    async append(key, entries) {
      for (const entry of entries) {
        if (key.subpath && entry.type === "assistant" && usage) {
          const message = asRecord(entry.message)
          const id = message?.id
          const counts = asRecord(message?.usage)
          if (typeof id === "string" && counts) {
            const events = usage.runtime.ingest({ source: "claude.sdk", method: "claude/subagent-usage", payload: {
              parent_tool_use_id: null, session_id: key.sessionId,
              message: { id, usage: counts, ...(typeof message?.model === "string" ? { model: message.model } : {}) },
            } }).events
            for (const event of events) if (event.type === "usage") broker.meter({ sessionId: broker.sessionId,
              directory: usage.directory, assistantMessageId: usage.assistantMessageId, usage: event })
          }
        }
        if (signal.aborted) continue
        const goal = transcriptGoal(broker.sessionId, entry, broker.goal.read())
        if (goal !== undefined) await broker.goal.publish(goal)
        if (entry.type === "ai-title" || entry.type === "custom-title") {
          const events = runtime.ingest({ source: "claude.sdk", method: "claude/session-store", payload: entry }).events
          for (const event of events) if (event.type === "session-title") await broker.publish(event)
        }
      }
    },
    async load() { return null },
    async listSessions() { return [] },
    async listSubkeys() { return [] },
  }
}
