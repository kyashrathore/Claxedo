import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asArray, asRecordOrEmpty as row, asString } from "@claxedo/helpers/guards"
import { ignoredKind, piStep, type PiDurableTranslatorState, type PiStep } from "./state"

type Frame = Record<string, unknown>

const STREAMED = ["text", "thinking"] as const
const QUIET_CHANGES = ["toolcall_start", "toolcall_delta"]
const STOP_REASONS = ["stop", "toolUse", "length", "error", "aborted", "pending", "deferred"]

function blockText(block: Record<string, unknown>): { kind: "text" | "thinking"; text: string } | undefined {
  const kind = STREAMED.find((candidate) => candidate === block.type)
  return kind ? { kind, text: asString(kind === "text" ? block.text : block.thinking) ?? "" } : undefined
}

function delta(kind: "text" | "thinking", text: string): AgentRuntimeEvent[] {
  return text ? [{ type: kind === "text" ? "text-delta" : "thinking-delta", delta: text }] : []
}

function reconcileBlock(blocks: Record<number, string>, index: number, block: unknown): AgentRuntimeEvent[] {
  const part = blockText(row(block))
  if (!part) return []
  const prior = blocks[index] ?? ""
  if (!part.text.startsWith(prior)) throw new Error("Pi content disagrees with the streamed deltas")
  blocks[index] = part.text
  return delta(part.kind, part.text.slice(prior.length))
}

export function piReconcile(state: PiDurableTranslatorState, content: unknown): PiStep {
  const blocks = { ...state.blocks }
  const events = asArray(content).flatMap((block, index) => reconcileBlock(blocks, index, block))
  return piStep({ ...state, blocks }, events)
}

export function piMessageStart(state: PiDurableTranslatorState, frame: Frame): PiStep {
  const message = row(frame.message)
  return message.role === "assistant" ? piReconcile({ ...state, blocks: {} }, message.content) : piStep(state)
}

function change(state: PiDurableTranslatorState, value: unknown): PiStep {
  const item = row(value)
  const index = typeof item.contentIndex === "number" ? item.contentIndex : -1
  if (item.type === "text_delta" || item.type === "thinking_delta") {
    const text = asString(item.delta) ?? ""
    return piStep({ ...state, blocks: { ...state.blocks, [index]: (state.blocks[index] ?? "") + text } },
      delta(item.type === "text_delta" ? "text" : "thinking", text))
  }
  if (item.type === "text_start" || item.type === "thinking_start" || item.type === "block") {
    const blocks = { ...state.blocks }
    return piStep({ ...state, blocks }, reconcileBlock(blocks, index, item.block))
  }
  if (item.type === "message") return piReconcile(state, row(item.message).content)
  return QUIET_CHANGES.includes(String(item.type)) ? piStep(state) : ignoredKind(state, `message_update.${String(item.type)}`)
}

export function piMessageUpdate(state: PiDurableTranslatorState, frame: Frame): PiStep {
  return asArray(frame.changes).reduce((step: PiStep, value) => {
    const next = change(step.state, value)
    return piStep(next.state, [...step.events, ...next.events])
  }, piStep(state))
}

function stopNotice(stopReason: string): AgentRuntimeEvent[] {
  if (stopReason !== "length") return []
  return [{ type: "harness-notice", code: "pi.output_limit", severity: "warn", message: "Pi stopped the reply at the model's output token limit" }]
}

export function piMessageEnd(state: PiDurableTranslatorState, frame: Frame): PiStep {
  const message = row(asArray(row(frame.entry).model)[0])
  if (message.role !== "assistant") return piStep(state)
  const stopReason = String(message.stopReason)
  const ended = piReconcile(state, message.content)
  const next = piStep({ ...ended.state, blocks: {} }, [...ended.events, ...stopNotice(stopReason)])
  if (STOP_REASONS.includes(stopReason)) return next
  const noted = ignoredKind(next.state, `stop_reason.${stopReason}`)
  return piStep(noted.state, [...next.events, ...noted.events])
}
