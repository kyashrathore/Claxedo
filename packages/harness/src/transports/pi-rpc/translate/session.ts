import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asRecord, asText } from "@claxedo/agent-runtime-contract"
import { piStep, type PiStep, type PiTranslatorState } from "./state"
import { piUsageEvents } from "./usage"

type Frame = Record<string, unknown>

const text = (value: unknown) => asText(value) ?? ""

export function piAgentStart(state: PiTranslatorState): PiStep {
  return piStep({ ...state, blocks: {}, finished: false, failure: undefined, stopped: false })
}

export function piAgentEnd(state: PiTranslatorState, frame: Frame): PiStep {
  const failure = frame.willRetry === true ? undefined : state.failure
  return piStep({ ...state, failure: undefined }, failure === undefined ? [] : [{ type: "error", error: failure }])
}

export function piSettled(state: PiTranslatorState, _frame: Frame, sessionId: string): PiStep {
  if (state.finished) return piStep(state)
  return piStep({ ...state, finished: true }, [state.stopped ? { type: "cancelled", sessionId } : { type: "finish", sessionId }])
}

function piRetryEvents(frame: Frame, fallback: string): AgentRuntimeEvent[] {
  return [{ type: "session-retry", message: text(frame.errorMessage) || fallback,
    ...(typeof frame.attempt === "number" ? { attempt: frame.attempt } : {}),
    ...(typeof frame.delayMs === "number" ? { delayMs: frame.delayMs } : {}) }]
}

export const piModelRetry = (state: PiTranslatorState, frame: Frame): PiStep => piStep(state, piRetryEvents(frame, "Pi is retrying the model request"))

export const piSummaryRetry = (state: PiTranslatorState, frame: Frame): PiStep => piStep(state, piRetryEvents(frame, "Pi is retrying the compaction summary"))

const reason = (frame: Frame) => typeof frame.reason === "string" ? { reason: frame.reason } : {}

export const piCompactionStart = (state: PiTranslatorState, frame: Frame): PiStep =>
  piStep(state, [{ type: "session-compaction", phase: "started", ...reason(frame) }])

export function piCompactionEnd(state: PiTranslatorState, frame: Frame): PiStep {
  const result = asRecord(frame.result) ?? {}
  return piStep(state, [...piUsageEvents(result.usage), { type: "session-compaction", phase: "completed", ...reason(frame),
    summary: text(result.summary) || undefined,
    metadata: { aborted: frame.aborted === true, ...(typeof frame.errorMessage === "string" ? { error: frame.errorMessage } : {}) } }])
}

export function piSessionName(state: PiTranslatorState, frame: Frame): PiStep {
  const name = text(frame.name).trim()
  return piStep(state, name ? [{ type: "session-title", title: name }] : [])
}

export const piExtensionError = (state: PiTranslatorState, frame: Frame): PiStep =>
  piStep(state, [{ type: "harness-notice", code: "pi.extension_error", message: text(frame.error), severity: "error" }])
