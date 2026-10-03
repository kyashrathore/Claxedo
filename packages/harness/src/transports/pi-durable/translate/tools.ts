import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asArray, asRecordOrEmpty as row, asString } from "@claxedo/helpers/guards"
import { contentBlockImages } from "../../../translate/tool-attachments"
import { piStep, type PiDurableTranslatorState, type PiStep } from "./state"

type Frame = Record<string, unknown>

function toolCallId(frame: Frame, what: string): string {
  if (typeof frame.toolCallId !== "string") throw new Error(`Pi tool ${what} lacks identity`)
  return frame.toolCallId
}

function piResultText(content: unknown): string {
  return asArray(content).flatMap((item) => {
    const block = row(item)
    return block.type === "text" && typeof block.text === "string" ? [block.text] : []
  }).join("\n")
}

export function piToolStart(state: PiDurableTranslatorState, frame: Frame): PiStep {
  const id = toolCallId(frame, "start")
  if (typeof frame.toolName !== "string") throw new Error("Pi tool start lacks a name")
  return piStep(state, [{ type: "tool-start", toolCallId: id, toolName: frame.toolName }, { type: "tool-input", toolCallId: id, input: frame.args }])
}

export function piToolUpdate(state: PiDurableTranslatorState, frame: Frame): PiStep {
  const id = toolCallId(frame, "update")
  const output = row(frame.output)
  const text = asString(output.append) ?? asString(output.set) ?? ""
  return piStep(state, text ? [{ type: "tool-content", toolCallId: id, content: { type: "content", content: { type: "text", text } } }] : [])
}

export function piToolEnd(state: PiDurableTranslatorState, frame: Frame): PiStep {
  const id = toolCallId(frame, "completion")
  const result = row(asArray(row(frame.entry).model)[0])
  if (result.role !== "toolResult") {
    return piStep(state, [{ type: "tool-error", toolCallId: id, error: `Pi tool ${String(frame.toolName)} ended without a result` }])
  }
  if (result.isError === true) return piStep(state, [{ type: "tool-error", toolCallId: id, error: piResultText(result.content) }])
  const output = { content: result.content, ...(row(frame.entry).data === undefined ? {} : { details: row(frame.entry).data }) }
  const images = contentBlockImages(result.content)
  const event: AgentRuntimeEvent = { type: "tool-output", toolCallId: id, output, ...(images.length ? { attachments: images } : {}) }
  return piStep(state, [event])
}
