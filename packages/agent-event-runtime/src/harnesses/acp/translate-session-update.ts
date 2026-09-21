/**
 * Layer 1: ACP SessionUpdate → AgentRuntimeEvent[]
 *
 * Pure function — no async, no Node imports, no side effects.
 * Exhaustiveness is enforced by `const _: never = update` in the default case.
 */

import { asRecord } from "@claxedo/helpers/guards"
import type {
  SessionUpdate,
  ToolCallContent,
  StopReason,
  ToolKind,
} from "./types"
import type { AgentRuntimeEvent, RuntimeToolStatus } from "../../contracts/agent-runtime-event"
import { drainContent, drainSpots, reduceTool, RETAINED_MESSAGE_TEXTS_MAX, viewToolWithDiagnostics, type SessionState } from "./state"
import { classifyToolCall, isSessionSurface, projectToolStart } from "./classify-tool"
import { createAcpDiagnostics, diagnoseTranslation, shape, type AcpDiagnostics } from "./diagnostics"
import { checkContentBlock, safeContent, safeLocations, safeMeta, safeRawInput, safeRawOutput } from "./validation"
import { boundKeyedMap, jsonText, object, text } from "../../value"
import { contentBlockImages } from "../tool-attachments"

export type { SessionUpdate }

export interface TranslatorContext {
  state: SessionState
  diagnostics: AcpDiagnostics
  preserveUserMessageChunks?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when rawInput contains at least one key — i.e. is usable structured data.
 * Rejects empty objects sent as placeholders.
 */
function hasStructuredInput(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && raw !== undefined && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length > 0
}

function emitInput(
  phase: "start" | "in_progress" | "completed",
  input: Record<string, unknown> | undefined,
  rawInput: unknown,
  title?: string,
  kind?: ToolKind,
  content?: ToolCallContent[] | null,
) {
  if (!input) return false
  if (phase === "start") return true
  if (hasStructuredInput(rawInput)) return true
  if (title || kind) return true
  if (phase === "completed" && (content ?? []).some((item) => item.type === "diff")) return true
  return false
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function toolStatus(status: unknown): RuntimeToolStatus | undefined {
  if (status === "pending") return "pending"
  if (status === "in_progress") return "running"
  if (status === "completed") return "completed"
  if (status === "failed") return "failed"
  return undefined
}

function hasUsefulToolUpdate(input: {
  rawInput: unknown
  rawOutput: unknown
  content: ToolCallContent[] | null | undefined
  locations: Array<{ path: string; line?: number | null }> | null | undefined
  title?: string | null
  kind?: ToolKind | null
  meta?: Record<string, unknown>
}) {
  return input.rawInput !== undefined ||
    input.rawOutput !== undefined ||
    (input.content !== undefined && input.content !== null && input.content.length > 0) ||
    (input.locations !== undefined && input.locations !== null && input.locations.length > 0) ||
    !!input.title ||
    !!input.kind ||
    !!input.meta
}

function errorText(value: unknown) {
  const direct = text(value)
  if (direct) return direct

  const row = asRecord(value)
  const rowText = [text(row?.stderr), text(row?.stdout)].filter((item): item is string => !!item).join("\n")
  const fromRow =
    (rowText || undefined) ??
    text(row?.message) ??
    text(row?.text) ??
    text(row?.content)
  if (fromRow) return fromRow

  if (row || (value !== undefined && value !== null)) return jsonText(value)
  return ""
}

function translateContentChunk(input: {
  kind: "agent_message_chunk" | "agent_thought_chunk"
  content: Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" }>["content"]
  messageId?: string
  state: SessionState
}): AgentRuntimeEvent[] {
  const isThought = input.kind === "agent_thought_chunk"
  if (input.content.type === "text") {
    const text = textChunkDelta({
      kind: input.kind,
      content: input.content,
      messageId: input.messageId,
      state: input.state,
    })
    if (!text) return []
    return [isThought
      ? { type: "thinking-delta", delta: text }
      : { type: "text-delta", delta: text }]
  }
  if (input.content.type === "image") {
    return isThought
      ? [{ type: "resource-delta", resource: input.content, channel: "thinking" }]
      : [{ type: "image-delta", mimeType: input.content.mimeType, data: input.content.data }]
  }
  if (input.content.type === "audio") {
    return isThought
      ? [{ type: "thinking-audio-delta", mimeType: input.content.mimeType, data: input.content.data }]
      : [{ type: "audio-delta", mimeType: input.content.mimeType, data: input.content.data }]
  }
  if (input.content.type === "resource_link") {
    return isThought
      ? [{
        type: "thinking-resource-link-delta",
        uri: input.content.uri,
        name: input.content.name,
        mimeType: input.content.mimeType ?? undefined,
        title: input.content.title ?? undefined,
      }]
      : [{
        type: "resource-link-delta",
        uri: input.content.uri,
        name: input.content.name,
        mimeType: input.content.mimeType ?? undefined,
        title: input.content.title ?? undefined,
      }]
  }
  if (input.content.type === "resource") {
    const resource = input.content.resource
    if ("text" in resource && typeof resource.text === "string") {
      return [isThought
        ? { type: "thinking-delta", delta: resource.text }
        : { type: "text-delta", delta: resource.text }]
    }
    return [{ type: "resource-delta", resource, channel: isThought ? "thinking" : "assistant" }]
  }
  return []
}

function textChunkDelta(input: {
  kind: "agent_message_chunk" | "agent_thought_chunk"
  messageId?: string
  state: SessionState
  content: { type: "text"; text: string }
}) {
  const key = input.messageId ?? (input.kind === "agent_thought_chunk" ? "__thinking" : "__assistant")
  const seen = input.kind === "agent_thought_chunk"
    ? input.state.assistantThinkingByMessageId
    : input.state.assistantTextByMessageId
  const previous = seen.get(key) ?? ""
  const delta = input.content.text.startsWith(previous)
    ? input.content.text.slice(previous.length)
    : input.content.text
  seen.set(key, input.content.text.startsWith(previous)
    ? input.content.text
    : `${previous}${input.content.text}`)
  boundKeyedMap(seen, RETAINED_MESSAGE_TEXTS_MAX)
  return delta
}


type ConfigUpdateEvent = Extract<AgentRuntimeEvent, { type: "config-update" }>
type ConfigUpdateOption = ConfigUpdateEvent["options"][number]

/**
 * Flattens `SessionConfigSelectOptions` (a flat option array OR an array of groups)
 * into the id/name pairs the runtime event carries. Entries that do not match either
 * wire shape are dropped rather than emitted as `{ id: undefined }`.
 */
function decodeSelectOptions(value: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const row = object(entry)
    if (!row) return []
    if (Array.isArray(row.options)) return decodeSelectOptions(row.options)
    if (typeof row.value === "string" && typeof row.name === "string") return [{ id: row.value, name: row.name }]
    return []
  })
}

function safePlanEntries(value: unknown, diagnostics: AcpDiagnostics) {
  if (!Array.isArray(value)) {
    diagnoseTranslation(diagnostics, "acp.malformed_plan", {
      reason: "entries_not_array",
      shape: shape(value),
    })
    return []
  }
  return value.flatMap((item, i) => {
    const row = asRecord(item)
    if (!row || typeof row.content !== "string" || typeof row.status !== "string") {
      diagnoseTranslation(diagnostics, "acp.malformed_plan", {
        reason: "entry_missing_content_or_status",
        shape: shape(item),
      })
      return []
    }
    return [{
      id: String(i),
      description: row.content,
      status: row.status,
      priority: typeof row.priority === "string" ? row.priority : undefined,
    }]
  })
}

function decodeConfigOptions(value: unknown, diagnostics: AcpDiagnostics): ConfigUpdateOption[] {
  if (!Array.isArray(value)) {
    diagnoseTranslation(diagnostics, "acp.malformed_config_options", {
      reason: "configOptions_not_array",
      shape: shape(value),
    })
    return []
  }
  return value.flatMap((item): ConfigUpdateOption[] => {
    const row = asRecord(item)
    if (!row || typeof row.id !== "string" || typeof row.name !== "string") {
      diagnoseTranslation(diagnostics, "acp.malformed_config_options", {
        reason: "option_missing_id_or_name",
        shape: shape(item),
      })
      return []
    }
    const common = { id: row.id, name: row.name, category: text(row.category) }
    if (row.type === "select" && typeof row.currentValue === "string") {
      return [{ ...common, type: "select" as const, currentValue: row.currentValue, selectOptions: decodeSelectOptions(row.options) }]
    }
    if (row.type === "boolean" && typeof row.currentValue === "boolean") {
      return [{ ...common, type: "boolean" as const, currentValue: row.currentValue }]
    }
    diagnoseTranslation(diagnostics, "acp.malformed_config_options", {
      reason: "option_invalid_type_or_value",
      shape: shape(item),
    })
    return []
  })
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function translateSessionUpdate(
  update: SessionUpdate,
  ctx: TranslatorContext,
): AgentRuntimeEvent[] {
  const kind = update.sessionUpdate

  switch (kind) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const isThought = kind === "agent_thought_chunk"
      const content = (update as { content?: unknown }).content
      const check = checkContentBlock(content)
      if (!check.ok && check.reason !== "unknown_content_block") {
        diagnoseTranslation(ctx.diagnostics, "acp.malformed_content", {
          kind,
          reason: check.reason,
          shape: shape(content),
        })
        return []
      }

      const chunks: AgentRuntimeEvent[] = []
      // messageId tracking for step-start (agent_message_chunk only)
      if (!isThought && "messageId" in update) {
        const newMsgId = (update as { messageId?: string | null }).messageId ?? null
        if (newMsgId !== null && newMsgId !== ctx.state.lastMessageId) {
          chunks.push({ type: "step-start", newMessageId: newMsgId })
          ctx.state.lastMessageId = newMsgId
        }
      }

      const translated = check.ok
        ? translateContentChunk({
          kind,
          content: check.block,
          messageId: "messageId" in update ? update.messageId ?? undefined : undefined,
          state: ctx.state,
        })
        : []
      if (translated.length) {
        chunks.push(...translated)
      } else {
        diagnoseTranslation(ctx.diagnostics, "acp.unknown_content_type", { kind, shape: shape(content), reason: "unknown_content_block" })
      }

      return chunks
    }

    case "user_message_chunk": {
      if (!ctx.preserveUserMessageChunks) return []
      const content = (update as { content?: unknown }).content
      const check = checkContentBlock(content)
      if (!check.ok) {
        diagnoseTranslation(ctx.diagnostics, "acp.malformed_content", {
          kind,
          reason: check.reason,
          shape: shape(content),
        })
        return []
      }
      return [{
        type: "user-message-delta",
        ...("messageId" in update && update.messageId ? { messageId: update.messageId } : {}),
        content: check.block,
      }]
    }

    case "tool_call": {
      const chunks: AgentRuntimeEvent[] = []
      const diagnosticContext = { diagnostics: ctx.diagnostics, toolCallId: update.toolCallId, title: update.title, kind: update.kind }
      const meta = safeMeta(update._meta, diagnosticContext)
      const rawInput = safeRawInput(update.rawInput, diagnosticContext)
      const rawOutput = safeRawOutput(update.rawOutput, diagnosticContext)
      const content = safeContent(update.content, diagnosticContext)
      const locations = safeLocations(update.locations, diagnosticContext)
      const nextStatus = toolStatus(update.status) ?? "running"
      const tool = reduceTool(ctx.state, update.toolCallId, {
        title: update.title,
        kind: update.kind,
        status: nextStatus,
        rawInput,
        rawOutput,
        content,
        locations,
        meta,
      }, ctx.diagnostics)
      const next = viewToolWithDiagnostics(tool, ctx.diagnostics)
      const classification = classifyToolCall(next, ctx.diagnostics)
      if (update.status !== undefined && (isSessionSurface(classification) || (nextStatus !== "completed" && nextStatus !== "failed"))) {
        chunks.push({ type: "tool-status", toolCallId: update.toolCallId, status: nextStatus, display: next.display, metadata: next.metadata })
      }

      // Session-surface routing: emit session events instead of tool rows
      if (isSessionSurface(classification)) {
        // Standard ACP `think` tools do not create a tool row; thinking
        // content arrives through `agent_thought_chunk`.
        chunks.push(...drainContent(tool, content, ctx.diagnostics))
        chunks.push(...drainSpots(tool, locations))
        return chunks
      }

      chunks.push(projectToolStart(
        update.toolCallId,
        next,
        tool.kind ?? undefined,
      ))
      if (emitInput("start", next.input, rawInput, update.title, update.kind, content)) {
        chunks.push({ type: "tool-input", toolCallId: update.toolCallId, input: next.input, display: next.display, metadata: next.metadata })
      }
      chunks.push(...drainContent(tool, content, ctx.diagnostics))
      chunks.push(...drainSpots(tool, locations))
      if (nextStatus === "completed") {
        const attachments = contentBlockImages(tool.content.flatMap((item) => item.type === "content" ? [item.content] : []))
        chunks.push({ type: "tool-output", toolCallId: update.toolCallId, output: tool.rawOutput ?? content ?? null,
          ...(attachments.length ? { attachments } : {}), display: next.display, metadata: next.metadata })
      } else if (nextStatus === "failed") {
        chunks.push({ type: "tool-error", toolCallId: update.toolCallId, error: errorText(tool.rawOutput), display: next.display, metadata: next.metadata })
      }
      return chunks
    }

    case "tool_call_update": {
      const { toolCallId, status, rawInput, rawOutput, content, locations } = update
      const title = update.title ?? undefined
      const kind = update.kind ?? undefined
      const diagnosticContext = { diagnostics: ctx.diagnostics, toolCallId, title, kind }
      const meta = safeMeta(update._meta, diagnosticContext)
      const safeInput = safeRawInput(rawInput, diagnosticContext)
      const safeOutput = safeRawOutput(rawOutput, diagnosticContext)
      const safeItems = safeContent(content, diagnosticContext)
      const safeSpots = safeLocations(locations, diagnosticContext)
      const nextStatus = toolStatus(status) ?? "pending"
      const tool = reduceTool(ctx.state, toolCallId, {
        title,
        kind,
        status: nextStatus,
        rawInput: safeInput,
        rawOutput: safeOutput,
        content: safeItems,
        locations: safeSpots,
        meta,
      }, ctx.diagnostics)
      const next = viewToolWithDiagnostics(tool, ctx.diagnostics)
      const classification = classifyToolCall(next, ctx.diagnostics)
      const statusChunks: AgentRuntimeEvent[] = (isSessionSurface(classification) || (status !== "completed" && status !== "failed")) && (hasOwn(update, "status") || hasUsefulToolUpdate({
        rawInput,
        rawOutput,
        content: safeItems,
        locations: safeSpots,
        title,
        kind,
        meta,
      }))
        ? [{ type: "tool-status", toolCallId, status: nextStatus, display: next.display, metadata: next.metadata }]
        : []

      // Session-surface routing: emit session events instead of tool rows
      if (isSessionSurface(classification)) {
        const chunks: AgentRuntimeEvent[] = [...statusChunks]
        chunks.push(...drainContent(tool, safeItems, ctx.diagnostics))
        chunks.push(...drainSpots(tool, safeSpots))
        return chunks
      }

      if (status === "completed") {
        const output = safeOutput != null ? safeOutput : (tool.rawOutput ?? safeItems ?? null)
        const chunks: AgentRuntimeEvent[] = [...statusChunks]
        if (emitInput("completed", next.input, safeInput, title, kind, safeItems)) {
          chunks.push({ type: "tool-input", toolCallId, input: next.input, display: next.display, metadata: next.metadata })
        }
        chunks.push(...drainContent(tool, safeItems, ctx.diagnostics))
        chunks.push(...drainSpots(tool, safeSpots))
        const attachments = contentBlockImages(tool.content.flatMap((item) => item.type === "content" ? [item.content] : []))
        chunks.push({ type: "tool-output", toolCallId, output, ...(attachments.length ? { attachments } : {}), display: next.display, metadata: next.metadata })
        return chunks
      }

      if (status === "failed") {
        const chunks: AgentRuntimeEvent[] = [...statusChunks]
        if (emitInput("completed", next.input, safeInput, title, kind, safeItems)) {
          chunks.push({ type: "tool-input", toolCallId, input: next.input, display: next.display, metadata: next.metadata })
        }
        const error = errorText(tool.rawOutput)
        if (!error && safeOutput !== undefined && safeOutput !== null) {
          diagnoseTranslation(ctx.diagnostics, "acp.empty_error_extraction", {
            toolCallId,
            title: title ?? undefined,
            kind,
            shape: shape(safeOutput),
            reason: "payload_without_error_text",
          })
        }
        chunks.push({
          type: "tool-error",
          toolCallId,
          error: error || (safeOutput !== undefined && safeOutput !== null ? jsonText({ raw: safeOutput }) : ""),
          display: next.display,
          metadata: next.metadata,
        })
        chunks.push(...drainContent(tool, safeItems, ctx.diagnostics))
        chunks.push(...drainSpots(tool, safeSpots))
        return chunks
      }

      if (status === "in_progress") {
        const chunks: AgentRuntimeEvent[] = [...statusChunks]
        if (emitInput("in_progress", next.input, safeInput, title, kind, safeItems)) {
          chunks.push({ type: "tool-input", toolCallId, input: next.input, display: next.display, metadata: next.metadata })
        }
        chunks.push(...drainContent(tool, safeItems, ctx.diagnostics))
        chunks.push(...drainSpots(tool, safeSpots))
        return chunks
      }

      return [
        ...statusChunks,
        ...drainContent(tool, safeItems, ctx.diagnostics),
        ...drainSpots(tool, safeSpots),
      ]
    }

    case "plan": {
      const todos = safePlanEntries((update as { entries?: unknown }).entries, ctx.diagnostics)
      if (todos.length === 0) return []
      return [{ type: "todo-update", todos }]
    }

    case "plan_update": {
      const plan = asRecord(update.plan)
      if (plan?.type === "items") {
        const todos = safePlanEntries(plan.entries, ctx.diagnostics)
        if (todos.length === 0) return []
        return [{ type: "todo-update", todos }]
      }
      diagnoseTranslation(ctx.diagnostics, "acp.dropped_content", {
        reason: "unsupported_plan_update_content",
        shape: shape(update.plan),
      })
      return []
    }

    case "plan_removed": {
      diagnoseTranslation(ctx.diagnostics, "acp.dropped_content", {
        reason: "unsupported_plan_removed",
        shape: shape(update),
      })
      return []
    }

    case "available_commands_update": {
      return [{
        type: "available-commands-update",
        commands: Array.isArray(update.availableCommands) ? update.availableCommands : [],
      }]
    }

    case "current_mode_update": {
      return [{ type: "session-agent", agentId: update.currentModeId }]
    }

    case "config_option_update": {
      const options = decodeConfigOptions((update as { configOptions?: unknown }).configOptions, ctx.diagnostics)
      return options.length ? [{ type: "config-update", options }] : []
    }

    case "session_info_update": {
      return [{
        type: "session-info",
        ...(hasOwn(update, "title") ? { title: update.title ?? null } : {}),
        ...(hasOwn(update, "updatedAt") ? { updatedAt: update.updatedAt ?? null } : {}),
      }]
    }

    case "usage_update": {
      const chunk: AgentRuntimeEvent = {
        type: "usage",
        contextSize: update.size,
        contextUsed: update.used,
      }
      if (update.cost) {
        return [{ ...chunk, cost: { amount: update.cost.amount, currency: update.cost.currency } }]
      }
      return [chunk]
    }

    default: {
      const _: never = update // compile error if SDK adds unhandled variant
      diagnoseTranslation(ctx.diagnostics, "acp.dropped_content", { reason: "unknown_session_update", shape: shape(update) })
      return []
    }
  }
}

export const translateAcpSessionUpdate = translateSessionUpdate

export function translateStopReason(
  stopReason: StopReason,
  sessionId: string,
  diagnostics = createAcpDiagnostics(),
): AgentRuntimeEvent[] {
  switch (stopReason) {
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
      return [
        { type: "session-status", status: "idle" },
        { type: "finish", sessionId },
      ]
    case "cancelled":
      return [{ type: "session-status", status: "idle" }]
    case "refusal":
      return [
        { type: "session-status", status: "error" },
        { type: "error", error: "Request refused by agent" },
      ]
    default: {
      const _: never = stopReason
      diagnoseTranslation(diagnostics, "acp.dropped_content", { reason: "unknown_stop_reason", shape: shape(stopReason) })
      return [{ type: "session-status", status: "idle" }, { type: "finish", sessionId }]
    }
  }
}
