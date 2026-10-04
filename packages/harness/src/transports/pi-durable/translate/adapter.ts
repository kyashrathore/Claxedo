import { asRecord, asRecordOrEmpty as row, asString } from "@claxedo/helpers/guards"
import type { HarnessEventAdapter } from "../../../translate/adapter"
import { piMessageEnd, piMessageStart, piMessageUpdate, piReconcile } from "./messages"
import { ignoredKind, initialPiDurableState, piStep, type PiDurableTranslatorState, type PiStep } from "./state"
import { piToolEnd, piToolStart, piToolUpdate } from "./tools"
import { piUsageChanged, piUsageTotals } from "./usage"

type Frame = Record<string, unknown>
type Handler = (state: PiDurableTranslatorState, frame: Frame) => PiStep

const reason = (frame: Frame) => typeof frame.reason === "string" ? { reason: frame.reason } : {}

function snapshot(state: PiDurableTranslatorState, frame: Frame): PiStep {
  const partial = row(frame.generation).message
  const base = { ...state, usage: piUsageTotals(frame.usage) }
  return partial === undefined ? piStep({ ...base, blocks: {} }) : piReconcile(base, row(partial).content)
}

const HANDLERS: Record<string, Handler> = {
  snapshot,
  message_start: piMessageStart, message_update: piMessageUpdate, message_end: piMessageEnd,
  tool_execution_start: piToolStart, tool_execution_update: piToolUpdate, tool_execution_end: piToolEnd,
  usage_changed: piUsageChanged,
  auto_retry_start: (state, frame) => piStep(state, [{ type: "session-retry", message: asString(frame.errorMessage) || "Pi is retrying the model request",
    ...(typeof frame.attempt === "number" ? { attempt: frame.attempt } : {}) }]),
  compaction_start: (state, frame) => piStep(state, [{ type: "session-compaction", phase: "started", ...reason(frame) }]),
  compaction_end: (state, frame) => piStep(state, [{ type: "session-compaction", phase: "completed", ...reason(frame) }]),
  task_failed: (state, frame) => piStep(state, [{ type: "harness-notice", code: "pi.task_failed", severity: "error",
    message: asString(frame.message) ?? "A Pi task failed", details: { kind: frame.kind } }]),
}

const SILENT = ["run_start", "run_end", "turn_start", "turn_end", "submission", "inbox_update", "agent_changed", "entry_appended",
  "auto_retry_end", "deferred_poll"]

export function piDurableAdapter(): HarnessEventAdapter<PiDurableTranslatorState> {
  return {
    name: "pi-durable",
    createInitialState: initialPiDurableState,
    translate({ state, event }) {
      const frame = asRecord(event.payload) ?? {}
      const type = String(frame.type)
      const handler = HANDLERS[type]
      if (handler) return handler(state, frame)
      return SILENT.includes(type) ? piStep(state) : ignoredKind(state, type)
    },
  }
}
