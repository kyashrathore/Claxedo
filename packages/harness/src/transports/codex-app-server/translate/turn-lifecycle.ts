import { asRecord } from "@claxedo/helpers/guards"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import type { HarnessEventAdapterContext } from "../../../translate/adapter"
import { codexSessionId, type CodexHandlers } from "./frame"
import { diagnosticForEvent, harnessNotice } from "./notices"
import { endThreadTurn } from "./state"
import { turnErrorEvent } from "./turn-errors"

function completionEvents(
  event: { payload: unknown },
  row: Record<string, unknown>,
  context: HarnessEventAdapterContext,
  lastLimitedRateLimitMessage?: string,
) {
  const turn = asRecord(row.turn) ?? row
  const status = text(turn.status)
  if (status === "failed" || status === "error") {
    return [
      { type: "session-status", status: "error" },
      turnErrorEvent(asRecord(turn.error), text(row.message), lastLimitedRateLimitMessage, "Codex turn failed"),
    ] satisfies AgentRuntimeEvent[]
  }
  if ((status === "cancelled" || status === "interrupted") && asRecord(turn.error)) {
    return [
      { type: "session-status", status: "error" },
      turnErrorEvent(asRecord(turn.error), undefined, lastLimitedRateLimitMessage, "Codex interrupted the turn"),
    ] satisfies AgentRuntimeEvent[]
  }
  if (status === "cancelled" || status === "interrupted") {
    return [
      { type: "session-status", status: "idle" },
      { type: "cancelled", sessionId: codexSessionId(event, context) },
    ] satisfies AgentRuntimeEvent[]
  }
  return [
    { type: "session-status", status: "idle" },
    { type: "finish", sessionId: codexSessionId(event, context) },
  ] satisfies AgentRuntimeEvent[]
}

function threadStatusEvents(row: Record<string, unknown>) {
  const status = asRecord(row.status)
  const type = text(status?.type)
  if (type === "active") return [{ type: "session-status", status: "busy" }] satisfies AgentRuntimeEvent[]
  if (type === "idle" || type === "notLoaded") return [{ type: "session-status", status: "idle" }] satisfies AgentRuntimeEvent[]
  if (type !== "systemError") return []
  return [harnessNotice({ code: "codex_app_server.thread_system_error", message: "Codex reported a system error on this thread", severity: "warn" })]
}

function todosFromPlan(row: Record<string, unknown>) {
  const plan = Array.isArray(row.plan) ? row.plan : []
  return plan.flatMap((step, i) => {
    const item = asRecord(step)
    if (!item) return []
    const description = text(item.step) ?? text(item.content) ?? text(item.description)
    if (!description) return []
    return [{
      id: String(i),
      description,
      status: item.status === "inProgress" ? "in_progress" : text(item.status) ?? "pending",
    }]
  })
}

function fileDiffs(diff: string): AgentRuntimeEvent[] {
  return diff.split(/^(?=diff --git )/m).flatMap((section) => {
    const path = /^diff --git a\/.+? b\/(.+)$/m.exec(section)?.[1]
    return path ? [{ type: "file-diff", path, newText: section }] : []
  })
}

export const turnHandlers: CodexHandlers = {
  "turn/started": () => [{ type: "session-status", status: "busy" }],
  "turn/completed": ({ state, event, context, row }) => ({
    state: endThreadTurn(state, event, context),
    events: completionEvents(event, row, context, state.lastLimitedRateLimitMessage),
  }),
  "thread/status/changed": ({ row }) => threadStatusEvents(row),
  "thread/closed": ({ state, event, context }) => ({
    state: endThreadTurn(state, event, context),
    events: [
      { type: "session-status", status: "idle" },
      { type: "finish", sessionId: codexSessionId(event, context) },
    ],
  }),
  "thread/started": () => [],
  "thread/goal/updated": () => [],
  "thread/goal/cleared": () => [],
  "turn/plan/updated": ({ row }) => {
    const todos = todosFromPlan(row)
    return todos.length ? [{ type: "todo-update", todos }] : []
  },
  "turn/diff/updated": ({ row }) => fileDiffs(text(row.diff) ?? ""),
  "thread/name/updated": ({ row }) => {
    const name = text(row.threadName)
    return name ? [{ type: "session-title", title: name }] : []
  },
  "thread/compacted": ({ row }) => [{ type: "session-compaction", phase: "completed", metadata: { codex: row } }],
  error: ({ state, row, event }) => {
    const failure = turnErrorEvent(asRecord(row.error), text(row.message), state.lastLimitedRateLimitMessage, "Codex provider error")
    if (row.willRetry === true) {
      return [diagnosticForEvent({ code: "codex_app_server.retryable_error", message: failure.error, severity: "warn", event })]
    }
    return [{ type: "session-status", status: "error" }, failure]
  },
}
