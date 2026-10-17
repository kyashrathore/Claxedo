import { toolMcpFacts, type AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asArray, asRecordOrEmpty as row, asString } from "@claxedo/helpers/guards"
import { contentBlockImages, mcpAppAttachment } from "../../../translate/tool-attachments"
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

function frameToolName(frame: Frame, what: string): string {
  if (typeof frame.toolName !== "string") throw new Error(`Pi tool ${what} lacks a name`)
  return frame.toolName
}

function piToolStarted(id: string, name: string, args: unknown): AgentRuntimeEvent[] {
  const display = piToolDisplay(name, args)
  return [{ type: "tool-start", toolCallId: id, toolName: name, kind: display.kind, display },
    { type: "tool-input", toolCallId: id, input: args, display }]
}

function forgetAnnounced(state: PiDurableTranslatorState, id: string): PiDurableTranslatorState {
  const { [id]: _settled, ...announced } = state.announced
  return { ...state, announced }
}

export function piToolCallsAnnounced(step: PiStep, frame: Frame): PiStep {
  const message = row(asArray(row(frame.entry).model)[0])
  if (message.role !== "assistant") return step
  const calls = asArray(message.content).map(row).filter((block) => block.type === "toolCall" && typeof block.id === "string")
  if (calls.length === 0) return step
  const announced = { ...step.state.announced, ...Object.fromEntries(calls.map((block) => [block.id, block.arguments ?? {}])) }
  return piStep({ ...step.state, announced }, step.events)
}

export function piToolStart(state: PiDurableTranslatorState, frame: Frame): PiStep {
  const id = toolCallId(frame, "start")
  return piStep(forgetAnnounced(state, id), piToolStarted(id, frameToolName(frame, "start"), frame.args))
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
  const unstarted = Object.hasOwn(state.announced, id) ? piToolStarted(id, frameToolName(frame, "completion"), state.announced[id]) : []
  const ended = piToolResult(forgetAnnounced(state, id), frame, id)
  return piStep(ended.state, [...unstarted, ...ended.events])
}

function piToolMcp(details: unknown) {
  const facts = toolMcpFacts(row(details))
  const app = facts?.app ? mcpAppAttachment(row(details).appDocument) : []
  if (!facts?.app || app.length > 0) return { mcp: facts, app }
  const { app: _unattached, ...mcp } = facts
  return { mcp, app }
}

function piToolResult(state: PiDurableTranslatorState, frame: Frame, id: string): PiStep {
  const entry = row(frame.entry)
  const result = row(asArray(entry.model)[0])
  if (result.role !== "toolResult") {
    return piStep(state, [{ type: "tool-error", toolCallId: id, error: `Pi tool ${String(frame.toolName)} ended without a result` }])
  }
  const content = shownContent(result.content)
  const { mcp, app } = piToolMcp(result.details)
  const metadata = mcp ? { metadata: { mcp } } : {}
  if (result.isError === true) {
    const error = [piResultText(content), ...diagnosticMessages(entry.data)].filter((text) => text !== "").join("\n")
    return piStep(state, [{ type: "tool-error", toolCallId: id, error, ...metadata }])
  }
  const notes = diagnosticMessages(entry.data, "warn").map((text) => ({ type: "text", text }))
  const output = { content: [...content, ...notes], ...(entry.data === undefined ? {} : { details: entry.data }) }
  const attachments = [...contentBlockImages(content), ...app]
  const event: AgentRuntimeEvent = { type: "tool-output", toolCallId: id, output, ...(attachments.length ? { attachments } : {}), ...metadata }
  return piStep(state, [event])
}
