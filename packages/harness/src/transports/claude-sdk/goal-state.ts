import type { SDKActiveGoalMessage, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/agent-runtime-contract"
import type { SessionBroker } from "../../contract"
import { claudeTranslator } from "./translate"

export function activeGoal(sessionId: string, message: SDKActiveGoalMessage): RuntimeGoalSnapshot | null {
  if (!message.value) return null
  const createdAt = message.value.set_at < 1_000_000_000_000 ? message.value.set_at * 1_000 : message.value.set_at
  return { sessionId, objective: message.value.condition, status: "active", createdAt, updatedAt: Date.now(),
    iteration: message.value.iterations, ...(message.value.last_reason ? { lastReason: message.value.last_reason } : {}) }
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
  return { sessionId, objective: row.condition, status: "active", updatedAt,
    createdAt: previous?.objective === row.condition ? previous.createdAt : updatedAt,
    ...(typeof row.iterations === "number" ? { iteration: row.iterations } : {}),
    ...(typeof row.reason === "string" && row.reason ? { lastReason: row.reason } : {}),
  }
}

export function goalSessionStore(broker: SessionBroker, signal: AbortSignal): SessionStore {
  const { runtime } = claudeTranslator(broker.sessionId)
  return {
    async append(_key, entries) {
      for (const entry of entries) {
        if (signal.aborted) return
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
