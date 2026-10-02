import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asArray, asRecordOrEmpty as row } from "@claxedo/helpers/guards"
import { contentBlockImages } from "../../../translate/tool-attachments"
import { piStep, type PiStep, type PiTranslatorState } from "./state"

type Frame = Record<string, unknown>

function toolCallId(frame: Frame, what: string): string {
  if (typeof frame.toolCallId !== "string") throw new Error(`Pi tool ${what} lacks identity`)
  return frame.toolCallId
}

export function piToolStart(state: PiTranslatorState, frame: Frame): PiStep {
  const id = toolCallId(frame, "start")
  if (typeof frame.toolName !== "string") throw new Error("Pi tool start lacks identity")
  const parent = typeof frame.parentToolCallId === "string" ? { metadata: { parentToolCallId: frame.parentToolCallId } } : {}
  return piStep(state, [{ type: "tool-start", toolCallId: id, toolName: frame.toolName, ...parent }, { type: "tool-input", toolCallId: id, input: frame.args }])
}

export function piToolUpdate(state: PiTranslatorState, frame: Frame): PiStep {
  const id = toolCallId(frame, "update")
  const content = row(frame.partialResult).content
  return piStep(state, asArray(content).flatMap((item): AgentRuntimeEvent[] => {
    const block = row(item)
    return block.type === "text" && typeof block.text === "string"
      ? [{ type: "tool-content", toolCallId: id, content: { type: "content", content: { type: "text", text: block.text } } }] : []
  }))
}

function toolErrorText(result: unknown): string {
  if (typeof result === "string") return result
  const content = row(result).content
  const lines = asArray(content).flatMap((item) => row(item).type === "text" && typeof row(item).text === "string" ? [String(row(item).text)] : [])
  return lines.length ? lines.join("\n") : JSON.stringify(result)
}

export function piToolEnd(state: PiTranslatorState, frame: Frame): PiStep {
  const id = toolCallId(frame, "completion")
  if (frame.isError) return piStep(state, [{ type: "tool-error", toolCallId: id, error: toolErrorText(frame.result) }])
  const images = contentBlockImages(row(frame.result).content)
  return piStep(state, [{ type: "tool-output", toolCallId: id, output: frame.result, ...(images.length ? { attachments: images } : {}) }])
}
