import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asArray, asRecordOrEmpty as row, asString } from "@claxedo/helpers/guards"
import { ignoredKind, piStep, type PiStep, type PiTranslatorState } from "./state"
import { piUsageEvents } from "./usage"

type Frame = Record<string, unknown>

const QUIET_ROLES = ["user", "toolResult", "system", "bashExecution", "branchSummary", "compactionSummary", "custom"]
const QUIET_UPDATES = ["start", "text_start", "text_end", "thinking_start", "thinking_end", "toolcall_start", "toolcall_delta", "toolcall_end",
  "done", "error"]
const STOP_REASONS = ["stop", "toolUse", "length", "error", "aborted", "pending", "deferred"]

function quietRole(state: PiTranslatorState, role: unknown): PiStep {
  return QUIET_ROLES.includes(String(role)) ? piStep(state) : ignoredKind(state, `message.${String(role)}`)
}

export function piMessageStart(state: PiTranslatorState, frame: Frame): PiStep {
  const role = row(frame.message).role
  return role === "assistant" ? piStep({ ...state, blocks: {} }) : quietRole(state, role)
}

export function piMessageUpdate(state: PiTranslatorState, frame: Frame): PiStep {
  const update = row(frame.assistantMessageEvent)
  if (update.type !== "text_delta" && update.type !== "thinking_delta") {
    return QUIET_UPDATES.includes(String(update.type)) ? piStep(state) : ignoredKind(state, `message_update.${String(update.type)}`)
  }
  if (typeof update.contentIndex !== "number" || typeof update.delta !== "string") throw new Error("Invalid Pi content delta")
  const index = update.contentIndex
  return piStep({ ...state, blocks: { ...state.blocks, [index]: (state.blocks[index] ?? "") + update.delta } },
    [{ type: update.type === "text_delta" ? "text-delta" : "thinking-delta", delta: update.delta }])
}

function reconciled(state: PiTranslatorState, content: unknown): AgentRuntimeEvent[] {
  return asArray(content).flatMap((item, index): AgentRuntimeEvent[] => {
    const block = row(item)
    if (block.type !== "text" && block.type !== "thinking") return []
    const value = asString(block.type === "text" ? block.text : block.thinking) ?? ""
    const prior = state.blocks[index] ?? ""
    if (!value.startsWith(prior)) throw new Error("Pi final content disagrees with streamed deltas")
    if (value.length === prior.length) return []
    return [{ type: block.type === "text" ? "text-delta" : "thinking-delta", delta: value.slice(prior.length) }]
  })
}

function stopNotice(stopReason: string): AgentRuntimeEvent[] {
  if (stopReason !== "length") return []
  return [{ type: "harness-notice", code: "pi.output_limit", severity: "warn", message: "Pi stopped the reply at the model's output token limit" }]
}

function assistantEnd(state: PiTranslatorState, assistant: Frame): PiStep {
  const stopReason = String(assistant.stopReason)
  const events = [...reconciled(state, assistant.content),
    ...piUsageEvents(assistant.usage, typeof assistant.timestamp === "number" ? String(assistant.timestamp) : undefined), ...stopNotice(stopReason)]
  const next = piStep({ ...state, blocks: {}, stopped: stopReason === "aborted",
    ...(stopReason === "error" ? { failure: asString(assistant.errorMessage) || "Pi model request failed" } : { failure: undefined }) }, events)
  if (STOP_REASONS.includes(stopReason)) return next
  const noted = ignoredKind(next.state, `stop_reason.${stopReason}`)
  return piStep(noted.state, [...next.events, ...noted.events])
}

function customText(content: unknown): string {
  if (typeof content === "string") return content
  return asArray(content).flatMap((item) => row(item).type === "text" ? [asString(row(item).text) ?? ""] : []).join("\n")
}

function customNotice(state: PiTranslatorState, message: Frame): PiStep {
  const shown = message.display === true ? customText(message.content) : ""
  return piStep(state, shown ? [{ type: "harness-notice", code: "pi.custom_message", message: shown, severity: "info",
    details: { customType: message.customType } }] : [])
}

export function piMessageEnd(state: PiTranslatorState, frame: Frame): PiStep {
  const message = row(frame.message)
  if (message.role === "assistant") return assistantEnd(state, message)
  if (message.role === "custom") return customNotice(state, message)
  return quietRole(state, message.role)
}
