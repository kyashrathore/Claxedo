import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asArray, asRecordOrEmpty as row, asString } from "@claxedo/helpers/guards"
import { contentBlockImages } from "../../../translate/tool-attachments"
import { toolDisplayFromInput } from "../../../translate/tool-display"
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

const PI_FILE_TOOLS: Readonly<Record<string, string>> = { read: "file_read", write: "file_change", edit: "file_change" }

function piToolDisplay(toolName: string, args: unknown) {
  const input = row(args)
  const kind = PI_FILE_TOOLS[toolName]
  const display = toolDisplayFromInput({ kind: kind ?? (toolName === "bash" ? "command_execution" : "dynamic_tool_call"), toolName, input })
  const filePath = kind ? asString(input.path) : undefined
  return filePath ? { ...display, filePath } : display
}

export function piToolStart(state: PiDurableTranslatorState, frame: Frame): PiStep {
  const id = toolCallId(frame, "start")
  if (typeof frame.toolName !== "string") throw new Error("Pi tool start lacks a name")
  const display = piToolDisplay(frame.toolName, frame.args)
  return piStep(state, [{ type: "tool-start", toolCallId: id, toolName: frame.toolName, kind: display.kind, display },
    { type: "tool-input", toolCallId: id, input: frame.args, display }])
}

export function piToolUpdate(state: PiDurableTranslatorState, frame: Frame): PiStep {
  const id = toolCallId(frame, "update")
  const output = row(frame.output)
  const text = asString(output.append) ?? asString(output.set) ?? ""
  return piStep(state, text ? [{ type: "tool-content", toolCallId: id, content: { type: "content", content: { type: "text", text } } }] : [])
}

const RENDERED_DIAGNOSTICS = /^<harness>\n[\s\S]*\n<\/harness>$/

function shownContent(content: unknown): unknown[] {
  return asArray(content).filter((item) => !RENDERED_DIAGNOSTICS.test(asString(row(item).text) ?? ""))
}

function diagnosticMessages(data: unknown, severity?: string): string[] {
  return asArray(row(data).diagnostics).flatMap((item) => {
    const diagnostic = row(item)
    return severity === undefined || diagnostic.severity === severity ? asString(diagnostic.message) ?? [] : []
  })
}

export function piToolEnd(state: PiDurableTranslatorState, frame: Frame): PiStep {
  const id = toolCallId(frame, "completion")
  const entry = row(frame.entry)
  const result = row(asArray(entry.model)[0])
  if (result.role !== "toolResult") {
    return piStep(state, [{ type: "tool-error", toolCallId: id, error: `Pi tool ${String(frame.toolName)} ended without a result` }])
  }
  const content = shownContent(result.content)
  if (result.isError === true) {
    const error = [piResultText(content), ...diagnosticMessages(entry.data)].filter((text) => text !== "").join("\n")
    return piStep(state, [{ type: "tool-error", toolCallId: id, error }])
  }
  const notes = diagnosticMessages(entry.data, "warn").map((text) => ({ type: "text", text }))
  const output = { content: [...content, ...notes], ...(entry.data === undefined ? {} : { details: entry.data }) }
  const images = contentBlockImages(content)
  const event: AgentRuntimeEvent = { type: "tool-output", toolCallId: id, output, ...(images.length ? { attachments: images } : {}) }
  return piStep(state, [event])
}
