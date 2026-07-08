/**
 * Layer 1: ACP SessionUpdate → AgentRuntimeEvent[]
 *
 * Pure function — no async, no Node imports, no side effects.
 * Exhaustiveness is enforced by `const _: never = update` in the default case.
 */

import type {
  AvailableCommand,
  SessionUpdate,
  ToolCallContent,
  StopReason,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionConfigSelectGroup,
  ToolKind,
} from "./types"
import type { AgentRuntimeEvent, RuntimeToolStatus } from "../../contracts/agent-runtime-event"
import { createAcpTranslatorState, drainContent, drainSpots, reduceTool, viewToolWithDiagnostics, type SessionState } from "./state"
import { acpMode, classifyToolCall, isSessionSurface, projectToolStart } from "./classify-tool"
import { createAcpDiagnostics, diagnoseTranslation, shape, type AcpDiagnostics } from "./diagnostics"
import { safeContent, safeLocations, safeMeta, safeRawInput, safeRawOutput } from "./validation"

export type { SessionUpdate }

export interface TranslatorContext {
  state: SessionState
  diagnostics: AcpDiagnostics
  preserveUserMessageChunks?: boolean
}

export function createTranslatorContext(client?: string): TranslatorContext {
  return { state: createAcpTranslatorState(client), diagnostics: createAcpDiagnostics() }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when rawInput contains at least one key — i.e. is usable structured data.
 * Rejects empty objects sent as placeholders (common in claude-agent-acp).
 */
function hasStructuredInput(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && raw !== undefined && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw as object).length > 0
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

function text(value: unknown) {
  if (typeof value !== "string") return
  if (!value) return
  return value
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function toolStatus(status: unknown): RuntimeToolStatus | undefined {
  if (status === "pending") return "pending"
  if (status === "in_progress") return "running"
  if (status === "completed") return "completed"
  if (status === "failed") return "failed"
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

function errorText(value: unknown, metadata?: Record<string, unknown>) {
  const direct = text(value)
  if (direct) return direct

  const row = object(value)
  const rowText = [text(row?.stderr), text(row?.stdout)].filter((item): item is string => !!item).join("\n")
  const fromRow =
    (rowText || undefined) ??
    text(row?.message) ??
    text(row?.text) ??
    text(row?.content)
  if (fromRow) return fromRow

  const acp = object(metadata?.acp)
  const raw = object(acp?.rawOutput)
  const rawText = [text(raw?.stderr), text(raw?.stdout)].filter((item): item is string => !!item).join("\n")
  const fromMeta =
    (rawText || undefined) ??
    text(raw?.message) ??
    text(raw?.text) ??
    text(raw?.content)
  if (fromMeta) return fromMeta

  if (row || raw || value !== undefined && value !== null) {
    try {
      return JSON.stringify(value ?? raw)
    } catch {
      return String(value ?? raw)
    }
  }
  return ""
}

function translateContentChunk(input: {
  kind: "agent_message_chunk" | "agent_thought_chunk"
  content: Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" }>["content"]
}): AgentRuntimeEvent[] {
  const isThought = input.kind === "agent_thought_chunk"
  if (input.content.type === "text") {
    return [isThought
      ? { type: "thinking-delta", delta: input.content.text }
      : { type: "text-delta", delta: input.content.text }]
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

function flattenSelectOptions(
  options: SessionConfigSelectOption[] | SessionConfigSelectGroup[],
): Array<{ id: string; name: string }> {
  if (options.length === 0) return []
  // Detect if first element is a group (has `group` property) or an option (has `value`)
  const first = options[0] as Record<string, unknown>
  if ("group" in first) {
    // Array<SessionConfigSelectGroup>
    const groups = options as SessionConfigSelectGroup[]
    return groups.flatMap((g) =>
      g.options.map((o) => ({ id: o.value as string, name: o.name })),
    )
  }
  // Array<SessionConfigSelectOption>
  return (options as SessionConfigSelectOption[]).map((o) => ({
    id: o.value as string,
    name: o.name,
  }))
}

function mapConfigOptions(
  configOptions: SessionConfigOption[],
): AgentRuntimeEvent & { type: "config-update" } {
  const options = configOptions.map((opt) => {
    if (opt.type === "select") {
      const rawOpts = opt.options ?? []
      const selectOptions = flattenSelectOptions(
        rawOpts as SessionConfigSelectOption[] | SessionConfigSelectGroup[],
      )
      return {
        id: opt.id as string,
        name: opt.name,
        category: opt.category ?? undefined,
        type: "select" as const,
        currentValue: opt.currentValue as string,
        selectOptions,
      }
    } else {
      return {
        id: opt.id as string,
        name: opt.name,
        category: opt.category ?? undefined,
        type: "boolean" as const,
        currentValue: opt.currentValue as boolean,
      }
    }
  })
  return { type: "config-update", options }
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
    const row = object(item)
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

function safeConfigOptions(value: unknown, diagnostics: AcpDiagnostics): SessionConfigOption[] {
  if (!Array.isArray(value)) {
    diagnoseTranslation(diagnostics, "acp.malformed_config_options", {
      reason: "configOptions_not_array",
      shape: shape(value),
    })
    return []
  }
  return value.flatMap((item) => {
    const row = object(item)
    if (!row || typeof row.id !== "string" || typeof row.name !== "string") {
      diagnoseTranslation(diagnostics, "acp.malformed_config_options", {
        reason: "option_missing_id_or_name",
        shape: shape(item),
      })
      return []
    }
    if (row.type === "select" && typeof row.currentValue === "string") {
      return [row as SessionConfigOption]
    }
    if (row.type === "boolean" && typeof row.currentValue === "boolean") {
      return [row as SessionConfigOption]
    }
    diagnoseTranslation(diagnostics, "acp.malformed_config_options", {
      reason: "option_invalid_type_or_value",
      shape: shape(item),
    })
    return []
  })
}

// ---------------------------------------------------------------------------
// Session-surface helpers
// ---------------------------------------------------------------------------

/**
 * Extract a todo-update event from the tool's accumulated rawInput.
 * Handles Claude TodoWrite ({todos: [...]}) and Cursor UpdateTodos ({todos: [...]}).
 */
function extractTodos(rawInput: Record<string, unknown> | undefined, diagnostics: AcpDiagnostics): AgentRuntimeEvent | undefined {
  if (!rawInput) return
  const items = Array.isArray(rawInput.todos) ? rawInput.todos : []
  if (items.length === 0) return
  const bad = items.find((item) => {
    const row = object(item)
    return row && row.status === "cancelled"
  })
  if (bad) {
    diagnoseTranslation(diagnostics, "acp.dropped_content", {
      reason: "todo_cancelled_status_preserved_as_string",
      shape: shape(bad),
    })
  }
  return {
    type: "todo-update",
    todos: items.map((item, i: number) => {
      const t = object(item) ?? {}
      return ({
      id: String(i),
      description: String(t?.content ?? t?.description ?? ""),
      status: String(t?.status ?? "in_progress"),
      priority: String(t?.priority ?? "medium"),
    })}),
  }
}

/**
 * Extract a question or permission-request event from the tool's rawInput.
 * question: { prompt/question, options? }
 * permission (mode=permission): { reason, scopes? }
 */
function extractQuestion(
  toolCallId: string,
  rawInput: Record<string, unknown> | undefined,
  mode: string | undefined,
): AgentRuntimeEvent | undefined {
  if (!rawInput) return

  // Permission requests (Codex)
  if (mode === "permission") {
    const reason = typeof rawInput.reason === "string" ? rawInput.reason : undefined
    const tool = typeof rawInput.tool === "string" ? rawInput.tool : (reason ?? "permission")
    const scopes = Array.isArray(rawInput.scopes)
      ? rawInput.scopes.filter((s): s is string => typeof s === "string")
      : []
    return {
      type: "permission-request",
      requestId: toolCallId,
      tool,
      paths: scopes,
    }
  }

  // Freeform questions
  const questions = Array.isArray(rawInput.questions)
    ? rawInput.questions.map(object).filter((item): item is Record<string, unknown> => !!item)
    : []
  if (questions.length > 0) {
    return {
      type: "question",
      requestId: toolCallId,
      questions: questions.map((question, i) => {
        const options = Array.isArray(question.options)
          ? question.options.flatMap((option) => {
            if (typeof option === "string") return [option]
            const row = object(option)
            return text(row?.label) ? [text(row?.label)!] : []
          })
          : []
        return {
          text: text(question.prompt) ?? text(question.question) ?? text(question.text) ?? `Question ${i + 1}`,
          ...(options.length ? { options } : {}),
        }
      }),
    }
  }

  const prompt =
    (typeof rawInput.prompt === "string" ? rawInput.prompt : undefined) ??
    (typeof rawInput.question === "string" ? rawInput.question : undefined) ??
    (typeof rawInput.text === "string" ? rawInput.text : undefined)
  if (!prompt) return
  const options = Array.isArray(rawInput.options)
    ? rawInput.options.filter((o): o is string => typeof o === "string")
    : undefined
  return {
    type: "question",
    requestId: toolCallId,
    questions: [{ text: prompt, ...(options?.length ? { options } : {}) }],
  }
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
      const chunks: AgentRuntimeEvent[] = []
      const content = (update as { content?: unknown }).content
      const contentRow = object(content)
      const contentType = contentRow?.type
      if (!contentRow || typeof contentType !== "string") {
        diagnoseTranslation(ctx.diagnostics, "acp.malformed_content", {
          kind,
          reason: "content_missing_type",
          shape: shape(content),
        })
        return []
      }
      if (
        contentType === "text" && typeof contentRow.text !== "string" ||
        contentType === "image" && (typeof contentRow.mimeType !== "string" || typeof contentRow.data !== "string") ||
        contentType === "audio" && (typeof contentRow.mimeType !== "string" || typeof contentRow.data !== "string") ||
        contentType === "resource_link" && (typeof contentRow.uri !== "string" || typeof contentRow.name !== "string") ||
        contentType === "resource" && !object(contentRow.resource)
      ) {
        diagnoseTranslation(ctx.diagnostics, "acp.malformed_content", {
          kind,
          reason: "content_missing_required_fields",
          shape: shape(content),
        })
        return []
      }

      // messageId tracking for step-start (agent_message_chunk only)
      if (!isThought && "messageId" in update) {
        const newMsgId = (update as { messageId?: string | null }).messageId ?? null
        if (newMsgId !== null && newMsgId !== ctx.state.lastMessageId) {
          chunks.push({ type: "step-start", newMessageId: newMsgId })
          ctx.state.lastMessageId = newMsgId
        }
      }

      const typedContent = content as Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" }>["content"]
      const translated = translateContentChunk({ kind, content: typedContent })
      if (translated.length) {
        chunks.push(...translated)
      } else {
        diagnoseTranslation(ctx.diagnostics, "acp.unknown_content_type", { kind, shape: shape(typedContent), reason: "unknown_content_block" })
      }

      return chunks
    }

    case "user_message_chunk": {
      if (!ctx.preserveUserMessageChunks) return []
      const content = (update as { content?: unknown }).content
      const contentRow = object(content)
      const contentType = contentRow?.type
      if (!contentRow || typeof contentType !== "string") {
        diagnoseTranslation(ctx.diagnostics, "acp.malformed_content", {
          kind,
          reason: "content_missing_type",
          shape: shape(content),
        })
        return []
      }
      return [{
        type: "user-message-delta",
        ...("messageId" in update && update.messageId ? { messageId: update.messageId } : {}),
        content: content as Extract<SessionUpdate, { sessionUpdate: "user_message_chunk" }>["content"],
      }]
    }

    case "tool_call": {
      const chunks: AgentRuntimeEvent[] = []
      const diagnosticContext = { diagnostics: ctx.diagnostics, toolCallId: update.toolCallId, title: update.title, kind: update.kind }
      const meta = safeMeta((update as unknown as Record<string, unknown>)._meta, {
        ...diagnosticContext,
      })
      const rawInput = safeRawInput(update.rawInput, diagnosticContext)
      const content = safeContent(update.content, diagnosticContext)
      const locations = safeLocations(update.locations, diagnosticContext)
      const nextStatus = toolStatus(update.status) ?? "running"
      const tool = reduceTool(ctx.state, update.toolCallId, {
        title: update.title,
        kind: update.kind,
        status: nextStatus,
        rawInput,
        content,
        locations,
        meta,
      }, ctx.diagnostics)
      const next = viewToolWithDiagnostics(tool, ctx.diagnostics)
      const classification = classifyToolCall(next, ctx.diagnostics)
      if (update.status !== undefined) {
        chunks.push({ type: "tool-status", toolCallId: update.toolCallId, status: nextStatus, display: next.display, metadata: next.metadata })
      }

      // Session-surface routing: emit session events instead of tool rows
      if (isSessionSurface(classification)) {
        if (classification.kind === "question") {
          const mode = acpMode(next.metadata)
          const q = extractQuestion(update.toolCallId, next.input, mode)
          if (q) chunks.push(q)
        }
        if (classification.kind === "todos") {
          const t = extractTodos(next.input, ctx.diagnostics)
          if (t) chunks.push(t)
        }
        // reasoning: suppress tool row — thinking arrives via agent_thought_chunk
        chunks.push(...drainContent(tool, content, ctx.diagnostics))
        chunks.push(...drainSpots(tool, locations))
        return chunks
      }

      chunks.push(projectToolStart(update.toolCallId, next, tool.kind ?? undefined))
      if (emitInput("start", next.input, rawInput, update.title, update.kind, content)) {
        chunks.push({ type: "tool-input", toolCallId: update.toolCallId, input: next.input, display: next.display, metadata: next.metadata })
      }
      chunks.push(...drainContent(tool, content, ctx.diagnostics))
      chunks.push(...drainSpots(tool, locations))
      return chunks
    }

    case "tool_call_update": {
      const { toolCallId, status, rawInput, rawOutput, content, locations, title, kind } = update as typeof update & { title?: string; kind?: ToolKind }
      const diagnosticContext = { diagnostics: ctx.diagnostics, toolCallId, title: title ?? undefined, kind }
      const meta = safeMeta((update as unknown as Record<string, unknown>)._meta, diagnosticContext)
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
      const statusChunks: AgentRuntimeEvent[] = hasOwn(update, "status") || hasUsefulToolUpdate({
        rawInput,
        rawOutput,
        content: safeItems,
        locations: safeSpots,
        title,
        kind,
        meta,
      })
        ? [{ type: "tool-status", toolCallId, status: nextStatus, display: next.display, metadata: next.metadata }]
        : []

      // Session-surface routing: emit session events instead of tool rows
      if (isSessionSurface(classification)) {
        const chunks: AgentRuntimeEvent[] = [...statusChunks]
        if (classification.kind === "todos" && (status === "completed" || status === "in_progress")) {
          const t = extractTodos(next.input, ctx.diagnostics)
          if (t) chunks.push(t)
        }
        // question: already emitted on tool_call start; updates are no-ops
        // reasoning: suppress tool row
        chunks.push(...drainContent(tool, safeItems, ctx.diagnostics))
        chunks.push(...drainSpots(tool, safeSpots))
        return chunks
      }

      if (status === "completed") {
        const acp = object(next.metadata.acp)
        const output = safeOutput != null ? safeOutput : (acp?.rawOutput ?? safeItems ?? null)
        const chunks: AgentRuntimeEvent[] = [...statusChunks]
        if (emitInput("completed", next.input, safeInput, title, kind, safeItems)) {
          chunks.push({ type: "tool-input", toolCallId, input: next.input, display: next.display, metadata: next.metadata })
        }
        chunks.push({ type: "tool-output", toolCallId, output, display: next.display, metadata: next.metadata })
        chunks.push(...drainContent(tool, safeItems, ctx.diagnostics))
        chunks.push(...drainSpots(tool, safeSpots))
        return chunks
      }

      if (status === "failed") {
        const chunks: AgentRuntimeEvent[] = [...statusChunks]
        if (emitInput("completed", next.input, safeInput, title, kind, safeItems)) {
          chunks.push({ type: "tool-input", toolCallId, input: next.input, display: next.display, metadata: next.metadata })
        }
        const error = errorText(safeOutput, next.metadata)
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
          error: error || (safeOutput !== undefined && safeOutput !== null ? JSON.stringify({ raw: safeOutput }) : ""),
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
      const plan = object(update.plan)
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
        commands: Array.isArray(update.availableCommands) ? update.availableCommands as AvailableCommand[] : [],
      }]
    }

    case "current_mode_update": {
      return [{ type: "session-agent", agentId: update.currentModeId }]
    }

    case "config_option_update": {
      const options = safeConfigOptions((update as { configOptions?: unknown }).configOptions, ctx.diagnostics)
      return options.length ? [mapConfigOptions(options)] : []
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
