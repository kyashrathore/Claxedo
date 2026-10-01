import { asRecord } from "@claxedo/helpers/guards"
import { type AgentRuntimeEvent, type RuntimeToolStatus, asText as text } from "@claxedo/agent-runtime-contract"
import type { SessionUpdate } from "./types"
import type { TranslatorContext } from "./state"
import { reduceTool, type ToolState } from "./state"
import { viewTool } from "./tool-presentation"
import { drainContent, drainSpots } from "./state"
import { classifyToolCall, isSessionSurface, projectToolStart } from "./classify-tool"
import { diagnoseTranslation, shape } from "./diagnostics"
import { safeContent, safeLocations, safeMeta, safeRawInput, safeRawOutput } from "./validation"
import { jsonText } from "../../../translate/value"
import { contentBlockImages } from "../../../translate/tool-attachments"

type ToolUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>

function toolStatus(status: unknown, initial: boolean): RuntimeToolStatus {
  if (status === "in_progress") return "running"
  if (status === "pending" || status === "completed" || status === "failed") return status
  return initial ? "running" : "pending"
}

function errorText(value: unknown): string {
  const direct = text(value)
  if (direct) return direct
  const row = asRecord(value)
  const streams = [text(row?.stderr), text(row?.stdout)].filter(Boolean).join("\n")
  return (
    streams ||
    text(row?.message) ||
    text(row?.text) ||
    text(row?.content) ||
    (value !== undefined && value !== null ? jsonText(value) : "")
  )
}

function prepared(update: ToolUpdate, ctx: TranslatorContext) {
  const diagnosticContext = {
    diagnostics: ctx.diagnostics,
    toolCallId: update.toolCallId,
    title: update.sessionUpdate === "tool_call" ? update.title : update.title ?? undefined,
    kind: update.sessionUpdate === "tool_call" ? update.kind : update.kind ?? undefined,
  }
  const safe = {
    title: update.title ?? undefined,
    kind: update.kind ?? undefined,
    status: toolStatus(update.status, update.sessionUpdate === "tool_call"),
    meta: safeMeta(update._meta, diagnosticContext),
    rawInput: safeRawInput(update.rawInput, diagnosticContext),
    rawOutput: safeRawOutput(update.rawOutput, diagnosticContext),
    content: safeContent(update.content, diagnosticContext),
    locations: safeLocations(update.locations, diagnosticContext),
  }
  const tool = reduceTool(ctx.state, update.toolCallId, safe, ctx.diagnostics)
  const view = viewTool(tool)
  return { ...safe, tool, view, sessionSurface: isSessionSurface(classifyToolCall(view, ctx.diagnostics)) }
}

type Prepared = ReturnType<typeof prepared>

function hasUsefulUpdate(update: ToolUpdate, next: Prepared): boolean {
  return (
    update.rawInput !== undefined ||
    update.rawOutput !== undefined ||
    !!next.content?.length ||
    !!next.locations?.length ||
    !!next.title ||
    !!next.kind ||
    !!next.meta
  )
}

function shouldEmitInput(update: ToolUpdate, next: Prepared): boolean {
  if (!next.view.input) return false
  if (update.sessionUpdate === "tool_call") return true
  if (update.status !== "completed" && update.status !== "failed" && update.status !== "in_progress") return false
  const raw = asRecord(next.rawInput)
  return (
    !!(raw && Object.keys(raw).length) ||
    !!next.title ||
    !!next.kind ||
    ((update.status === "completed" || update.status === "failed") &&
      !!next.content?.some((item) => item.type === "diff"))
  )
}

function completedToolUpdate(tool: ToolState, next: Prepared): AgentRuntimeEvent {
  const attachments = contentBlockImages(
    tool.content.flatMap((item) => (item.type === "content" ? [item.content] : [])),
  )
  return {
    type: "tool-output",
    toolCallId: tool.id,
    output: tool.rawOutput ?? next.content ?? null,
    ...(attachments.length ? { attachments } : {}),
    display: next.view.display,
    metadata: next.view.metadata,
  }
}

function failedTool(update: ToolUpdate, next: Prepared, ctx: TranslatorContext): AgentRuntimeEvent {
  const error = errorText(next.tool.rawOutput)
  const raw = next.rawOutput
  if (!error && raw !== undefined && raw !== null && update.sessionUpdate === "tool_call_update") {
    diagnoseTranslation(ctx.diagnostics, "acp.empty_error_extraction", {
      toolCallId: update.toolCallId,
      title: update.title ?? undefined,
      kind: update.kind ?? undefined,
      shape: shape(raw),
      reason: "payload_without_error_text",
    })
  }
  return {
    type: "tool-error",
    toolCallId: update.toolCallId,
    error:
      error ||
      (update.sessionUpdate === "tool_call_update" && raw !== undefined && raw !== null ? jsonText({ raw }) : ""),
    display: next.view.display,
    metadata: next.view.metadata,
  }
}

function statusEvent(update: ToolUpdate, next: Prepared): AgentRuntimeEvent[] {
  const terminal = next.status === "completed" || next.status === "failed"
  const present =
    update.sessionUpdate === "tool_call"
      ? update.status !== undefined
      : Object.hasOwn(update, "status") || hasUsefulUpdate(update, next)
  return present && (next.sessionSurface || !terminal)
    ? [
        {
          type: "tool-status",
          toolCallId: update.toolCallId,
          status: next.status,
          display: next.view.display,
          metadata: next.view.metadata,
        },
      ]
    : []
}

export function toolUpdate(update: ToolUpdate, ctx: TranslatorContext): AgentRuntimeEvent[] {
  const next = prepared(update, ctx)
  const events = statusEvent(update, next)
  if (!next.sessionSurface) {
    if (update.sessionUpdate === "tool_call")
      events.push(projectToolStart(update.toolCallId, next.view, next.tool.kind))
    if (shouldEmitInput(update, next))
      events.push({
        type: "tool-input",
        toolCallId: update.toolCallId,
        input: next.view.input,
        display: next.view.display,
        metadata: next.view.metadata,
      })
    if (update.sessionUpdate === "tool_call_update" && next.status === "failed")
      events.push(failedTool(update, next, ctx))
  }
  events.push(...drainContent(next.tool, next.content), ...drainSpots(next.tool, next.locations))
  if (!next.sessionSurface && next.status === "completed") events.push(completedToolUpdate(next.tool, next))
  if (!next.sessionSurface && update.sessionUpdate === "tool_call" && next.status === "failed")
    events.push(failedTool(update, next, ctx))
  return events
}
